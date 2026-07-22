// api/admin/carmen-contacted.js
//
// Server-side sync for Carmen's "contacted" checkbox state on the outreach
// dashboard. Separate table from Aira's outreach_contacted so the two
// workflows don't collide — Aira ticks emails/WhatsApp outreach, Carmen
// ticks phone calls. Different jobs, different history.
//
// GET    → returns { contacted: { "email@example.com": { at, by, outcome }, ... } }
// POST   → body { email, outcome? } — upserts. outcome is one of:
//          'reached', 'no_answer', 'declined', 'callback', or null (just ticked)
// DELETE → body { email } removes the contacted flag
//
// Auth: same @shimritnativ.com session token every admin endpoint uses.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const CONTACTED_TTL_DAYS = 30;

const VALID_OUTCOMES = new Set([
  "reached",
  "no_answer",
  "declined",
  "callback",
  "call_booked",
  "no_need",
]);

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
      const { rows } = await sql`
        SELECT LOWER(email) AS email, contacted_at, contacted_by, outcome
        FROM carmen_contacted
        WHERE contacted_at > NOW() - (${CONTACTED_TTL_DAYS}::text || ' days')::interval
        ORDER BY contacted_at DESC
      `;
      const contacted = {};
      for (const r of rows) {
        contacted[r.email] = {
          at: r.contacted_at,
          by: r.contacted_by || null,
          outcome: r.outcome || null,
        };
      }
      return res.status(200).json({ contacted, count: rows.length });
    }

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const email = String(body.email || "").toLowerCase().trim();
    if (!email) return res.status(400).json({ error: "email_required" });

    if (req.method === "POST") {
      const rawOutcome = String(body.outcome || "").trim().toLowerCase();
      const outcome = VALID_OUTCOMES.has(rawOutcome) ? rawOutcome : null;
      await sql`
        INSERT INTO carmen_contacted (email, contacted_at, contacted_by, outcome)
        VALUES (${email}, NOW(), ${user.email}, ${outcome})
        ON CONFLICT (email) DO UPDATE SET
          contacted_at = NOW(),
          contacted_by = EXCLUDED.contacted_by,
          outcome = COALESCE(EXCLUDED.outcome, carmen_contacted.outcome)
      `;
      return res.status(200).json({ ok: true, email, outcome });
    }

    if (req.method === "DELETE") {
      await sql`DELETE FROM carmen_contacted WHERE LOWER(email) = ${email}`;
      return res.status(200).json({ ok: true, email });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (e) {
    console.error("carmen_contacted_failed", e);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
}

/*
==============================================================================
ONE-TIME SQL MIGRATION — run in Neon SQL editor before hitting this endpoint.
Idempotent — safe to re-run.
==============================================================================

CREATE TABLE IF NOT EXISTS carmen_contacted (
  email TEXT PRIMARY KEY,
  contacted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  contacted_by TEXT,
  outcome TEXT  -- 'reached' | 'no_answer' | 'declined' | 'callback' | NULL
);

CREATE INDEX IF NOT EXISTS idx_carmen_contacted_at
  ON carmen_contacted (contacted_at DESC);
*/
