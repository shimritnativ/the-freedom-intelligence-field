// api/admin/aira-checklist.js
//
// Server-side sync for Aira's daily checklist (the ticks she makes on the
// Track tab of the SOPs). Previously localStorage, meaning Geo couldn't
// see which items Aira had already checked off. Now stored in Neon so
// every admin sees the same state.
//
// GET → { state: { "section_id_i": true, ... }, history: { "YYYY-MM-DD": {...} } }
// POST { action: "toggle", item_id, checked: true|false }
// POST { action: "archive" } → snapshot current state into history, clear state
// POST { action: "reset" }   → clear state (no archive)
//
// Auth: same @shimritnativ.com session token every admin endpoint uses.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sessionToken = req.headers["x-session-token"];
  const user = await getUserBySessionToken(sessionToken);
  if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    if (req.method === "GET") {
      const [stateRes, historyRes] = await Promise.all([
        sql`SELECT item_id, checked_by, checked_at FROM aira_checklist_state`,
        sql`SELECT date::text AS date, items, total, done, archived_at
              FROM aira_checklist_history
              ORDER BY date DESC
              LIMIT 60`,
      ]);
      const state = {};
      for (const r of stateRes.rows) state[r.item_id] = true;
      const history = {};
      for (const r of historyRes.rows) {
        history[r.date] = {
          items: r.items || {},
          total: r.total || 0,
          done: r.done || 0,
          savedAt: r.archived_at,
        };
      }
      return res.status(200).json({ state, history });
    }

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const action = String(body.action || "").toLowerCase().trim();

    if (action === "toggle") {
      const itemId = String(body.item_id || "").trim();
      if (!itemId) return res.status(400).json({ error: "item_id_required" });
      if (body.checked) {
        await sql`
          INSERT INTO aira_checklist_state (item_id, checked_by, checked_at)
          VALUES (${itemId}, ${user.email}, NOW())
          ON CONFLICT (item_id) DO UPDATE SET
            checked_by = EXCLUDED.checked_by,
            checked_at = NOW()
        `;
      } else {
        await sql`DELETE FROM aira_checklist_state WHERE item_id = ${itemId}`;
      }
      return res.status(200).json({ ok: true, item_id: itemId, checked: !!body.checked });
    }

    if (action === "archive") {
      // Snapshot current state into history, then clear state.
      const { rows: stateRows } = await sql`SELECT item_id FROM aira_checklist_state`;
      const items = {};
      for (const r of stateRows) items[r.item_id] = true;
      const totalCount = Number(body.total || 0);
      const doneCount = stateRows.length;
      // Use "today" per server time. If Aira archives at 23:55 or 00:05,
      // the date is stamped at that moment — good enough for a daily log.
      await sql`
        INSERT INTO aira_checklist_history (date, items, total, done, archived_at)
        VALUES (CURRENT_DATE, ${JSON.stringify(items)}::jsonb, ${totalCount}, ${doneCount}, NOW())
        ON CONFLICT (date) DO UPDATE SET
          items       = EXCLUDED.items,
          total       = EXCLUDED.total,
          done        = EXCLUDED.done,
          archived_at = NOW()
      `;
      await sql`DELETE FROM aira_checklist_state`;
      return res.status(200).json({ ok: true, archived_items: doneCount });
    }

    if (action === "reset") {
      await sql`DELETE FROM aira_checklist_state`;
      return res.status(200).json({ ok: true });
    }

    if (action === "clear_history") {
      await sql`DELETE FROM aira_checklist_history`;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "unknown_action", allowed: ["toggle", "archive", "reset", "clear_history"] });
  } catch (e) {
    console.error("aira_checklist_failed", e);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
}

/*
==============================================================================
ONE-TIME SQL MIGRATION — run in Neon SQL editor before hitting this endpoint.
Idempotent — safe to re-run.
==============================================================================

CREATE TABLE IF NOT EXISTS aira_checklist_state (
  item_id TEXT PRIMARY KEY,
  checked_by TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aira_checklist_history (
  date DATE PRIMARY KEY,
  items JSONB NOT NULL,
  total INT DEFAULT 0,
  done INT DEFAULT 0,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aira_checklist_history_date
  ON aira_checklist_history (date DESC);
*/
