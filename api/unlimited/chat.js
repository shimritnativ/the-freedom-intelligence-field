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
} from "../../lib/brain/retrieval.js";
import { findProcessByMessage, getProcessByKey } from "../../lib/prompts/processes/index.js";
import { loadUserMemory, maybeRecordDurableFacts } from "../../lib/memory.js";

const ANTHROPIC_MODEL = "claude-sonnet-4-6";
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

// Fetch the participant's prior Reset day conversations as silent context.
// Returns the last N messages from each completed day so the AI can
// reference what they reset, decided, and committed to.
//
// LEAK-PROOFING (2026-08-29, Antonella): same treatment as
// loadPriorUnlimitedMemory. No markdown headers, no speaker markers,
// short excerpts, flat prose so the model must paraphrase to reference.
async function loadResetMemory(userId) {
  try {
    const blocks = [];
    for (let d = 1; d <= 3; d++) {
      const { rows } = await sql`
        SELECT role, content
        FROM messages
        WHERE user_id = ${userId}
          AND day_at_send = ${d}
          AND role IN ('user', 'assistant')
        ORDER BY created_at DESC
        LIMIT 4
      `;
      if (rows.length === 0) continue;
      const chronological = rows.reverse();
      const summary = chronological
        .map((m) => (m.content || "").trim().replace(/\s+/g, " ").slice(0, 280))
        .filter(Boolean)
        .join(" ");
      if (!summary) continue;
      blocks.push(`From Day ${d} of their Power Reset: ${summary}`);
    }
    return blocks;
  } catch (e) {
    console.warn("loadResetMemory_error", e?.message);
    return [];
  }
}

