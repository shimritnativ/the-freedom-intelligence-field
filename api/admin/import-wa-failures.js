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

// GHL V1 lookup by phone — returns the first contact whose phone digits
// match. Used to map CSV phone → contact email so the queue can join by
// email (Neon users don't have phone stored).
async function lookupGhlEmailByPhone({ apiKey, phone }) {
  const digits = phone.replace(/[^0-9]/g, "");
  if (!digits) return null;
  try {
    const res = await fetch(
      `${GHL_V1_BASE}/contacts/?query=${encodeURIComponent(digits)}&limit=5`,
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const contacts = data.contacts || [];
    // Find the one whose phone digits match ours (fuzzy query returns
    // multiple candidates; we want the exact phone match).
    for (const c of contacts) {
      const cDigits = String(c.phone || "").replace(/[^0-9]/g, "");
      if (cDigits && (cDigits === digits || cDigits.endsWith(digits) || digits.endsWith(cDigits))) {
        return (c.email || "").toLowerCase().trim() || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Robust CSV line parser — handles quoted fields with commas inside.
function parseCsvLine(line) {
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
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
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

  // Parse header — case-insensitive, position-based. Also strip BOM
  // per-field in case it snuck through, and trim whitespace.
  const header = parseCsvLine(lines[0]).map(s =>
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
      first_line_raw: lines[0].slice(0, 200),
    });
  }

  // Parse data rows; keep only failures.
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const name = nameIdx >= 0 ? fields[nameIdx] : null;
    const phone = fields[phoneIdx] || "";
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

  // Insert into whatsapp_message_events. ON CONFLICT prevents duplicates
  // when the same CSV is uploaded twice.
  let imported = 0;
  let matched = 0;
  let skipped = 0;
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
        DO NOTHING
        RETURNING id
      `;
      if (result.rows.length > 0) {
        imported++;
        if (email) matched++;
      } else {
        skipped++;
      }
    } catch (e) {
      errors.push({ phone: row.phone, error: e.message });
    }
  }

  return res.status(200).json({
    imported,
    matched, // rows we successfully mapped to a Neon email
    skipped, // duplicates already in the table
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
