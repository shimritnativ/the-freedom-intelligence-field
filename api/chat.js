// api/chat.js
// Hardened chat endpoint for The Freedom Intelligence Field.
//
// Key differences from the prior version:
//   - dayNumber is NOT taken from request body. Day is server-derived from
//     the user's current_day in Postgres.
//   - CORS is locked to ALLOWED_ORIGINS (env-configurable).
//   - User identity comes from a signed session token (x-session-token
//     header), not from "whoever can reach the URL".
//   - Conversation history is fetched from Postgres, not the request body.
//     The client only sends the new user message; the backend reconstructs.
//   - Messages are persisted (user message + assistant reply) so history
//     survives device switches and crosses the paywall.
//   - Retries on Anthropic 5xx with exponential backoff.
//   - No internal error details leak to the client.
//   - Basic rate limiting via DB row count.

import { sql } from "@vercel/postgres";
import { getSystemPromptForDay, PROMPT_VERSION } from "../lib/prompts/index.js";
import {
  getUserBySessionToken,
  getOrCreateSession,
  fetchConversation,
  insertMessage,
  resolveActiveDay,
  timeRemainingMs,
  hashSystemPrompt,
} from "../lib/db.js";
import { maybeRecordDayCompletion } from "../lib/dayExtraction.js";
import { loadUserMemory, maybeRecordDurableFacts } from "../lib/memory.js";
import { sendGhlEventInBackground } from "../lib/ghlWebhook.js";

// ============================================================================
// Constants
// ============================================================================

const MODEL = "claude-sonnet-4-6";
// The Day 2 / Day 3 final outputs are long — the full structured summary,
// the commitment-statement instruction, the continuation invitation, and the
// CTA button token. 800 truncated them mid-output (the button token got cut
// off). 3000 gives the longest final output ample room.
const MAX_TOKENS = 3000;
const MAX_USER_MESSAGE_LEN = 4000;
const MAX_MESSAGES_PER_15MIN = 30;
const MAX_RETRY = 3;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Extend serverless function timeout. Default Vercel Hobby = 10s, which
// trips the first Claude response when the system prompt is long. 60s
// gives plenty of headroom; the Anthropic call itself rarely takes >15s.
export const config = {
  maxDuration: 60,
};

// ============================================================================
// CORS
// ============================================================================

function applyCors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin;

  // If origin not in allowlist, do not set the CORS header at all — the
  // browser will block the response. Server-to-server requests with no
  // Origin header are allowed through (for testing).
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!origin && process.env.NODE_ENV !== "production") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-session-token"
  );
}

