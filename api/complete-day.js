// api/complete-day.js
//
// Endpoint hit when the participant clicks the "Complete Day X" button
// at the end of a Reset day's chat. Records the completion (idempotent),
// bumps users.last_completed_day if higher, fires the day_completed
// webhook to GHL so the reminder workflows can react.
//
// Auth: session token (the participant's own login session). They can
// only complete their own days.
//
// POST body:
//   { day: 1 | 2 | 3 }
//
// Returns:
//   { ok: true, last_completed_day, current_day, day_unlocks }

import { sql } from "@vercel/postgres";
import {
  getUserBySessionToken,
  buildDayUnlocks,
  resolveActiveDay,
} from "../lib/db.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const token = req.headers["x-session-token"];
    const user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const day = Number((req.body && req.body.day) || 0);
    if (![1, 2, 3].includes(day)) {
      return res.status(400).json({ error: "invalid_day" });
    }

    // Only relevant for preview-tier (Reset) participants. Unlimited
    // members aren't bound by day gating, so completing days is a no-op.
    if (user.tier !== "preview") {
      return res.status(200).json({
        ok: true,
        skipped: "tier_not_preview",
      });
    }

    // day_completions.session_id is NOT NULL in the schema, so we must
    // resolve a session_id before inserting. Pull the user's most recent
    // OPEN chat session (fallback: most recent overall). Without this
    // the INSERT hits a "null value in column session_id" constraint
    // violation and the button silently fails — which is exactly what
    // Soetkin hit on Jul 8. If the user somehow has zero sessions we
    // return a soft error rather than crashing, so support can see it.
    const { rows: sessionRows } = await sql`
      SELECT id
      FROM sessions
      WHERE user_id = ${user.id}
      ORDER BY COALESCE(last_message_at, started_at) DESC
      LIMIT 1
    `;
    if (sessionRows.length === 0) {
      return res.status(500).json({
        error: "no_session_found",
        message: "Can't record the day completion because there is no chat session yet. Open the process at least once, then try again.",
      });
    }
    const sessionId = sessionRows[0].id;

    // Insert a day_completions row marking manual completion. ON CONFLICT
    // DO NOTHING so a button-click after the auto-detector already
    // recorded the completion is a safe no-op (same vice-versa). Both
    // mechanisms feed the same row.
    await sql`
      INSERT INTO day_completions (user_id, session_id, day, schema_version, data, completed_at)
      VALUES (
        ${user.id},
        ${sessionId}::uuid,
        ${day},
        1,
        ${JSON.stringify({ source: "manual_button" })}::jsonb,
        NOW()
      )
      ON CONFLICT (user_id, day) DO NOTHING
    `;

    // Bump last_completed_day if this is higher than what was stored.
    // current_day is a generated column = LEAST(last_completed_day + 1, 3)
    // so it updates automatically.
    await sql`
      UPDATE users
      SET last_completed_day = GREATEST(COALESCE(last_completed_day, 0), ${day}),
          updated_at = NOW()
      WHERE id = ${user.id}
    `;

    // Pull the fresh state for the response
    const { rows: updated } = await sql`
      SELECT last_completed_day, current_day, first_login_at, preview_ends_at, tier::text AS tier
      FROM users
      WHERE id = ${user.id}
    `;
    const freshUser = { ...user, ...(updated[0] || {}) };

    // No GHL event fire here. The button is intentionally silent —
    // existing day-2/day-3 reminder sequences continue to work the way
    // they always did (triggered by the time-based path on Kajabi /
    // existing automation). Manual completion just unlocks the next
    // day in our app and is invisible to the email system.

    return res.status(200).json({
      ok: true,
      last_completed_day: freshUser.last_completed_day,
      current_day: resolveActiveDay(freshUser),
      day_unlocks: buildDayUnlocks(freshUser),
    });
  } catch (err) {
    console.error("complete_day_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
