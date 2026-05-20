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

const MODEL = "claude-haiku-4-5-20251001"; // bump to claude-haiku-4-5-20251001 once tested
const MAX_TOKENS = 800;
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
    const history = await fetchConversation(session.id);
    const systemPrompt = getSystemPromptForDay(day);
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
    const messagesForAnthropic = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: message.trim() },
    ];

    // ----- Call Anthropic with retries -----
    const result = await callAnthropicWithRetry({
      systemPrompt,
      messages: messagesForAnthropic,
    });

    // ----- Persist assistant message -----
    const replyText = result.content[0]?.text || "";
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
