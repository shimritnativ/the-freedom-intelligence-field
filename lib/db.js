// lib/db.js
// Thin Postgres client wrapper. Uses @vercel/postgres which auto-reads
// DATABASE_URL (or POSTGRES_URL) from environment variables.
//
// All functions here are async. They throw on DB errors — let callers handle.

import { sql } from "@vercel/postgres";
import crypto from "node:crypto";

// ============================================================================
// User identity
// ============================================================================

/**
 * Find a user by their session token. The session token is a server-issued
 * opaque string stored in the user's browser. v1 implementation: the session
 * token is just the user's id, signed with SESSION_SECRET (HMAC).
 * Once Kajabi auth is figured out (ambiguity #6), this becomes a proper JWT
 * verification step instead.
 *
 * Returns the user row, or null if the token is invalid/expired/unknown.
 */
export async function getUserBySessionToken(token) {
  if (!token || typeof token !== "string") return null;

  const userId = verifySessionToken(token);
  if (!userId) return null;

  const { rows } = await sql`
    SELECT * FROM users WHERE id = ${userId} LIMIT 1
  `;
  return rows[0] || null;
}

/**
 * Create a session token for a given user id. Format:
 *   base64url(userId) + "." + hmacSha256(userId, SESSION_SECRET)
 * Stateless. No DB lookup to validate the signature.
 */
export function issueSessionToken(userId) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET not configured");

  const payload = Buffer.from(userId).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(userId)
    .digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Verify a session token. Returns the user id if valid, null otherwise.
 */
function verifySessionToken(token) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;

  let userId;
  try {
    userId = Buffer.from(payload, "base64url").toString("utf-8");
  } catch {
    return null;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(userId)
    .digest("base64url");

  // Constant-time comparison to prevent timing attacks.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  // Validate the userId is a UUID shape.
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  return userId;
}

// ============================================================================
// User creation (v1 — minimal, used until ThriveCart webhook handler exists)
// ============================================================================

/**
 * Create a preview-tier user with the 72-hour window starting now.
 * Returns the new user row plus a session token to give to the client.
 *
 * In v1, this is called from a /api/start endpoint when a user lands on the
 * Kajabi page (post-purchase). Eventually this happens server-side from the
 * ThriveCart purchase.completed webhook instead.
 */
export async function createPreviewUser({ email, displayName, kajabiMemberId, thrivecartCustomerId }) {
  const now = new Date();
  const ends = new Date(now.getTime() + 72 * 60 * 60 * 1000);

  const { rows } = await sql`
    INSERT INTO users (
      email, display_name, kajabi_member_id, thrivecart_customer_id,
      tier, preview_started_at, preview_ends_at
    ) VALUES (
      ${email}, ${displayName || null}, ${kajabiMemberId || null}, ${thrivecartCustomerId || null},
      'preview', ${now.toISOString()}, ${ends.toISOString()}
    )
    ON CONFLICT (email) DO UPDATE SET
      kajabi_member_id = COALESCE(EXCLUDED.kajabi_member_id, users.kajabi_member_id),
      thrivecart_customer_id = COALESCE(EXCLUDED.thrivecart_customer_id, users.thrivecart_customer_id),
      updated_at = NOW()
    RETURNING *
  `;
  return rows[0];
}

// ============================================================================
// Sessions
// ============================================================================

/**
 * Get or create the user's primary session. v1 = single session per user.
 */
export async function getOrCreateSession(userId) {
  const existing = await sql`
    SELECT * FROM sessions
    WHERE user_id = ${userId}
    ORDER BY started_at ASC
    LIMIT 1
  `;
  if (existing.rows[0]) return existing.rows[0];

  const { rows } = await sql`
    INSERT INTO sessions (user_id)
    VALUES (${userId})
    RETURNING *
  `;
  return rows[0];
}

// ============================================================================
// Messages
// ============================================================================

/**
 * Fetch the message history for a session, oldest first. Used to build the
 * messages array for the Anthropic API.
 */