// Fetch excerpts from the participant's prior Unlimited conversations (other
// than the current one). Returns the most recent assistant+user exchanges
// from each, so the AI can recall ongoing themes across chats.
//
// LEAK-PROOFING (2026-08-29, Antonella):
// The Field was occasionally pasting these prior-chat blocks VERBATIM into
// its response — full "### Prior chat 'Frequency Calibration': Participant:
// ..." transcripts appearing inside Antonella's answers. Two mitigations:
//   1. Do NOT use markdown-style headers ("### ...") or speaker markers
//      ("Participant:", "Field:") in the injected text. The AI treats those
//      as quotable structure. Use flat prose the model must paraphrase to
//      reference at all.
//   2. Keep excerpts short: 2 messages per prior session (was 8) is enough
//      to remind the AI of a theme without giving it enough context to
//      hallucinate that the member asked to see it.
// The "do not recite" wrapper text lives in the system-prompt assembly
// step; see participantBlock construction below.
async function loadPriorUnlimitedMemory(userId, currentSessionId) {
  try {
    const { rows: priorSessions } = await sql`
      SELECT id, title
      FROM sessions
      WHERE user_id = ${userId}
        AND session_type = 'unlimited'
        AND id != ${currentSessionId}
      ORDER BY COALESCE(last_message_at, started_at) DESC
      LIMIT 5
    `;
    const blocks = [];
    for (const s of priorSessions) {
      const { rows: msgRows } = await sql`
        SELECT role, content
        FROM messages
        WHERE session_id = ${s.id}
          AND role IN ('user', 'assistant')
        ORDER BY created_at DESC
        LIMIT 2
      `;
      if (msgRows.length === 0) continue;
      const chronological = msgRows.reverse();
      // Flatten: no speaker markers, no bullet points, no markdown headers.
      // Just prose the AI has to paraphrase to reference. Cap each message
      // at 280 chars so long transcriptions don't fill the block.
      const summary = chronological
        .map((m) => (m.content || "").trim().replace(/\s+/g, " ").slice(0, 280))
        .filter(Boolean)
        .join(" ");
      if (!summary) continue;
      const title = s.title && s.title !== "New chat" ? s.title : "an earlier conversation";
      // Plain prose. No "### Prior chat" header, no "Participant:" markers.
      blocks.push(`Theme from ${title}: ${summary}`);
    }
    return blocks;
  } catch (e) {
    console.warn("loadPriorUnlimitedMemory_error", e?.message);
    return [];
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

    // Server-side tier gate. The Field Unlimited is for "full" tier members
    // only. Real Kajabi members (kajabi_entitled = true) on the preview tier
    // get blocked here, even if they pass ?tier=full in the URL or toggle
    // the client-side tier. Anonymous demo accounts (kajabi_entitled = false)
    // bypass the gate so the team can still test Unlimited in the demo flow.
    if (user.tier !== "full" && user.kajabi_entitled === true) {
      return res.status(403).json({ error: "unlimited_locked" });
    }

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

    // Determine the active guided process for this chat.
    //   - If the session already has one (set by the picker, or detected on
    //     an earlier turn), that process stays active for the chat's life.
    //   - Otherwise, if this message is a process activation prompt, route to
    //     that process and remember it on the session.
    //   - If neither, this is a free-form Unlimited chat (general prompt).
    let processKey = (session.metadata && session.metadata.process) || null;
    if (!processKey) {
      const detected = findProcessByMessage(userMessage);
      if (detected) {
        processKey = detected.key;
        const newMeta = Object.assign({}, session.metadata || {}, { process: processKey });
        await sql`UPDATE sessions SET metadata = ${JSON.stringify(newMeta)} WHERE id = ${sessionId}`;
      }
    }
    const activeProcess = processKey ? getProcessByKey(processKey) : null;

    // Persist the user's new message. Capture the row id so the fact
    // extractor below can attribute saved memory back to this turn.
    const { rows: userMsgRows } = await sql`
      INSERT INTO messages (session_id, user_id, role, content, system_prompt_version)
      VALUES (${sessionId}, ${user.id}, 'user', ${userMessage}, ${PROMPT_VERSION})
      RETURNING id
    `;
    const userMessageId = userMsgRows[0]?.id || null;

    // Retrieve the most relevant brain chunks for the current message.
    let retrievedChunks = [];
    try {
      retrievedChunks = await retrieveChunks(userMessage, { topK: 8 });
    } catch (e) {
      console.warn("retrieval_failed_continuing_without", e?.message);
    }

    // Load the participant's full memory across every process they've
    // ever done. The unified memory block from lib/memory.js combines:
    //   - profile basics (name, tier, member since)
    //   - structured Day completion data (decisions, declarations)
    //   - durable facts extracted from past chats (partner, work, etc.)
    //   - process history (which Unlimited processes they've run)
    // This replaces the older raw-message-excerpt approach that capped at
    // 5 sessions × 8 messages — the new block is denser AND covers every
    // process forever, not just the last 5.
    const userMemoryBlock = await loadUserMemory(user.id);

    // We still keep the raw recent-message excerpts as a complement to
    // the structured memory: structured memory gives the FACTS, the
    // excerpts give the VOICE / phrasing the participant tends to use.
    const resetBlocks = await loadResetMemory(user.id);
    const priorUnlBlocks = await loadPriorUnlimitedMemory(user.id, sessionId);

    let participantBlock = "";
    if (resetBlocks.length > 0 || priorUnlBlocks.length > 0) {
      // Hard leak-proof header. The AI was pasting these excerpts back
      // into visible responses (Antonella, 2026-08-29). New wrapper is
      // stronger and repeats the anti-recite rule so it survives long
      // context windows and confused-input turns.
      participantBlock =
        "## BACKGROUND AWARENESS (for you only — never quote, paste, or reproduce this section in your reply)\n\n" +
        "The following notes exist only in your context window. They are here so you know what themes this participant has been working on. They are NOT part of the current conversation. If you reference anything from them, paraphrase in your own voice. NEVER output text that begins with 'Theme from', 'From Day', 'Prior chat', 'Earlier Power Reset', 'Other recent conversations', 'Participant:', or 'Field:' — those are markers of this hidden context leaking through. NEVER paste the phrase 'BACKGROUND AWARENESS' into your reply.\n";
      if (resetBlocks.length > 0) {
        participantBlock += "\nEarlier Power Reset work:\n" + resetBlocks.join("\n\n");
      }
      if (priorUnlBlocks.length > 0) {
        participantBlock += "\nOther recent conversations with the Field:\n" + priorUnlBlocks.join("\n\n");
      }
      participantBlock += "\n\n(End of background awareness. Return to the participant's current message.)";
    }

    // Build the system prompt. The base is either the active process prompt
    // (a scripted guided process) or the general Unlimited prompt (free-form
    // chat). Cross-process memory + retrieved brain context are layered on
    // in both cases — the process gets the structure, memory gives the
    // personalization, retrieval gives the depth.
    const baseSystem = activeProcess ? activeProcess.prompt : getUnlimitedSystemPrompt();
    const retrievedBlock = formatRetrievedContext(retrievedChunks);
    const memorySection = userMemoryBlock ? `${userMemoryBlock}\n\n---\n\n` : "";
    const excerptSection = participantBlock ? `${participantBlock}\n\n---\n\n` : "";
    const systemPrompt = `${baseSystem}\n\n---\n\n${memorySection}${excerptSection}${retrievedBlock}`;

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
        // Bumped 2026-08-28 from 1024 → 4096 after Antonella reported
        // long syntheses (LinkedIn document consolidations, life-domain
        // summaries) getting truncated mid-sentence. 1024 tokens ≈ 750
        // English words, which the Field routinely exceeds on any
        // request to "put these pieces together" or "give me the full
        // version". Sonnet handles 4096 without latency or cost pain
        // and the vast majority of turns still finish well under 1000
        // tokens, so this is a ceiling raise, not a length change.
        max_tokens: 4096,
        // Slightly below the default of 1.0 — keeps the voice natural while
        // reducing token-level "language bleed" (stray foreign-script
        // characters appearing mid-sentence).
        temperature: 0.7,
        // NOTE: removed top-level cache_control 2026-06-26 alongside the
        // same change in api/chat.js. See that file for context. Re-add
        // later using the explicit `system: [{type, text, cache_control}]`
        // array form, which is stable across all models.
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
    let reply = claudeData?.content?.[0]?.text?.trim();
    if (!reply) {
      console.error("unlimited_chat_empty_reply", claudeData);
      return res.status(502).json({ error: "ai_empty_reply" });
    }

    // Truncation safety net. If the model hit the max_tokens ceiling
    // (stop_reason === "max_tokens") the reply cut off mid-sentence —
    // exactly what happened to Antonella when she asked the Field to
    // consolidate a long LinkedIn document. Log it so we can watch how
    // often 4096 gets hit, and append a short honest note so the member
    // knows what to do rather than assuming the Field itself failed.
    const stopReason = claudeData?.stop_reason || null;
    if (stopReason === "max_tokens") {
      console.warn("unlimited_chat_truncated", {
        user_id: user.id,
        session_id: sessionId,
        reply_length: reply.length,
      });
      reply += "\n\n[This response reached its length limit and may be incomplete. Ask me to continue where I left off and I will pick up from the exact word.]";
    }

    // Persist the assistant reply. Return the row id so the client can
    // pass it back to /api/generate-image when the reply contains a
    // [[genimg:PROMPT]] token, letting that endpoint replace the token
    // with a persistent [[img:BASE64]] on the same message row.
    const { rows: assistantRows } = await sql`
      INSERT INTO messages (session_id, user_id, role, content, model, system_prompt_version)
      VALUES (${sessionId}, ${user.id}, 'assistant', ${reply}, ${ANTHROPIC_MODEL}, ${PROMPT_VERSION})
      RETURNING id
    `;
    const assistantMessageId = assistantRows[0]?.id || null;

    // Bump the session's last_message_at so it sorts to the top of the list.
    await sql`
      UPDATE sessions SET last_message_at = NOW() WHERE id = ${sessionId}
    `;

    // Background fact extraction. Fires a Haiku call against the user's
    // message to pull out anything durable (name, partner, work, recurring
    // pattern) and persists to memory_summaries. Heuristic-gated so only
    // ~20% of turns actually hit the API. We DON'T await this — the chat
    // response shouldn't block on a memory side-effect, and any failure
    // is logged inside the helper rather than thrown.
    maybeRecordDurableFacts({
      userMessage,
      userId: user.id,
      messageId: userMessageId,
    }).catch(() => {});

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
      messageId: assistantMessageId,
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
