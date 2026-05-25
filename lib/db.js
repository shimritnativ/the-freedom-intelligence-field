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
    SELECT id, role, content, created_at
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
// Server-derived day for system prompt selection
// ============================================================================

/**
 * Return the day number the AI should run today for this user.
 *
 * Logic:
 *   - If preview_ends_at has passed and tier is still preview, return null
 *     (the 72H window is closed; caller should show the expired UI).
 *   - Otherwise return current_day (which is computed from last_completed_day).
 *   - Full-tier users get day 3's prompt by default for now. Full-tier prompt
 *     is a separate phase; tracked in proposals.
 */
export function resolveActiveDay(user) {
  if (!user) return null;
  if (user.tier === "preview") {
    if (user.preview_ends_at && new Date(user.preview_ends_at) < new Date()) {
      return null; // expired
    }
    return user.current_day; // 1, 2, or 3
  }
  if (user.tier === "full") {
    return 3; // placeholder — full-tier prompt will replace this later
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
export async function grantEntitlement({ email, tier, kajabiMemberId }) {
  const now = new Date();
  const ends = new Date(now.getTime() + 72 * 60 * 60 * 1000);
  const { rows } = await sql`
    INSERT INTO users (email, kajabi_member_id, tier, kajabi_entitled,
                       preview_started_at, preview_ends_at)
    VALUES (${String(email).toLowerCase().trim()}, ${kajabiMemberId || null},
            ${tier}::user_tier, true, ${now.toISOString()}, ${ends.toISOString()})
    ON CONFLICT (email) DO UPDATE SET
      tier = CASE WHEN EXCLUDED.tier = 'full' THEN 'full'
                  WHEN users.tier = 'full' THEN 'full'
                  ELSE EXCLUDED.tier END,
      kajabi_entitled = true,
      kajabi_member_id = COALESCE(EXCLUDED.kajabi_member_id, users.kajabi_member_id),
      updated_at = NOW()
    RETURNING *
  `;
  return rows[0];
}

/**
 * Revoke a member's entitlement (offer deactivation / refund). The account and
 * its conversation history are kept; the member simply can no longer log in.
 */
export async function revokeEntitlementByEmail(email) {
  const { rows } = await sql`
    UPDATE users SET kajabi_entitled = false, updated_at = NOW()
    WHERE email = ${String(email).toLowerCase().trim()}
    RETURNING *
  `;
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
