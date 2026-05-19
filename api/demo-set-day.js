// api/demo-set-day.js
// Demo-only endpoint: lets a tester set their last_completed_day so they can
// jump between Day 1, Day 2, and Day 3 prompts without waiting 24h between
// each. Gated by env var DEMO_MODE_ENABLED. Returns 404 in production unless
// the env var is set to "true".
//
// In addition to setting the day, this endpoint persists the canonical
// opening message for the chosen day as an assistant message so the AI's
// next reply has the right context.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken, getOrCreateSession, insertMessage } from "../lib/db.js";
import { PROMPT_VERSION } from "../lib/prompts/index.js";

// Canonical welcome text shown as the AI's first message when the user
// enters or switches to each day. Short and inviting — the structured
// teaching lives in the system prompt itself. The participant pastes
// their day prompt from the Kajabi PDF (or just shares what's present)
// and the Field responds using the day-specific methodology.
const DAY_OPENINGS = {
  1: `Welcome to the Freedom Intelligence Field — Day 1: State Reset.

Drop your prompt and I'll guide you through a powerful process, or just tell me what's on your mind.`,
  2: `Welcome to the Freedom Intelligence Field — Day 2: Decision.

Drop your prompt below and let's begin!`,
  3: `Welcome to the Freedom Intelligence Field — Day 3: Action.

Drop your prompt below for your last day of the 72-Hour Power Reset!`
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

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Hard gate: this endpoint does not exist unless explicitly enabled.
  if (process.env.DEMO_MODE_ENABLED !== "true") {
    return res.status(404).json({ error: "not_found" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const token = req.headers["x-session-token"];
    const user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const { day } = req.body || {};
    const targetDay = Number(day);
    if (![1, 2, 3].includes(targetDay)) {
      return res.status(400).json({ error: "invalid_day" });
    }

    // last_completed_day = targetDay - 1 means current_day will be targetDay.
    const lastCompleted = targetDay - 1;

    const { rows } = await sql`
      UPDATE users
      SET last_completed_day = ${lastCompleted},
          pitch_eligible = ${targetDay >= 3},
          updated_at = NOW()
      WHERE id = ${user.id}
      RETURNING current_day, last_completed_day, pitch_eligible
    `;

    // Persist the canonical opening for this day as an assistant message so
    // the next chat turn sees it in context.
    const session = await getOrCreateSession(user.id);
    const opening = DAY_OPENINGS[targetDay];
    await insertMessage({
      sessionId: session.id,
      userId: user.id,
      role: "assistant",
      content: opening,
      tierAtSend: user.tier,
      dayAtSend: targetDay,
      systemPromptVersion: PROMPT_VERSION + "-demo-opening",
    });

    return res.status(200).json({
      currentDay: rows[0]?.current_day,
      lastCompletedDay: rows[0]?.last_completed_day,
      pitchEligible: rows[0]?.pitch_eligible,
      opening,
    });
  } catch (err) {
    console.error("demo_set_day_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
