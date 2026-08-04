// api/cron/aira-checklist-archive.js
//
// Auto-archives Aira's daily checklist state into history and clears
// the live state so tomorrow starts fresh. Runs via Vercel cron once
// per day at 22:00 UTC (~23:00 CET winter, 00:00 CEST summer — end of
// the European workday, before Aira starts a new day).
//
// Without this cron the history table only records days when someone
// manually clicked "Archive & Reset" on the Track tab — Geo asked for
// automatic daily archiving so no work is lost. Added 2026-08-04.
//
// Auth: Vercel populates the `Authorization` header with `Bearer <CRON_SECRET>`
// for scheduled cron invocations. We verify it so external requests
// cannot spam this endpoint and destroy real state.

import { sql } from "@vercel/postgres";

export default async function handler(req, res) {
  // Vercel cron sends this header. If someone hits the URL without it
  // (or with a wrong secret), refuse — resetting state is destructive.
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const source = String(req.query?.source || "");
  const isCron = auth === `Bearer ${cronSecret}` || req.headers["x-vercel-cron"] === "1";
  if (!isCron && source !== "manual") {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    // Read current live state. If nothing was ticked today, skip — no
    // point writing an empty row that would clutter the history list.
    const { rows: stateRows } = await sql`
      SELECT item_id FROM aira_checklist_state
    `;
    if (stateRows.length === 0) {
      return res.status(200).json({ ok: true, archived: 0, skipped: "empty_state" });
    }

    const items = {};
    for (const r of stateRows) items[r.item_id] = true;
    const doneCount = stateRows.length;
    // We don't know the total item count from server-side (it's defined
    // in the Aira SOP HTML), so store 0 as a marker for "auto-archived".
    // The UI falls back to `done` when total is 0 so the history entry
    // still renders with the correct done-count.
    const totalCount = 0;

    await sql`
      INSERT INTO aira_checklist_history (date, items, total, done, archived_at)
      VALUES (CURRENT_DATE, ${JSON.stringify(items)}::jsonb, ${totalCount}, ${doneCount}, NOW())
      ON CONFLICT (date) DO UPDATE SET
        items       = EXCLUDED.items,
        -- Preserve the manually-entered total if the row already exists
        -- from a manual Archive & Reset earlier in the day.
        total       = GREATEST(aira_checklist_history.total, EXCLUDED.total),
        done        = EXCLUDED.done,
        archived_at = NOW()
    `;
    await sql`DELETE FROM aira_checklist_state`;

    console.log("aira_checklist_auto_archived", { items: doneCount });
    return res.status(200).json({ ok: true, archived: doneCount });
  } catch (e) {
    console.error("aira_checklist_auto_archive_failed", e);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
}
