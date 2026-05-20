// api/unlimited/chat.js
// The Unlimited chat endpoint. Loads conversation history, retrieves the most
// relevant brain chunks for the participant's current message, optionally
// includes their prior Reset outputs as participant context, and asks Claude
// to respond in Shimrit's voice.
//
// Auto-generates a chat title on the first exchange and saves it to the
// session record. Subsequent turns reuse the existing title.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";
import { getUnlimitedSystemPrompt, PROMPT_VERSION } from "../../lib/prompts/index.js";
import {
  retrieveChunks,
  formatRetrievedContext,
  formatParticipantContext,
} from "../../lib/brain/retrieval.js";

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const MAX_MESSAGES_IN_CONTEXT = 20;

// Extend timeout: retrieval + embedding + Claude call can together take
// 10-20 seconds on first message. Default 10s would time out.
export const config = {
  maxDuration: 60,
};

function applyCors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!origin && process.env.NODE_ENV !== "production") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
}

// Fetch the participant's prior Reset outputs from day_completions so the AI
// can reference their state-reset, decision, and declaration when relevant.
async function loadResetContext(userId) {
  try {
    const { rows } = await sql`
      SELECT day, data
      FROM day_completions
      WHERE user_id = ${userId}
      ORDER BY day ASC
    `;
    const ctx = {};
    for (const row of rows) {
      if (row.day === 1) ctx.day1 = row.data;
      else if (row.day === 2) ctx.day2 = row.data;
      else if (row.day === 3) ctx.day3 = row.data;
    }
    return ctx;
  } catch (e) {
    console.warn("loadResetContext_error", e?.message);
    return {};
  }
}

// Auto-generate a short title for the chat from the first user message.
// Falls back to a generic title if the LLM call fails.
async function generateChatTitle(firstUserMessage, apiKey) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 30,
        messages: [
          {
            role: "user",
            content: `Generate a short title (4-7 words, no quotes, no period) summarizing this opening message from a coaching chat. Just the title text, nothing else.\n\nMessage: ${firstUserMessage.slice(0, 500)}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.content?.[0]?.text?.trim();
    if (!text) return null;
    // Strip quotes if the model added them.
    return text.replace(/^["']|["']$/g, "").slice(0, 80);
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const token = req.headers["x-session-token"];
    const user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      console.error("unlimited_chat_no_anthropic_key");
      return res.status(500).json({ error: "ai_unavailable" });
    }

    const { sessionId, message } = req.body || {};
    if (!sessionId || !message || typeof message !== "string") {
      return res.status(400).json({ error: "missing_fields" });
    }
    const userMessage = message.trim();
    if (!userMessage) return res.status(400).json({ error: "empty_message" });

    // Verify the session belongs to this user.
    const { rows: sessionRows } = await sql`
      SELECT id, title, metadata
      FROM sessions
      WHERE id = ${sessionId}
        AND user_id = ${user.id}
        AND session_type = 'unlimited'
      LIMIT 1
    `;
    if (sessionRows.length === 0) {
      return res.status(404).json({ error: "session_not_found" });
    }
    const session = sessionRows[0];

    // Load recent conversation history.
    const { rows: priorMessages } = await sql`
      SELECT role, content, created_at
      FROM messages
      WHERE session_id = ${sessionId}
      ORDER BY created_at ASC
    `;
    const isFirstMessage = priorMessages.length === 0;

    // Persist the user's new message.
    await sql`
      INSERT INTO messages (session_id, user_id, role, content, system_prompt_version)
      VALUES (${sessionId}, ${user.id}, 'user', ${userMessage}, ${PROMPT_VERSION})
    `;

    // Retrieve the most relevant brain chunks for the current message.
    let retrievedChunks = [];
    try {
      retrievedChunks = await retrieveChunks(userMessage, { topK: 8 });
    } catch (e) {
      console.warn("retrieval_failed_continuing_without", e?.message);
    }

    // Load the participant's prior Reset work (if any).
    const resetContext = await loadResetContext(user.id);

    // Build the system prompt = base Unlimited prompt + participant context
    // + retrieved context.
    const baseSystem = getUnlimitedSystemPrompt();
    const participantBlock = formatParticipantContext(resetContext);
    const retrievedBlock = formatRetrievedContext(retrievedChunks);
    const systemPrompt = `${baseSystem}\n\n---\n\n${participantBlock}\n\n---\n\n${retrievedBlock}`;

    // Build the message array for Claude. Use last MAX_MESSAGES_IN_CONTEXT
    // turns to keep context tight.
    const recentPrior = priorMessages.slice(-MAX_MESSAGES_IN_CONTEXT);
    const messages = recentPrior.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));
    messages.push({ role: "user", content: userMessage });

    // Call Claude.
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text().catch(() => "");
      console.error("unlimited_chat_claude_error", {
        status: claudeRes.status,
        body: errText.slice(0, 300),
      });
      return res.status(502).json({ error: "ai_call_failed" });
    }

    const claudeData = await claudeRes.json();
    const reply = claudeData?.content?.[0]?.text?.trim();
    if (!reply) {
      console.error("unlimited_chat_empty_reply", claudeData);
      return res.status(502).json({ error: "ai_empty_reply" });
    }

    // Persist the assistant reply.
    await sql`
      INSERT INTO messages (session_id, user_id, role, content, model, system_prompt_version)
      VALUES (${sessionId}, ${user.id}, 'assistant', ${reply}, ${ANTHROPIC_MODEL}, ${PROMPT_VERSION})
    `;

    // Bump the session's last_message_at so it sorts to the top of the list.
    await sql`
      UPDATE sessions SET last_message_at = NOW() WHERE id = ${sessionId}
    `;

    // If this was the first exchange, generate and save a title.
    let updatedTitle = session.title;
    if (isFirstMessage) {
      const title = await generateChatTitle(userMessage, anthropicKey);
      if (title) {
        await sql`UPDATE sessions SET title = ${title} WHERE id = ${sessionId}`;
        updatedTitle = title;
      }
    }

    return res.status(200).json({
      reply,
      title: updatedTitle,
      retrievedSources: retrievedChunks.map((c) => ({
        title: c.title,
        category: c.category,
        similarity: Number(c.similarity).toFixed(3),
      })),
    });
  } catch (err) {
    console.error("unlimited_chat_error", { message: err?.message, stack: err?.stack });
    return res.status(500).json({ error: "internal_error" });
  }
}
