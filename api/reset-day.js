// api/reset-day.js
//
// Lets a participant "undo" a day that got marked complete before they
// actually finished the work. Created 2026-08-05 after Katrine Kovacs's
// feedback: her Day 1 ended without the sentence needed for Day 2, but
// the auto-detector had already marked Day 1 complete, so every time
// she opened the app she was sent forward to Day 2 or Day 3 with no
// way back. She had to email support and wait 5 days for a full
// account reset. This endpoint gives her (and future members) a self-
// serve escape hatch surfaced as a button in Your Account.
//
// POST body: { day: 1 | 2 | 3 }
//
// Behavior — pulls the participant BACK to the specified day so they
// can redo it:
//   1. Deletes the day_completions row for that day (and every day
//      after it, since Day 2 shouldn't stay "complete" if Day 1 has
//      been reopened).
//   2. Sets users.last_completed_day = day - 1 (so if they ask to
//      redo Day 1, last_completed_day becomes 0 and current_day = 1).
//   3. Rewrites the pending completion for that day so the auto-
//      detector doesn't immediately re-mark it (participant needs to
//      actually run the process again).
//
// Auth: same session-token flow every member endpoint uses. A member
// can only reset THEIR OWN days.
//
// Returns { ok, last_completed_day, current_day, day_unlocks }.

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
      return res.status(400).json({ error: "invalid_day", message: "day must be 1, 2, or 3" });
    }

    // Unlimited members aren't day-gated; reset is a no-op for them.
    if (user.tier !== "preview") {
      return res.status(200).json({
        ok: true,
        skipped: "tier_not_preview",
      });
    }

    // Delete the completion row for THIS day AND every day after it.
    // Rationale: if the participant asks to redo Day 1, it doesn't make
    // sense to keep Day 2 or Day 3 marked complete — those depended on
    // Day 1 being real. Reopening Day 1 walks the whole cascade back.
    await sql`
      DELETE FROM day_completions
      WHERE user_id = ${user.id}
        AND day >= ${day}
    `;

    // Set last_completed_day back to (day - 1). current_day is a
    // generated column = LEAST(last_completed_day + 1, 3) so it updates
    // automatically to open the requested day.
    const newLastCompleted = day - 1;
    await sql`
      UPDATE users
      SET last_completed_day = ${newLastCompleted},
          updated_at = NOW()
      WHERE id = ${user.id}
    `;

    // Audit log — helpful for future support triage. Uses raw_payload
    // so we don't need a new table. Best-effort; failure here doesn't
    // block the reset from taking effect.
    try {
      await sql`
        INSERT INTO admin_audit_log (
          actor_email, action, target_email, details
        ) VALUES (
          ${user.email}, 'member_self_reset_day', ${user.email},
          ${JSON.stringify({ reset_to_day: day, previous_last_completed: user.last_completed_day })}::jsonb
        )
      `;
    } catch (auditErr) {
      // Table may not exist — non-fatal.
      console.warn("reset_day_audit_failed", { message: auditErr?.message });
    }

    const { rows: updated } = await sql`
      SELECT last_completed_day, current_day, first_login_at, preview_ends_at, tier::text AS tier
      FROM users
      WHERE id = ${user.id}
    `;
    const freshUser = { ...user, ...(updated[0] || {}) };

    return res.status(200).json({
      ok: true,
      last_completed_day: freshUser.last_completed_day,
      current_day: resolveActiveDay(freshUser),
      day_unlocks: buildDayUnlocks(freshUser),
    });
  } catch (err) {
    console.error("reset_day_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error", message: err?.message });
  }
}