export async function fetchConversation(sessionId, { limit = 200 } = {}) {
  const { rows } = await sql`
    SELECT id, role, content, day_at_send, created_at
    FROM messages
    WHERE session_id = ${sessionId} AND role IN ('user', 'assistant')
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
  return rows;
}

/**
 * Insert a message. Returns the inserted row.
 */
export async function insertMessage({
  sessionId,
  userId,
  role,
  content,
  model,
  inputTokens,
  outputTokens,
  stopReason,
  tierAtSend,
  dayAtSend,
  systemPromptVersion,
  systemPromptHash,
}) {
  const { rows } = await sql`
    INSERT INTO messages (
      session_id, user_id, role, content, model,
      input_tokens, output_tokens, stop_reason,
      tier_at_send, day_at_send,
      system_prompt_version, system_prompt_hash
    ) VALUES (
      ${sessionId}, ${userId}, ${role}, ${content}, ${model || null},
      ${inputTokens || null}, ${outputTokens || null}, ${stopReason || null},
      ${tierAtSend || null}, ${dayAtSend || null},
      ${systemPromptVersion || null}, ${systemPromptHash || null}
    )
    RETURNING *
  `;

  // Denormalized: bump session.last_message_at.
  await sql`
    UPDATE sessions SET last_message_at = NOW() WHERE id = ${sessionId}
  `;

  return rows[0];
}

// ============================================================================
// Day completions
// ============================================================================

/**
 * Record a day completion and atomically advance the user's day pointer.
 * Returns the day_completions row.
 *
 * Idempotent: if a row already exists for (user_id, day), this is a no-op
 * and the existing row is returned.
 */
export async function recordDayCompletion({
  userId,
  sessionId,
  day,
  variant,
  branchesUsed,
  data,
  schemaVersion,
  messageId,
}) {
  // Use a CTE to insert + update users in one round trip.
  const { rows } = await sql`
    WITH inserted AS (
      INSERT INTO day_completions (
        user_id, session_id, day, variant, branches_used, data, schema_version, message_id
      ) VALUES (
        ${userId}, ${sessionId}, ${day}, ${variant || null},
        ${branchesUsed || []}, ${JSON.stringify(data)}::jsonb, ${schemaVersion},
        ${messageId || null}
      )
      ON CONFLICT (user_id, day) DO NOTHING
      RETURNING *
    ),
    advanced AS (
      UPDATE users
      SET last_completed_day = GREATEST(last_completed_day, ${day}),
          pitch_eligible = (last_completed_day >= 3 OR ${day} = 3),
          updated_at = NOW()
      WHERE id = ${userId}
        AND EXISTS (SELECT 1 FROM inserted)
      RETURNING id
    )
    SELECT * FROM inserted
    UNION ALL
    SELECT * FROM day_completions WHERE user_id = ${userId} AND day = ${day}
    LIMIT 1
  `;
  return rows[0];
}

// ============================================================================
// Day unlock — progressive access for the 72-Hour Power Reset
// ============================================================================
//
// Schedule (4-day window from first login):
//   Day 1: unlocks at first_login_at
//   Day 2: unlocks at first_login_at + 24h
//   Day 3: unlocks at first_login_at + 48h
//   Window expires: first_login_at + 96h
//
// first_login_at is set the first time a member successfully verifies a login
// code (see recordFirstLogin). Until first login it's NULL — and we treat
// unlocks as "not yet started", returning null timestamps.

/**
 * The Date when a given day unlocks, or null if the day is already unlocked
 * (Day 1 always, or pre-first-login when there is no clock yet).
 */
export function dayUnlockAt(user, dayNum) {
  if (dayNum <= 1) return null;
  if (!user || !user.first_login_at) return null;
  const base = new Date(user.first_login_at).getTime();
  return new Date(base + (dayNum - 1) * 24 * 60 * 60 * 1000);
}

/** True if `dayNum` is currently accessible for this user. */
export function isDayUnlocked(user, dayNum) {
  const at = dayUnlockAt(user, dayNum);
  if (!at) return true;
  return at.getTime() <= Date.now();
}

/** The highest day currently unlocked (1, 2, or 3) for this user. */
export function highestUnlockedDay(user) {
  if (isDayUnlocked(user, 3)) return 3;
  if (isDayUnlocked(user, 2)) return 2;
  return 1;
}

/**
 * Build the per-day unlock map the client uses to render lock state and
 * live countdowns. Day 1 is always null (unlocked). Day 2 / 3 are ISO
 * strings until the moment they unlock, then null forever after.
 */
export function buildDayUnlocks(user) {
  return {
    1: null,
    2: isDayUnlocked(user, 2) ? null : dayUnlockAt(user, 2).toISOString(),
    3: isDayUnlocked(user, 3) ? null : dayUnlockAt(user, 3).toISOString(),
  };
}

// ============================================================================
// Server-derived day for system prompt selection
// ============================================================================

/**
 * Return the day number the AI should run today for this user.
 *
 * Logic:
 *   - If preview_ends_at has passed and tier is still preview, return null
 *     (the window is closed; caller should show the expired UI).
 *   - For preview tier: return min(current_day, highestUnlockedDay) — i.e.
 *     cap the user's day at the highest progressively-unlocked day. This
 *     handles the edge case where someone finishes Day 1 in an hour
 *     (current_day = 2) but Day 2 has not unlocked yet — they're still on
 *     Day 1.
 *   - For full tier: return the actual current_day. Full-tier members have
 *     no time-based unlock cap (they paid for full access) and can revisit
 *     any of the three Reset days freely. current_day tracks whichever day
 *     they most recently switched into via /api/demo-set-day. Capped at 3
 *     defensively, since there are only three Reset days.
 *   - This fix replaced the previous hardcoded "return 3" for full-tier,
 *     which was a placeholder. The hardcode caused a state-sync bug where
 *     a full-tier member would click Day 1 in the sidebar, see the Day 1
 *     opening, paste the Day 1 prompt — and have the top bar snap back to
 *     Day 3 the moment any API response landed (chat reply or page reload),
 *     because every API path returned currentDay: 3 for full-tier users
 *     regardless of which day they had actually chosen.
 */
export function resolveActiveDay(user) {
  if (!user) return null;
  if (user.tier === "preview") {
    if (user.preview_ends_at && new Date(user.preview_ends_at) < new Date()) {
      return null; // expired
    }
    const cap = highestUnlockedDay(user);
    return Math.min(user.current_day || 1, cap);
  }
  if (user.tier === "full") {
    return Math.min(user.current_day || 1, 3);
  }
  return null;
}

// ============================================================================
// Time remaining
// ============================================================================

export function timeRemainingMs(user) {
  if (!user || !user.preview_ends_at) return 0;
  const remaining = new Date(user.preview_ends_at).getTime() - Date.now();
  return Math.max(0, remaining);
}

// ============================================================================
// First-login bookkeeping (start the 4-day clock)
// ============================================================================

/**
 * Set first_login_at = NOW (only if currently null) and, for preview-tier
 * users who have never logged in before, reset preview_ends_at to NOW + 96h.
 * This is what makes the 4-day window start at first login rather than at
 * purchase. Idempotent: subsequent logins do not modify first_login_at or
 * preview_ends_at.
 *
 * Returns the updated user row.
 */
export async function recordFirstLogin(userId) {
  const { rows } = await sql`
    UPDATE users
       SET first_login_at = COALESCE(first_login_at, NOW()),
           preview_ends_at = CASE
             WHEN first_login_at IS NULL AND tier = 'preview'
               THEN NOW() + INTERVAL '96 hours'
             ELSE preview_ends_at
           END,
           updated_at = NOW()
     WHERE id = ${userId}
     RETURNING *
  `;
  return rows[0] || null;
}

// ============================================================================
// Hash helper (used by api/chat.js to record system_prompt_hash)
// ============================================================================

export function hashSystemPrompt(prompt) {
  return crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

// ============================================================================
// Passwordless email login (6-digit codes) + Kajabi entitlement
// ============================================================================

/**
 * Find an entitled Kajabi member by email. Returns the user row, or null.
 * "Entitled" means the Kajabi offer webhook has marked this account a real
 * member (kajabi_entitled = true). Anonymous demo accounts are never entitled,
 * so they cannot log in through the email-code flow.
 */
export async function findEntitledMemberByEmail(email) {
  if (!email) return null;
  const { rows } = await sql`
    SELECT * FROM users
    WHERE email = ${String(email).toLowerCase().trim()}
      AND kajabi_entitled = true
    LIMIT 1
  `;
  return rows[0] || null;
}

/**
 * Store a hashed login code for an email. Expires after ttlMinutes.
 */
export async function createLoginCode(email, codeHash, ttlMinutes = 10) {
  const expires = new Date(Date.now() + ttlMinutes * 60 * 1000);
  await sql`
    INSERT INTO login_codes (email, code_hash, expires_at)
    VALUES (${String(email).toLowerCase().trim()}, ${codeHash}, ${expires.toISOString()})
  `;
}

/**
 * How many codes were issued for an email in the last windowMinutes — used to
 * rate-limit request-code so an inbox cannot be spammed.
 */
export async function countRecentLoginCodes(email, windowMinutes = 15) {
  const { rows } = await sql`
    SELECT COUNT(*)::int AS n FROM login_codes
    WHERE email = ${String(email).toLowerCase().trim()}
      AND created_at > NOW() - make_interval(mins => ${windowMinutes})
  `;
  return rows[0] ? rows[0].n : 0;
}

/**
 * The most recent unconsumed, unexpired login code for an email, or null.
 */
export async function getActiveLoginCode(email) {
  const { rows } = await sql`
    SELECT * FROM login_codes
    WHERE email = ${String(email).toLowerCase().trim()}
      AND consumed_at IS NULL
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

/** Mark a login code consumed so it cannot be reused. */
export async function consumeLoginCode(id) {
  await sql`UPDATE login_codes SET consumed_at = NOW() WHERE id = ${id}`;
}

/** Increment the wrong-attempt counter on a login code. */
export async function incrementLoginCodeAttempts(id) {
  await sql`UPDATE login_codes SET attempts = attempts + 1 WHERE id = ${id}`;
}

/**
 * Grant (or upgrade) a member's entitlement from a Kajabi offer webhook.
 * 'full' is sticky — a later 'preview' grant never downgrades an Unlimited
 * member. The 72-hour preview window is set only on first insert.
 */
export async function grantEntitlement({ email, tier, kajabiMemberId, subscriptionPlan }) {
  const now = new Date();
  const ends = new Date(now.getTime() + 72 * 60 * 60 * 1000);
  // subscription_plan is 'monthly' | 'yearly' | null. Coerced to null for
  // anything else so a bad query string can't poison the column.
  const plan = (subscriptionPlan === "monthly" || subscriptionPlan === "yearly")
    ? subscriptionPlan
    : null;
  const { rows } = await sql`
    INSERT INTO users (email, kajabi_member_id, tier, kajabi_entitled,
                       preview_started_at, preview_ends_at, subscription_plan)
    VALUES (${String(email).toLowerCase().trim()}, ${kajabiMemberId || null},
            ${tier}::user_tier, true, ${now.toISOString()}, ${ends.toISOString()},
            ${plan})
    ON CONFLICT (email) DO UPDATE SET
      tier = CASE WHEN EXCLUDED.tier = 'full' THEN 'full'
                  WHEN users.tier = 'full' THEN 'full'
                  ELSE EXCLUDED.tier END,
      kajabi_entitled = true,
      kajabi_member_id = COALESCE(EXCLUDED.kajabi_member_id, users.kajabi_member_id),
      -- Only overwrite subscription_plan if the new grant carries one. A
      -- subsequent bonus-offer activation that doesn't pass &plan= won't wipe
      -- the plan we set from the main purchase webhook.
      subscription_plan = COALESCE(EXCLUDED.subscription_plan, users.subscription_plan),
      updated_at = NOW()
    RETURNING *
  `;
  return rows[0];
}

/**
 * Revoke a member's entitlement (offer deactivation / refund / cancellation).
 *
 * The account and conversation history are kept so the member can still
 * download their work; only chat access is locked. To achieve the lockout we
 * have to do three things, not one:
 *
 *   1. Flip kajabi_entitled to false (marks them as no-longer-a-member)
 *   2. Drop tier back to "preview" (otherwise tier=full still bypasses the
 *      window check in resolveActiveDay, so Days 1-3 chat would stay open)
 *   3. Force preview_ends_at into the past (so the Reset chat returns 410
 *      immediately and the expired-state UI we built kicks in)
 *
 * After this, /api/chat returns 410 on next message and /api/unlimited/chat
 * returns 403, and app.html shows the gold "your window has ended" banner
 * with the Upgrade button. Export Your Conversations still works.
 */
export async function revokeEntitlementByEmail(email) {
  const normalizedEmail = String(email).toLowerCase().trim();

  // Race-condition guard: when a customer upgrades from monthly to yearly,
  // ThriveCart's "Cancel another product's subscriptions" feature fires a
  // cancellation event for the monthly product some time after the yearly
  // purchase grant lands. Observed gap is up to ~15 minutes (presumably
  // ThriveCart's billing reconciliation queue). Without this guard, the
  // cancellation Zap would call us with revoke=1 and downgrade a customer
  // who just paid for yearly access.
  //
  // The check: if there is an activate:full webhook event for this email
  // within the last 30 minutes, skip the revoke. The activation already won;
  // the user has a fresh paid grant. A real cancellation outside the upgrade
  // window will not have a recent activation event, so it still goes through.
  //
  // Why 30 minutes: one real-world observation showed a 14-minute gap. We
  // double it for safety, then round to a clean number. Tradeoff: if a
  // customer somehow buys then cancels within 30 minutes of their own free
  // will, the cancellation is ignored. That edge case is acceptable, since
  // they can re-trigger the cancellation later and it will go through then.
  const { rows: recentGrants } = await sql`
    SELECT 1
      FROM webhook_events
     WHERE payload::text ILIKE ${"%" + normalizedEmail + "%"}
       AND event_type = 'activate:full'
       AND processed_at > NOW() - INTERVAL '30 minutes'
     LIMIT 1
  `;
  if (recentGrants.length > 0) {
    console.log("revoke_skipped_recent_grant", { email: normalizedEmail });
    return null;
  }

  const { rows } = await sql`
    UPDATE users
       SET kajabi_entitled = false,
           tier = 'preview',
           preview_ends_at = NOW() - INTERVAL '1 minute',
           updated_at = NOW()
     WHERE email = ${normalizedEmail}
     RETURNING *
  `;
  if (rows[0]) {
    console.log("entitlement_revoked", { email: normalizedEmail, userId: rows[0].id });
  } else {
    console.warn("entitlement_revoke_no_user", { email: normalizedEmail });
  }
  return rows[0] || null;
}

/**
 * Append a row to the inbound-webhook log. Append-only and replayable.
 */
export async function recordWebhookEvent({
  source, eventType, externalId, payload, signatureVerified, userId, processingError,
}) {
  const { rows } = await sql`
    INSERT INTO webhook_events (
      source, event_type, external_id, payload,
      signature_verified, processed_at, processing_error, user_id
    ) VALUES (
      ${source}, ${eventType}, ${externalId || null},
      ${JSON.stringify(payload || {})}::jsonb,
      ${!!signatureVerified}, NOW(), ${processingError || null}, ${userId || null}
    )
    ON CONFLICT (source, external_id) DO NOTHING
    RETURNING *
  `;
  return rows[0] || null;
}
