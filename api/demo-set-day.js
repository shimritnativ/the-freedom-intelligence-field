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

// Welcome message shown as the Field's first message when the user enters
// or switches to each day. Matches the Scenario B (freeform) opening in the
// day system prompts: it directs the participant to their library for the
// day's prompt. The [[button:...]] token renders as an in-brand CTA button
// in the interface.
const DAY_OPENINGS = {
  1: `Welcome to Day 1 of your 72 Hour Power Reset.

The Reset moves through a precise sequence, and each day opens with its own prompt. That prompt is what calibrates the process and gives you the full experience.

[[button:Access Your Prompts|https://www.shimritnativ.com/products/the-freedom-intelligence-field]]

Open your Day 1 prompt, paste it here, and we begin.`,
  2: `Welcome to Day 2 of your 72 Hour Power Reset.

The Reset moves through a precise sequence, and each day opens with its own prompt. That prompt is what calibrates the process and gives you the full experience.

[[button:Access Your Prompts|https://www.shimritnativ.com/products/the-freedom-intelligence-field]]

Open your Day 2 prompt, paste it here, and we begin.`,
  3: `Welcome to Day 3 of your 72 Hour Power Reset.

The Reset moves through a precise sequence, and each day opens with its own prompt. That prompt is what calibrates the process and gives you the full experience.

[[button:Access Your Prompts|https://www.shimritnativ.com/products/the-freedom-intelligence-field]]

Open your Day 3 prompt, paste it here, and we begin.`
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

    const session = await getOrCreateSession(user.id);

    // Each day is its own conversation thread. Messages are tagged with
    // day_at_send so we can filter by day. Check whether this user has
    // any messages for the target day yet — if not, insert the canonical
    // welcome as the opening assistant message for that day.
    const { rows: existing } = await sql`
      SELECT id FROM messages
      WHERE user_id = ${user.id} AND day_at_send = ${targetDay}
      LIMIT 1
    `;

    if (existing.length === 0) {
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
    }

    // Return ALL messages for this user + day so the frontend can render
    // the day's conversation history when the user switches in.
    const { rows: dayMessages } = await sql`
      SELECT id, role, content, created_at
      FROM messages
      WHERE user_id = ${user.id}
        AND day_at_send = ${targetDay}
        AND role IN ('user', 'assistant')
      ORDER BY created_at ASC
    `;

    return res.status(200).json({
      currentDay: rows[0]?.current_day,
      lastCompletedDay: rows[0]?.last_completed_day,
      pitchEligible: rows[0]?.pitch_eligible,
      messages: dayMessages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    console.error("demo_set_day_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
