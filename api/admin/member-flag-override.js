// api/admin/member-flag-override.js
//
// Manual override for tag-derived flags on Carmen's outreach dashboard.
// GHL tag sync is not perfectly reliable — when a tag like
// "reset newly engaged" exists in GHL but the flag hasn't propagated (or
// the tag naming is odd and slipped past our LIKE patterns), Geo/Carmen
// can flip the override manually here so the dashboard mirrors reality.
//
// Writes to member_program_overrides, which carmen-list.js OR's with the
// tag-based check for each flag.
//
// POST /api/admin/member-flag-override
//   body: { email, flag, value }
//     flag  ∈ 'is_newly_engaged' | 'is_rise_current' | 'is_rise_past' | 'is_certification'
//     value ∈ true | false
//
// Auth: same @shimritnativ.com session token every admin endpoint uses.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

// Whitelist — keeps SQL identifier safe since we interpolate the column name.
const VALID_FLAGS = new Set([
  "is_newly_engaged",
  "is_rise_current",
  "is_rise_past",
  "is_certification",
]);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const sessionToken = req.headers["x-session-token"];
  const user = await getUserBySessionToken(sessionToken);
  if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const email = String(body.email || "").toLowerCase().trim();
  const flag  = String(body.flag  || "").trim();
  const value = !!body.value;

  if (!email) return res.status(400).json({ error: "email_required" });
  if (!VALID_FLAGS.has(flag)) return res.status(400).json({ error: "invalid_flag" });

  try {
    // Build the upsert dynamically but safely — column name is validated
    // above against a hard-coded whitelist, so string interpolation here
    // cannot introduce SQL injection.
    const query = `
      INSERT INTO member_program_overrides (email, ${flag}, updated_at, updated_by)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (email) DO UPDATE SET
        ${flag}    = EXCLUDED.${flag},
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
    `;
    await sql.query(query, [email, value, user.email]);

    return res.status(200).json({ ok: true, email, flag, value });
  } catch (e) {
    console.error("member_flag_override_failed", e);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
}

/*
==============================================================================
ONE-TIME SQL MIGRATION — run in Neon SQL editor before hitting this endpoint.
Idempotent — safe to re-run.
==============================================================================

CREATE TABLE IF NOT EXISTS member_program_overrides (
  email             TEXT PRIMARY KEY,
  is_newly_engaged  BOOLEAN NOT NULL DEFAULT false,
  is_rise_current   BOOLEAN NOT NULL DEFAULT false,
  is_rise_past      BOOLEAN NOT NULL DEFAULT false,
  is_certification  BOOLEAN NOT NULL DEFAULT false,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by        TEXT
);

-- If the table already exists but is missing the new column, add it:
ALTER TABLE member_program_overrides
  ADD COLUMN IF NOT EXISTS is_newly_engaged BOOLEAN NOT NULL DEFAULT false;
*/
