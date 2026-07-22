// api/free-trial/message.js
//
// The core turn of the "Free Preview of The Field". Takes a user message, checks
// the trial is still valid (not expired, not over the 6-exchange budget),
// calls Claude with the mini-Field prompt, saves both sides, returns the
// assistant's reply plus how many exchanges are left.
//
// POST /api/free-trial/message
// Body: { trial_id, content }
// Returns: { reply, exchanges_remaining, is_final, reset_link? }

import { sql } from "@vercel/postgres";
import {
  FREE_TRIAL_SYSTEM_PROMPT,
  FREE_TRIAL_MAX_EXCHANGES,
  buildTurnContext,
} from "../../lib/prompts/free-trial.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 800;         // preview replies stay short — one insight per turn
const MAX_USER_LEN = 3000;
// Ads-funnel ThriveCart URL — sends preview visitors straight to checkout
// so attribution stays clean and there's no extra LP hop.
const RESET_LINK = "https://masteryourpath.thrivecart.com/power-reset-ads";
const MAX_RETRY = 3;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const trialId = String(body.trial_id || "").trim();
  const userContent = String(body.content || "").trim().slice(0, MAX_USER_LEN);
  if (!trialId) return res.status(400).json({ error: "trial_id_required" });
  if (!userContent) return res.status(400).json({ error: "content_required" });

  try {
    // ── Load trial + validate state
    const { rows: trials } = await sql`
      SELECT id, scenario, exchange_count, max_exchanges, expires_at, ended_at
      FROM free_trials WHERE id = ${trialId}::uuid LIMIT 1
    `;
    if (trials.length === 0) return res.status(404).json({ error: "trial_not_found" });
    const trial = trials[0];
    if (trial.ended_at) {
      return res.status(410).json({ error: "trial_ended", reset_link: RESET_LINK });
    }
    if (trial.expires_at && new Date(trial.expires_at).getTime() < Date.now()) {
      await sql`
        UPDATE free_trials SET ended_at = NOW(), outcome = 'expired' WHERE id = ${trialId}::uuid
      `;
      return res.status(410).json({ error: "trial_expired", reset_link: RESET_LINK });
    }
    if (trial.exchange_count >= trial.max_exchanges) {
      return res.status(410).json({ error: "trial_completed", reset_link: RESET_LINK });
    }

    const nextExchange = trial.exchange_count + 1;
    const total = trial.max_exchanges || FREE_TRIAL_MAX_EXCHANGES;
    const isFinal = nextExchange >= total;

    // ── Save the user's message first (so if Anthropic errors, we still have it)
    await sql`
      INSERT INTO free_trial_messages (trial_id, role, content, exchange_number)
      VALUES (${trialId}::uuid, 'user', ${userContent}, ${nextExchange})
    `;

    // ── Reload full conversation history for Claude
    const { rows: msgs } = await sql`
      SELECT role, content
      FROM free_trial_messages
      WHERE trial_id = ${trialId}::uuid
      ORDER BY created_at ASC
    `;

    // ── Build the turn context (exchange marker + scenario)
    const turnContext = buildTurnContext({
      exchangeNumber: nextExchange,
      totalExchanges: total,
      scenarioId: trial.scenario,
      resetLink: RESET_LINK,
    });

    // Anthropic expects strict user/assistant alternation. Our first row
    // is the assistant's opening; if the person's first user message is
    // there we're fine. We append a synthetic "system-in-user" turn to
    // inject the exchange marker without polluting the conversation
    // itself — done by prepending the marker to the LAST user message.
    const messages = msgs.map((m) => ({ role: m.role, content: m.content }));
    if (messages.length && messages[messages.length - 1].role === "user") {
      messages[messages.length - 1] = {
        role: "user",
        content: `${turnContext}\n\n---\n\n${messages[messages.length - 1].content}`,
      };
    }

    // ── Call Claude
    let anthropicResult;
    try {
      anthropicResult = await callAnthropicWithRetry({
        systemPrompt: FREE_TRIAL_SYSTEM_PROMPT,
        messages,
      });
    } catch (e) {
      console.error("free_trial_anthropic_failed", e);
      return res.status(502).json({ error: "ai_unavailable", message: "The Field is briefly quiet. Try again in a moment." });
    }

    const reply =
      (anthropicResult.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim();
    const inputTokens = anthropicResult.usage?.input_tokens || null;
    const outputTokens = anthropicResult.usage?.output_tokens || null;

    if (!reply) {
      return res.status(502).json({ error: "empty_ai_reply" });
    }

    // ── Save assistant reply, advance exchange count, mark ended if final
    await sql`
      INSERT INTO free_trial_messages (
        trial_id, role, content, exchange_number, tokens_in, tokens_out
      ) VALUES (
        ${trialId}::uuid, 'assistant', ${reply}, ${nextExchange}, ${inputTokens}, ${outputTokens}
      )
    `;

    await sql`
      UPDATE free_trials
      SET exchange_count = ${nextExchange},
          ended_at = CASE WHEN ${isFinal} THEN NOW() ELSE ended_at END,
          outcome  = CASE WHEN ${isFinal} THEN 'completed' ELSE outcome END,
          last_activity_at = NOW()
      WHERE id = ${trialId}::uuid
    `;

    return res.status(200).json({
      ok: true,
      reply,
      exchange_number: nextExchange,
      exchanges_remaining: Math.max(0, total - nextExchange),
      is_final: isFinal,
      reset_link: isFinal ? RESET_LINK : null,
    });
  } catch (e) {
    console.error("free_trial_message_failed", e);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
}

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
          temperature: 0.7,
          system: systemPrompt,
          messages,
        }),
      });
      if (response.ok) return await response.json();
      if (response.status >= 400 && response.status < 500) {
        const body = await response.text().catch(() => "");
        throw new Error(`anthropic_${response.status}: ${body.slice(0, 200)}`);
      }
      lastErr = new Error(`anthropic_${response.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250 * Math.pow(3, attempt)));
  }
  throw lastErr;
}
