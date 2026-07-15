// api/admin/import-wa-failures.js
//
// Imports the CSV from GHL → Reporting → WhatsApp Statistics into
// whatsapp_message_events. GHL doesn't expose message-delivery status via
// its V1 API but its UI does generate this CSV — this endpoint is our
// bridge so the queue can flag confirmed WA failures.
//
// CSV format (as of Jul 2026):
//   name,phone,status,timestamp
//   "aira bueno","+499398208450","failed","2026-07-15T11:58:20.938Z"
//
// Auth: same @shimritnativ.com session gate as every admin endpoint.
//
// Body: { csv: "<raw csv text>" }   OR raw text/csv body
//
// Response: { imported, matched, skipped, errors }

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const GHL_V1_BASE = "https://rest.gohighlevel.com/v1";

// GHL V1 lookup by phone — tries multiple query variations to catch
// phones stored with different formats (with/without country code,
// with/without formatting). Match rule: last 10 digits must match, which
// is the reliable NANP + international pattern (avoids false positives
// from short-suffix matching while still handling missing country codes).
async function lookupGhlEmailByPhone({ apiKey, phone }) {
  const fullDigits = String(phone || "").replace(/[^0-9]/g, "");
  if (!fullDigits) return null;

  // Try queries in order of specificity: full digits → last 10 → last 7.
  // GHL's fuzzy search matches ANY field containing the substring, so
  // shorter queries return more candidates. We compensate by verifying
  // last-10-digit match on the response side.
  const queries = [fullDigits];
  if (fullDigits.length >= 10 && !queries.includes(fullDigits.slice(-10))) {
    queries.push(fullDigits.slice(-10));
  }
  if (fullDigits.length >= 7 && !queries.includes(fullDigits.slice(-7))) {
    queries.push(fullDigits.slice(-7));
  }

  const csvLast10 = fullDigits.slice(-10);

  for (const query of queries) {
    try {
      const res = await fetch(
        `${GHL_V1_BASE}/contacts/?query=${encodeURIComponent(query)}&limit=25`,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const contacts = data.contacts || [];
      for (const c of contacts) {
        const cDigits = String(c.phone || "").replace(/[^0-9]/g, "");
        if (!cDigits) continue;
        // Primary match: last 10 digits identical (handles missing country
        // code on either side without false positives).
        if (cDigits.length >= 10 && csvLast10.length >= 10 &&
            cDigits.slice(-10) === csvLast10) {
          const email = String(c.email || "").toLowerCase().trim();
          if (email) return email;
        }
        // Secondary: exact full-digits match (for short numbers < 10 digits,
        // e.g. some European short codes).
        if (cDigits === fullDigits) {
          const email = String(c.email || "").toLowerCase().trim();
          if (email) return email;
        }
      }
    } catch {
      // move on to next query variation
    }
  }
  return null;
}

// Robust CSV/TSV line parser — handles quoted fields with delimiter inside.
// GHL exports sometimes come with commas and sometimes with semicolons
// (locale-dependent), so we auto-detect the delimiter from the header line.
function parseCsvLine(line, delimiter = ",") {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && inQuotes && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// Look at the header line and pick whichever separator appears most —
// GHL uses commas in English exports, semicolons in some EU locales.
function detectDelimiter(headerLine) {
  const commaCount = (headerLine.match(/,/g) || []).length;
  const semiCount = (headerLine.match(/;/g) || []).length;
  return semiCount > commaCount ? ";" : ",";
}

// Normalize a phone number to include a leading "+" when digits look like
// a full international number. GHL sometimes exports without the plus.
function normalizePhone(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/[^0-9]/g, "");
  // 10+ digits without prefix → assume it's already E.164 minus the plus.
  if (digits.length >= 10) return "+" + digits;
  return trimmed;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  // Auth
  const sessionToken = req.headers["x-session-token"];
  const user = await getUserBySessionToken(sessionToken);
  if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const apiKey = process.env.GHL_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ghl_not_configured" });

  // Accept either { csv: "..." } JSON or plain text body.
  let csv = "";
  if (typeof req.body === "string") csv = req.body;
  else if (req.body && typeof req.body === "object") csv = String(req.body.csv || "");
  // Strip UTF-8 BOM (0xFEFF) that most CSV exporters add. Without this,
  // the first column parses as "﻿name" and header matching fails.
  csv = csv.replace(/^﻿/, "").trim();
  if (!csv) return res.status(400).json({ error: "csv_empty" });

  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return res.status(400).json({ error: "csv_no_data" });

  // Auto-detect delimiter (comma vs semicolon) from the header line.
  const delimiter = detectDelimiter(lines[0]);

  // Parse header — case-insensitive, position-based. Also strip BOM
  // per-field in case it snuck through, and trim whitespace.
  const header = parseCsvLine(lines[0], delimiter).map(s =>
    s.replace(/^﻿/, "").trim().toLowerCase()
  );
  const nameIdx = header.indexOf("name");
  const phoneIdx = header.indexOf("phone");
  const statusIdx = header.indexOf("status");
  const timestampIdx = header.indexOf("timestamp");
  if (phoneIdx < 0 || statusIdx < 0) {
    return res.status(400).json({
      error: "csv_missing_columns",
      expected: ["name", "phone", "status", "timestamp"],
      found: header,
      delimiter_used: delimiter,
      first_line_raw: lines[0].slice(0, 200),
    });
  }

  // Parse data rows; keep only failures. Normalize phones to E.164 with
  // leading "+" so subsequent GHL lookups and dedup logic work uniformly.
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i], delimiter);
    const name = nameIdx >= 0 ? fields[nameIdx] : null;
    const phone = normalizePhone(fields[phoneIdx] || "");
    const status = String(fields[statusIdx] || "").toLowerCase();
    const timestamp = timestampIdx >= 0 ? fields[timestampIdx] : null;
    if (!phone || phone.toLowerCase() === "unknown") continue;
    if (!["failed", "undelivered", "error"].includes(status)) continue;
    rows.push({ name: name || null, phone, status, timestamp });
  }

  if (rows.length === 0) {
    return res.status(200).json({
      imported: 0, matched: 0, skipped: 0,
      note: "No failure rows found in CSV.",
    });
  }

  // Dedupe by phone so we do at most one GHL lookup per unique phone.
  const uniquePhones = Array.from(new Set(rows.map(r => r.phone)));
  const phoneToEmail = new Map();

  // Look up emails in parallel batches of 6 (safe under GHL rate limits).
  const BATCH_SIZE = 6;
  for (let i = 0; i < uniquePhones.length; i += BATCH_SIZE) {
    const batch = uniquePhones.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(p => lookupGhlEmailByPhone({ apiKey, phone: p }))
    );
    batch.forEach((p, idx) => phoneToEmail.set(p, results[idx]));
  }

  // Insert into whatsapp_message_events. On conflict we backfill email if
  // it was previously NULL — so re-uploading the same CSV with an improved
  // phone lookup picks up members we missed the first time.
  let imported = 0;   // new rows inserted this run
  let backfilled = 0; // existing rows whose email got filled in
  let matched = 0;    // rows with an email tied to a Neon member candidate
  let skipped = 0;    // rows that already had all info (nothing to update)
  const errors = [];

  for (const row of rows) {
    try {
      const email = phoneToEmail.get(row.phone) || null;
      const eventAt = row.timestamp
        ? new Date(row.timestamp).toISOString()
        : new Date().toISOString();
      // The unique index is PARTIAL (`WHERE contact_phone IS NOT NULL`),
      // so ON CONFLICT must repeat that predicate or Postgres rejects the
      // statement with "no unique or exclusion constraint matching".
      // On conflict we BACKFILL contact_email when it was previously NULL —
      // this lets us re-run the import with an improved phone lookup and
      // pick up members whose emails weren't resolved the first time.
      const result = await sql`
        INSERT INTO whatsapp_message_events (
          contact_email, contact_phone, contact_name,
          status, channel, event_at, raw_payload
        ) VALUES (
          ${email}, ${row.phone}, ${row.name},
          ${row.status}, 'WhatsApp', ${eventAt}::timestamptz,
          ${JSON.stringify(row)}::jsonb
        )
        ON CONFLICT (contact_phone, event_at, status)
        WHERE contact_phone IS NOT NULL
        DO UPDATE SET
          contact_email = COALESCE(whatsapp_message_events.contact_email, EXCLUDED.contact_email),
          contact_name  = COALESCE(whatsapp_message_events.contact_name,  EXCLUDED.contact_name)
        RETURNING id, (xmax = 0) AS was_new
      `;
      if (result.rows.length > 0) {
        // Postgres trick: xmax = 0 means a fresh INSERT; nonzero means
        // an UPDATE fired (row already existed and we backfilled email).
        const wasNew = result.rows[0].was_new === true;
        if (wasNew) imported++;
        else backfilled++;
        if (email) matched++;
      } else {
        skipped++;
      }
    } catch (e) {
      errors.push({ phone: row.phone, error: e.message });
    }
  }

  return res.status(200).json({
    imported,   // brand new failure rows inserted
    backfilled, // existing rows updated with a newly-resolved email
    matched,    // rows for which we now have an email (any source)
    skipped,    // existing rows that were already complete
    total_rows: rows.length,
    unique_phones: uniquePhones.length,
    unmatched_phones: uniquePhones.filter(p => !phoneToEmail.get(p)),
    errors,
  });
}

