// api/accept-terms.js
//
// Records the current user's acceptance of the Terms & Conditions +
// Privacy Policy shown as a first-login modal on the Field app.
//
// POST → stamps users.terms_accepted_at = NOW() for the session's user.
// GET  → returns { accepted_at: ISO | null } for the current user.
//
// Auth: uses the same session-token flow every other member endpoint
// uses — Kajabi-provisioned + email-code login.
//
// Idempotent: if the user has already accepted, POST simply returns
// the existing timestamp without overwriting it (so the "accepted date"
// reflects the FIRST acceptance, useful for audit / legal).

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../lib/db.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sessionToken = req.headers["x-session-token"];
  const user = await getUserBySessionToken(sessionToken);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  try {
    if (req.method === "GET") {
      // Read-only endpoint used by clients that want to check acceptance
      // status independently of the /state payload.
      return res.status(200).json({
        accepted_at: user.terms_accepted_at || null,
      });
    }

    if (req.method === "POST") {
      // Only stamp if not already stamped — keeps the FIRST acceptance
      // timestamp intact even if the client re-POSTs (e.g., after a
      // refresh before the /state cache reflected the change).
      if (user.terms_accepted_at) {
        return res.status(200).json({
          ok: true,
          accepted_at: user.terms_accepted_at,
          already_accepted: true,
        });
      }
      const { rows } = await sql`
        UPDATE users
        SET terms_accepted_at = NOW(),
            updated_at = NOW()
        WHERE id = ${user.id}
        RETURNING terms_accepted_at
      `;
      return res.status(200).json({
        ok: true,
        accepted_at: rows?.[0]?.terms_accepted_at || null,
        already_accepted: false,
      });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (e) {
    console.error("accept_terms_failed", e);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
}

/*
==============================================================================
ONE-TIME SQL MIGRATION — run in Neon SQL editor before hitting this endpoint.
Idempotent — safe to re-run.
==============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_terms_accepted_at
  ON users (terms_accepted_at)
  WHERE terms_accepted_at IS NULL;
-- Partial index makes "who hasn't accepted yet" queries fast (and stays tiny).
*/