// ============================================================================
// Handler
// ============================================================================

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    // ----- Auth -----
    const token = req.headers["x-session-token"];
    const user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    // ----- Validate body -----
    const { message } = req.body || {};
    if (
      !message ||
      typeof message !== "string" ||
      message.trim().length === 0
    ) {
      return res.status(400).json({ error: "missing_message" });
    }
    if (message.length > MAX_USER_MESSAGE_LEN) {
      return res.status(400).json({ error: "message_too_long" });
    }

    // ----- Resolve day server-side -----
    const day = resolveActiveDay(user);
    if (day === null) {
      // 72H window closed. Frontend should show the expired/upgrade view.
      return res.status(410).json({
        error: "reset_expired",
        message: "The 72-Hour Power Reset is complete.",
      });
    }

    // ----- Rate limit -----
    const overLimit = await checkRateLimit(user.id);
    if (overLimit) {
      return res.status(429).json({ error: "rate_limited" });
    }

    // ----- Build context -----
    const session = await getOrCreateSession(user.id);

    // History sent to Claude is scoped to the CURRENT day only. Each day
    // is its own visible thread; prior days don't pollute the conversation.
    const { rows: history } = await sql`
      SELECT id, role, content, created_at
      FROM messages
      WHERE session_id = ${session.id}
        AND day_at_send = ${day}
        AND role IN ('user', 'assistant')
      ORDER BY created_at ASC
      LIMIT 200
    `;

    // For Day 2 and Day 3, fetch excerpts from prior days as silent context
    // injected into the system prompt. This lets the AI personalize and
    // reference what the participant already worked on — without showing
    // the prior conversation visibly in this day's UI.
    let priorDayContext = "";
    if (day > 1) {
      const priorBlocks = [];
      for (let d = 1; d < day; d++) {
        const { rows: priorRows } = await sql`
          SELECT role, content, created_at
          FROM messages
          WHERE user_id = ${user.id}
            AND day_at_send = ${d}
            AND role IN ('user', 'assistant')
          ORDER BY created_at DESC
          LIMIT 10
        `;
        if (priorRows.length === 0) continue;
        const chronological = priorRows.reverse();
        const formatted = chronological.map((m) => {
          const speaker = m.role === "user" ? "Participant" : "Field";
          return speaker + ": " + m.content;
        }).join("\n\n");
        priorBlocks.push("### Day " + d + " excerpt:\n" + formatted);
      }
      if (priorBlocks.length > 0) {
        priorDayContext =
          "\n\n## PARTICIPANT'S PRIOR DAY WORK IN THIS RESET\n\n" +
          "The participant has already worked through earlier days. Below are excerpts from their prior day conversations so you have context for what they've already named, decided, and committed to. " +
          "Use this context naturally when relevant — reference patterns, decisions, or themes when they connect to the current moment. " +
          "Do NOT re-process prior days. Do NOT recite the prior context back to them verbatim. " +
          "The visible conversation history is filtered to today only; the participant cannot see these excerpts.\n\n" +
          priorBlocks.join("\n\n---\n\n");
      }
    }

    // Full-tier override. The Day 2 and Day 3 prompts close with an
    // upgrade invitation + [[button:Join The Field Unlimited|...]] token
    // aimed at preview-tier customers (the typical 72-Hour Reset journey).
    // For members who already paid for Unlimited and are revisiting the
    // Reset, pitching the upgrade in the closing moment after the Living
    // Power Declaration reads as tone-deaf marketing — they already have
    // what they're being asked to buy. We inject a small override at
    // runtime telling the Field to skip the upgrade invitation and close
    // with a brief acknowledgment that they're already in the Field.
    //
    // The override is intentionally additive (appended at the end of the
    // system prompt) so it takes precedence over the default closing
    // described in the day prompts. The day prompts themselves stay
    // simple and don't need to know about this branching.
    const fullTierOverride = user.tier === "full"
      ? `

## OVERRIDE — FULL-TIER PARTICIPANT

This participant is already a full-tier member of The Freedom Intelligence Field Unlimited. They have full access to the Field beyond the 72-Hour Power Reset.

At the end of the session, after the final Day Record, do NOT include the upgrade invitation paragraph (anything along the lines of "If you already know this is a space you want to keep working with", "the full Freedom Intelligence Field is open for you now", "What you just experienced is a fraction of what lives inside The Unlimited Freedom Intelligence Field", "Click below to learn more", or any other CTA copy aimed at a non-member). Do NOT include any upgrade button at the end of the session — including but not limited to [[button:Join The Field Unlimited|...]] and [[button:Join The Unlimited Freedom Intelligence Field|...]] and any other variant of an "Join / Upgrade / Unlock The Field" button. They already have it.

IMPORTANT: This override does NOT remove the Moving Energy Beyond the Senses Meditation button on Day 3. That button is a meditation reference, not an upgrade pitch, and remains intact for all tiers.

Replace the upgrade invitation and the button with this brief closing instead, on its own line:

"You already know what lives beyond the Reset. Carry the decision, the action, and the declaration into your daily practice in the full Field."

Then close with:

"The session is complete."

This override applies only to the upgrade invitation and button at the end of the session. Everything else in the system prompt remains unchanged.`
      : "";

    // Cross-process memory: same block the Unlimited chat uses, scoped to
    // this user. Includes the structured Day completion data + durable
    // facts extracted from past chats + their full process history. Lets
    // the Field remember who they are across Reset days AND any Unlimited
    // chats they've done since (e.g. a Day 2 re-run reminds the Field
    // about a Decision-Alignment they did last week).
    const userMemoryBlock = await loadUserMemory(user.id);
    const memorySection = userMemoryBlock ? `\n\n---\n\n${userMemoryBlock}` : "";

    const systemPrompt = getSystemPromptForDay(day) + fullTierOverride + memorySection + priorDayContext;
    const systemHash = hashSystemPrompt(systemPrompt);

    // ----- Persist user message FIRST so it never gets lost -----
    // Capture the row id so the durable-fact extractor below can attribute
    // any extracted memory back to this turn.
    const userMessageRow = await insertMessage({
      sessionId: session.id,
      userId: user.id,
      role: "user",
      content: message.trim(),
      tierAtSend: user.tier,
      dayAtSend: day,
      systemPromptVersion: PROMPT_VERSION,
      systemPromptHash: systemHash,
    });

    // Fire day_started GHL event the FIRST time this participant sends
    // a user message on this Reset day. Detected by counting prior user
    // messages on this day — if this one is the only one (count = 1),
    // it's their first. Background-fired so chat reply isn't blocked.
    if (user.tier === "preview" && day && day >= 1 && day <= 3) {
      try {
        const { rows: priorCountRows } = await sql`
          SELECT COUNT(*)::int AS n
          FROM messages
          WHERE user_id = ${user.id}
            AND day_at_send = ${day}
            AND role = 'user'
        `;
        if (Number(priorCountRows[0]?.n || 0) === 1) {
          sendGhlEventInBackground({
            event: "day_started",
            email: user.email,
            data: { day },
          });
        }
      } catch (e) {
        // Don't block on detection failure — the worst case is we
        // miss a single reminder trigger, not a broken chat reply.
        console.warn("day_started_detect_failed", { message: e?.message });
      }
    }

    // ----- Build Anthropic request -----
    // Sanitize the history so the request is always valid for Anthropic:
    //   1. Drop any message with empty/whitespace content — a single empty
    //      content block makes the API reject the whole request.
    //   2. Drop leading non-user messages so the array begins with a user
    //      turn. The demo's day-opening welcome is an assistant message; a
    //      day whose history starts with it would otherwise 400 every turn
    //      ("first message must use the user role"), surfacing as
    //      "internal_error" on every send.
    const cleanHistory = history.filter(
      (m) => m.content && String(m.content).trim().length > 0
    );
    while (cleanHistory.length > 0 && cleanHistory[0].role !== "user") {
      cleanHistory.shift();
    }
    const messagesForAnthropic = [
      ...cleanHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: message.trim() },
    ];

    // ----- Call Anthropic with retries -----
    const result = await callAnthropicWithRetry({
      systemPrompt,
      messages: messagesForAnthropic,
    });

    // ----- Persist assistant message -----
    const replyText = result.content[0]?.text || "";
    // Never store an empty assistant reply — it would poison the day's
    // history and make every subsequent turn fail. Surface a clean error.
    if (!replyText.trim()) {
      console.error("chat_empty_reply", { day, stopReason: result.stop_reason });
      return res.status(502).json({ error: "ai_empty_reply" });
    }
    const assistantRow = await insertMessage({
      sessionId: session.id,
      userId: user.id,
      role: "assistant",
      content: replyText,
      model: MODEL,
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
      stopReason: result.stop_reason,
      tierAtSend: user.tier,
      dayAtSend: day,
      systemPromptVersion: PROMPT_VERSION,
      systemPromptHash: systemHash,
    });

    // ----- Day completion auto-extraction -----
    // If this assistant reply looks like a Day N final output (cheap string
    // check), fire a Haiku call to extract the structured fields and record
    // a day_completions row. Never throws — chat reply always reaches the
    // user. Adds ~1-2s latency ONLY on the final message of a day's session;
    // the heuristic skips every other message for free.
    const completionRow = await maybeRecordDayCompletion({
      assistantMessage: replyText,
      day,
      userId: user.id,
      sessionId: session.id,
      messageId: assistantRow ? assistantRow.id : null,
    });

    // If the auto-detector just recorded a fresh completion, fire the
    // day_completed GHL event so workflows can react. The Complete Day
    // button fires the same event from its own endpoint — either path
    // triggers exactly one event per (user, day) because completionRow
    // is null when the row already existed (ON CONFLICT DO NOTHING).
    if (completionRow && user.tier === "preview") {
      // Also bump last_completed_day so the next-day unlock takes
      // effect immediately. The Complete Day endpoint does the same;
      // here we mirror it for auto-detected completions.
      try {
        await sql`
          UPDATE users
          SET last_completed_day = GREATEST(COALESCE(last_completed_day, 0), ${day}),
              updated_at = NOW()
          WHERE id = ${user.id}
        `;
      } catch (e) {
        console.warn("auto_complete_bump_failed", { message: e?.message });
      }
      sendGhlEventInBackground({
        event: "day_completed",
        email: user.email,
        data: { day, completed_via: "auto_detected" },
      });
    }

    // ----- Durable-fact extraction (cross-process memory) -----
    // Background pass against the user's message to pull out anything
    // durable about them (name, partner, work, recurring pattern). Saved
    // to memory_summaries and reused by loadUserMemory on every future
    // chat turn across every process. Heuristic-gated so most turns skip
    // the API call. Not awaited — chat response doesn't wait on memory.
    maybeRecordDurableFacts({
      userMessage: message.trim(),
      userId: user.id,
      messageId: userMessageRow ? userMessageRow.id : null,
    }).catch(() => {});

    // ----- Return only the new reply + state -----
    return res.status(200).json({
      reply: replyText,
      currentDay: day,
      timeRemainingMs: timeRemainingMs(user),
      tier: user.tier,
    });
  } catch (err) {
    console.error("chat_error", {
      message: err?.message,
      stack: err?.stack,
    });
    return res.status(500).json({ error: "internal_error" });
  }
}

