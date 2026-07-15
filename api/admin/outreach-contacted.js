// api/admin/outreach-contacted.js
//
// Server-side sync for the "contacted" checkbox state on Aira's outreach
// queue. Previously stored in localStorage, which meant Aira's checkmarks
// only lived in Aira's browser — Geo (or another admin) couldn't see them.
//
// GET    → returns { contacted: { "email@example.com": { at, by }, ... } }
// POST   → body { email } marks that email as contacted (upserts)
// DELETE → body { email } removes the contacted flag
//
// Auth: same @shimritnativ.com session token every admin endpoint uses.
// The `contacted_by` field records who checked the box (Aira vs Geo etc.)
// so a future activity feed can attribute who did what.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
// Contacted flags expire after this many days so members re-appear in
// the queue if they still show engagement gaps. Matches the previous
// localStorage TTL so behaviour is unchanged for Aira.
const CONTACTED_TTL_DAYS = 30;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Auth
  const sessionToken = req.headers["x-session-token"];
  const user = await getUserBySessionToken(sessionToken);
  if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    if (req.method === "GET") {
      // Return everything within the TTL window. Client filters on display.
      const { rows } = await sql`
        SELECT LOWER(email) AS email, contacted_at, contacted_by
        FROM outreach_contacted
        WHERE contacted_at > NOW() - (${CONTACTED_TTL_DAYS}::text || ' days')::interval
        ORDER BY contacted_at DESC
      `;
      const contacted = {};
      for (const r of rows) {
        contacted[r.email] = {
          at: r.contacted_at,
          by: r.contacted_by || null,
        };
      }
      return res.status(200).json({ contacted, count: rows.length });
    }

    // POST / DELETE both need the email in the body.
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const email = String(body.email || "").toLowerCase().trim();
    if (!email) return res.status(400).json({ error: "email_required" });

    if (req.method === "POST") {
      // Upsert. If already there, refresh the timestamp so the TTL restarts
      // and update contacted_by (whoever last touched it).
      await sql`
        INSERT INTO outreach_contacted (email, contacted_at, contacted_by)
        VALUES (${email}, NOW(), ${user.email})
        ON CONFLICT (email) DO UPDATE SET
          contacted_at = NOW(),
          contacted_by = EXCLUDED.contacted_by
      `;
      return res.status(200).json({ ok: true, email, contacted_by: user.email });
    }

    if (req.method === "DELETE") {
      await sql`
        DELETE FROM outreach_contacted
        WHERE LOWER(email) = ${email}
      `;
      return res.status(200).json({ ok: true, email });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (e) {
    console.error("outreach_contacted_failed", e);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
}

/*
==============================================================================
ONE-TIME SQL MIGRATION — run in Neon SQL editor before hitting this endpoint.
Idempotent — safe to re-run.
==============================================================================

CREATE TABLE IF NOT EXISTS outreach_contacted (
  email TEXT PRIMARY KEY,
  contacted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  contacted_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_outreach_contacted_at
  ON outreach_contacted (contacted_at DESC);
*/