/*
==============================================================================
ONE-TIME SQL MIGRATION — run in Neon SQL editor before hitting this endpoint.
If the table was already created earlier (with the webhook version), the
ALTER lines add the new columns non-destructively. Idempotent.
==============================================================================

CREATE TABLE IF NOT EXISTS whatsapp_message_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_email TEXT,
  contact_phone TEXT,
  contact_name TEXT,
  ghl_contact_id TEXT,
  ghl_message_id TEXT,
  status TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'WhatsApp',
  message_number TEXT,
  workflow_id TEXT,
  workflow_name TEXT,
  message_preview TEXT,
  raw_payload JSONB,
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE whatsapp_message_events
  ADD COLUMN IF NOT EXISTS contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS contact_name TEXT;

CREATE INDEX IF NOT EXISTS idx_wa_events_email ON whatsapp_message_events (LOWER(contact_email));
CREATE INDEX IF NOT EXISTS idx_wa_events_phone ON whatsapp_message_events (contact_phone);
CREATE INDEX IF NOT EXISTS idx_wa_events_status_time ON whatsapp_message_events (status, event_at DESC);

-- Unique constraint prevents re-inserting the same failure event twice
-- when the CSV is uploaded multiple times.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wa_events_phone_time_status
  ON whatsapp_message_events (contact_phone, event_at, status)
  WHERE contact_phone IS NOT NULL;
*/
