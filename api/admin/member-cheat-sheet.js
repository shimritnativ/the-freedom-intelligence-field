// api/admin/member-cheat-sheet.js
//
// Per-member freeform notes that Aira writes and Carmen reads before a
// call. Anything relevant: what they filled out on a survey, what they
// mentioned in DMs, past exchanges, family context, prior offers seen,
// etc. Not structured — Aira decides what matters.
//
// GET  ?email=...       → { email, notes, updated_by, updated_at }
// POST { email, notes } → upsert. Empty string clears (effectively deletes).
//
// Auth: @shimritnativ.com session, same as every admin endpoint.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const MAX_NOTES_LEN = 10_000; // 10K chars is plenty for a call prep note

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
      const email = String(req.query.email || "").toLowerCase().trim();
      if (!email) return res.status(400).json({ error: "email_required" });
      const { rows } = await sql`
        SELECT email, notes, updated_by, updated_at
        FROM member_cheat_sheets
        WHERE LOWER(email) = ${email}
        LIMIT 1
      `;
      if (rows.length === 0) {
        return res.status(200).json({
          ok: true,
          email,
          notes: "",
          updated_by: null,
          updated_at: null,
          exists: false,
        });
      }
      const r = rows[0];
      return res.status(200).json({
        ok: true,
        email: r.email,
        notes: r.notes || "",
        updated_by: r.updated_by,
        updated_at: r.updated_at,
        exists: true,
      });
    }

    if (req.method === "POST") {
      const body = (req.body && typeof req.body === "object") ? req.body : {};
      const email = String(body.email || "").toLowerCase().trim();
      const notes = String(body.notes ?? "").slice(0, MAX_NOTES_LEN);
      if (!email) return res.status(400).json({ error: "email_required" });

      if (notes.trim() === "") {
        // Empty notes = clear the row so has_cheat_sheet reads false again.
        await sql`DELETE FROM member_cheat_sheets WHERE LOWER(email) = ${email}`;
        return res.status(200).json({ ok: true, email, cleared: true });
      }

      await sql`
        INSERT INTO member_cheat_sheets (email, notes, updated_by, updated_at)
        VALUES (${email}, ${notes}, ${user.email}, NOW())
        ON CONFLICT (email) DO UPDATE SET
          notes = EXCLUDED.notes,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
      `;
      return res.status(200).json({ ok: true, email, updated_by: user.email });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (e) {
    console.error("member_cheat_sheet_failed", e);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
}

/*
==============================================================================
ONE-TIME SQL MIGRATION — run in Neon SQL editor before hitting this endpoint.
Idempotent — safe to re-run.
==============================================================================

CREATE TABLE IF NOT EXISTS member_cheat_sheets (
  email TEXT PRIMARY KEY,
  notes TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_member_cheat_sheets_updated
  ON member_cheat_sheets (updated_at DESC);
*/
