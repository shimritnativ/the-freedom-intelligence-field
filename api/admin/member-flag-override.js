// api/admin/member-flag-override.js
//
// Manual override for tag-derived flags on Carmen's outreach dashboard.
// GHL tag sync is not perfectly reliable — when a tag exists in GHL but
// hasn't propagated (or the tag naming is odd and slipped past our LIKE
// patterns), Geo/Carmen can flip the override manually here so the
// dashboard mirrors reality.
//
// Writes to member_program_overrides, which carmen-list.js OR's with the
// tag-based check for each flag.
//
// POST /api/admin/member-flag-override
//   body: { email, flag, value }
//     flag  ∈ 'is_newly_engaged' | 'is_rise_current' | 'is_rise_past' |
//             'is_certification' | 'is_business_club'
//     value ∈ true | false
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
  try {
    // Per-flag branches. Template literal form so we stay on the
    // vercel/postgres sql tag without needing sql.query(). Only the
    // flag column + email are written — updated_at / updated_by are
    // intentionally omitted because the existing table was created
    // without them. If you want an audit trail later, add those
    // columns via ALTER TABLE and reintroduce them here.
    if (flag === "is_newly_engaged") {
      await sql`
        INSERT INTO member_program_overrides (email, is_newly_engaged)
        VALUES (${email}, ${value})
        ON CONFLICT (email) DO UPDATE SET
          is_newly_engaged = EXCLUDED.is_newly_engaged
      `;
    } else if (flag === "is_rise_current") {
      await sql`
        INSERT INTO member_program_overrides (email, is_rise_current)
        VALUES (${email}, ${value})
        ON CONFLICT (email) DO UPDATE SET
          is_rise_current = EXCLUDED.is_rise_current
      `;
    } else if (flag === "is_rise_past") {
      await sql`
        INSERT INTO member_program_overrides (email, is_rise_past)
        VALUES (${email}, ${value})
        ON CONFLICT (email) DO UPDATE SET
          is_rise_past = EXCLUDED.is_rise_past
      `;
    } else if (flag === "is_certification") {
      await sql`
        INSERT INTO member_program_overrides (email, is_certification)
        VALUES (${email}, ${value})
        ON CONFLICT (email) DO UPDATE SET
          is_certification = EXCLUDED.is_certification
      `;
    } else if (flag === "is_business_club") {
      await sql`
        INSERT INTO member_program_overrides (email, is_business_club)
        VALUES (${email}, ${value})
        ON CONFLICT (email) DO UPDATE SET
          is_business_club = EXCLUDED.is_business_club
      `;
    } else {
      return res.status(400).json({ error: "invalid_flag", flag });
    }

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
  is_business_club  BOOLEAN NOT NULL DEFAULT false,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by        TEXT
);

-- If the table already exists, add any missing columns:
ALTER TABLE member_program_overrides
  ADD COLUMN IF NOT EXISTS is_newly_engaged BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE member_program_overrides
  ADD COLUMN IF NOT EXISTS is_business_club BOOLEAN NOT NULL DEFAULT false;
*/
