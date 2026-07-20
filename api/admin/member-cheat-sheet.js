// api/admin/member-cheat-sheet.js
//
// Per-member freeform notes that Aira writes and Carmen reads before a
// call. Also mirrors those notes into GHL's native Notes tab automatically
// so the customer record in GHL stays the single source of truth.
//
// GET  ?email=...       → { email, notes, tag_summary, updated_by, updated_at, ghl_note_id }
// POST { email, notes } → upsert Neon + push to GHL. Empty string clears
//                         both sides.
//
// Auth: @shimritnativ.com session, same as every admin endpoint.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const MAX_NOTES_LEN = 10_000;
const GHL_V1_BASE = "https://rest.gohighlevel.com/v1";
const GHL_TIMEOUT_MS = 6000;

// Look up the most recent GHL contact ID we have for a member — same
// pattern carmen-list uses.
async function findGhlContactId(email) {
  const { rows } = await sql`
    SELECT ghl_contact_id
    FROM whatsapp_message_events
    WHERE LOWER(contact_email) = ${email}
      AND ghl_contact_id IS NOT NULL AND ghl_contact_id <> ''
    ORDER BY event_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `;
  return rows.length ? rows[0].ghl_contact_id : null;
}

// Fire a GHL API request with a short timeout so a hung network doesn't
// block Aira's save. Returns { ok, status, data|error }.
async function ghlFetch(url, { method, apiKey, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GHL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, data, raw: text.slice(0, 400) };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

// Push notes to GHL. Creates a new note on first save, updates the same
// note on subsequent saves so we don't accumulate duplicates.
// Returns { ok, note_id?, error? } — never throws.
async function syncNotesToGhl({ email, notes, existingNoteId, actorEmail }) {
  const apiKey = process.env.GHL_API_KEY;
  if (!apiKey) return { ok: false, error: "ghl_api_key_missing" };

  const ghlContactId = await findGhlContactId(email);
  if (!ghlContactId) return { ok: false, error: "no_ghl_contact_id" };

  const noteBody = `[Field cheat sheet · ${actorEmail || "shimritnativ.com"}]\n\n${notes}`;

  // If we already have a note ID, try to update it in place.
  if (existingNoteId) {
    const putRes = await ghlFetch(
      `${GHL_V1_BASE}/contacts/${encodeURIComponent(ghlContactId)}/notes/${encodeURIComponent(existingNoteId)}`,
      { method: "PUT", apiKey, body: { body: noteBody, userId: null } }
    );
    if (putRes.ok) return { ok: true, note_id: existingNoteId, action: "updated" };
    // If the note was deleted in GHL, fall through to create a fresh one.
  }

  const postRes = await ghlFetch(
    `${GHL_V1_BASE}/contacts/${encodeURIComponent(ghlContactId)}/notes/`,
    { method: "POST", apiKey, body: { body: noteBody } }
  );
  if (!postRes.ok) {
    return { ok: false, error: `ghl_post_failed_${postRes.status}: ${postRes.raw || postRes.error || "unknown"}` };
  }
  const created = postRes.data && (postRes.data.id || (postRes.data.note && postRes.data.note.id));
  return { ok: true, note_id: created || null, action: "created" };
}

async function deleteNoteFromGhl({ email, existingNoteId }) {
  if (!existingNoteId) return { ok: true, skipped: true };
  const apiKey = process.env.GHL_API_KEY;
  if (!apiKey) return { ok: false, error: "ghl_api_key_missing" };
  const ghlContactId = await findGhlContactId(email);
  if (!ghlContactId) return { ok: false, error: "no_ghl_contact_id" };
  const res = await ghlFetch(
    `${GHL_V1_BASE}/contacts/${encodeURIComponent(ghlContactId)}/notes/${encodeURIComponent(existingNoteId)}`,
    { method: "DELETE", apiKey }
  );
  return { ok: res.ok, error: res.ok ? null : `ghl_delete_failed_${res.status}` };
}

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
        SELECT email, notes, tag_summary, ghl_note_id, updated_by, updated_at
        FROM member_cheat_sheets
        WHERE LOWER(email) = ${email}
        LIMIT 1
      `;
      if (rows.length === 0) {
        return res.status(200).json({
          ok: true,
          email,
          notes: "",
          tag_summary: "",
          ghl_note_id: null,
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
        tag_summary: r.tag_summary || "",
        ghl_note_id: r.ghl_note_id || null,
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

      // Peek at the existing GHL note ID so we know whether to create or
      // update over in GHL.
      const { rows: existingRows } = await sql`
        SELECT ghl_note_id FROM member_cheat_sheets WHERE LOWER(email) = ${email} LIMIT 1
      `;
      const existingNoteId = existingRows.length ? existingRows[0].ghl_note_id : null;

      if (notes.trim() === "") {
        // Empty notes — clear locally. Also remove the mirror note from GHL
        // if we ever pushed one (fail-soft: never blocks the local clear).
        await sql`
          UPDATE member_cheat_sheets
          SET notes = '', ghl_note_id = NULL, updated_at = NOW()
          WHERE LOWER(email) = ${email}
        `;
        await sql`
          DELETE FROM member_cheat_sheets
          WHERE LOWER(email) = ${email}
            AND (notes IS NULL OR notes = '')
            AND (tag_summary IS NULL OR tag_summary = '')
        `;
        let ghlDelete = { ok: true, skipped: true };
        if (existingNoteId) {
          ghlDelete = await deleteNoteFromGhl({ email, existingNoteId });
        }
        return res.status(200).json({
          ok: true, email, cleared: true,
          ghl: {
            synced: !!ghlDelete.ok,
            error: ghlDelete.error || null,
            action: existingNoteId ? "deleted" : "skipped",
          },
        });
      }

      // Persist locally first — never let a GHL outage lose Aira's work.
      await sql`
        INSERT INTO member_cheat_sheets (email, notes, updated_by, updated_at)
        VALUES (${email}, ${notes}, ${user.email}, NOW())
        ON CONFLICT (email) DO UPDATE SET
          notes = EXCLUDED.notes,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
      `;

      // Then push to GHL. If it fails we return the error to the client
      // but the local save already succeeded.
      const ghlResult = await syncNotesToGhl({
        email,
        notes,
        existingNoteId,
        actorEmail: user.email,
      });

      if (ghlResult.ok && ghlResult.note_id) {
        await sql`
          UPDATE member_cheat_sheets
          SET ghl_note_id = ${ghlResult.note_id}
          WHERE LOWER(email) = ${email}
        `;
      }

      return res.status(200).json({
        ok: true,
        email,
        updated_by: user.email,
        ghl: {
          synced: !!ghlResult.ok,
          note_id: ghlResult.note_id || existingNoteId || null,
          action: ghlResult.action || null,
          error: ghlResult.error || null,
        },
      });
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

-- Additive columns for later iterations:
ALTER TABLE member_cheat_sheets
  ADD COLUMN IF NOT EXISTS tag_summary TEXT;
ALTER TABLE member_cheat_sheets
  ADD COLUMN IF NOT EXISTS ghl_note_id TEXT;

CREATE INDEX IF NOT EXISTS idx_member_cheat_sheets_updated
  ON member_cheat_sheets (updated_at DESC);
*/