// ============================================================================
// Anthropic call with retry
// ============================================================================

async function callAnthropicWithRetry({ systemPrompt, messages }) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const response = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          // Slightly below the default of 1.0. Keeps Shimrit's voice natural
          // while reducing token-level "language bleed" (stray foreign-script
          // characters appearing mid-sentence).
          temperature: 0.7,
          // NOTE: removed top-level `cache_control` 2026-06-26. Production
          // started 500-erroring after we added automatic caching, which
          // points to Sonnet 4.6 not accepting the top-level form yet (it's
          // a newer Anthropic convenience parameter). When we re-add
          // caching, do it the explicit way: convert `system` into an array
          // of text blocks and put cache_control on the last system block.
          // That form is older and battle-tested on every model. For now,
          // user experience > the 70% cost savings.
          system: systemPrompt,
          messages,
        }),
      });

      if (response.ok) {
        return await response.json();
      }

      // 4xx -> do not retry, surface a clean error.
      if (response.status >= 400 && response.status < 500) {
        const body = await safeJson(response);
        console.error("anthropic_4xx", { status: response.status, body });
        throw new Error(`anthropic_${response.status}`);
      }

      // 5xx -> retry.
      lastErr = new Error(`anthropic_${response.status}`);
    } catch (err) {
      lastErr = err;
    }

    // Exponential backoff: 250ms, 750ms, 2.25s
    const delay = 250 * Math.pow(3, attempt);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw lastErr || new Error("anthropic_unknown_error");
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// ============================================================================
// Rate limiting
// ============================================================================

async function checkRateLimit(userId) {
  const { sql } = await import("@vercel/postgres");
  const { rows } = await sql`
    SELECT COUNT(*)::int AS n
    FROM messages
    WHERE user_id = ${userId}
      AND role = 'user'
      AND created_at > NOW() - INTERVAL '15 minutes'
  `;
  return (rows[0]?.n || 0) >= MAX_MESSAGES_PER_15MIN;
}
