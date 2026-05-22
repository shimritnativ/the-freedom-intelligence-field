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

    const systemPrompt = getSystemPromptForDay(day) + priorDayContext;
    const systemHash = hashSystemPrompt(systemPrompt);

    // ----- Persist user message FIRST so it never gets lost -----
    await insertMessage({
      sessionId: session.id,
      userId: user.id,
      role: "user",
      content: message.trim(),
      tierAtSend: user.tier,
      dayAtSend: day,
      systemPromptVersion: PROMPT_VERSION,
      systemPromptHash: systemHash,
    });

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
    await insertMessage({
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
