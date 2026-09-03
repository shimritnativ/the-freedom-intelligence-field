// api/admin/grant-workshop-addon.js
// Manually grants the workshop-integration add-on to a specific
// Unlimited (tier='full') member. Written for a small cohort where
// building a full ThriveCart product + webhook flow is overkill —
// Geo enters an email, the endpoint stamps
// workshop_addon_expires_at so the sidebar renders the "Workshop
// Integration Work" dropdown and the API tier gate allows the three
// workshop-integration processes.
//
// Auth: @shimritnativ.com session OR ADMIN_TOKEN.
//
// POST body:
//   {
//     email: "member@example.com",   // required
//     expires_at: "2026-10-02T23:59:59Z" // optional, defaults below
//   }
//
// To revoke, POST with expires_at set to a past date, or run a
// direct UPDATE users SET workshop_addon_expires_at = NULL WHERE ...

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
// Default expiry aligns with the workshop tier's own cutoff so both
// cohorts lose access on the same day.
const DEFAULT_EXPIRES_AT = "2026-10-02T23:59:59Z";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-admin-token");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Auth: admin token OR @shimritnativ.com session.
  const adminToken = process.env.ADMIN_TOKEN;
  const providedAdminToken = (req.headers && req.headers["x-admin-token"]) || "";
  const sessionToken = req.headers["x-session-token"];
  let authorized = false;
  let actorEmail = null;
  if (adminToken && providedAdminToken === adminToken) {
    authorized = true;
    actorEmail = "admin-token";
  } else if (sessionToken) {
    const user = await getUserBySessionToken(sessionToken);
    if (user && (user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
      authorized = true;
      actorEmail = (user.email || "").toLowerCase();
    }
  }
  if (!authorized) return res.status(401).json({ error: "unauthorized" });

  const body = req.body || {};
  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "invalid_email" });
  }

  const expiresAt = String(body.expires_at || DEFAULT_EXPIRES_AT).trim();

  try {
    // Look up the user first so we can return a clear "not found" if
    // the email doesn't match an existing member. This is more useful
    // than a silent 0-row UPDATE that returns "granted" for a typo.
    const { rows: existing } = await sql`
      SELECT id, email, tier, kajabi_entitled
      FROM users
      WHERE email = ${email}
      LIMIT 1
    `;
    if (existing.length === 0) {
      return res.status(404).json({
        error: "user_not_found",
        message: "No user with that email. They need to have logged into The Field at least once before you can grant the add-on.",
      });
    }
    const user = existing[0];

    // Update the add-on expiry. We do NOT change tier — the whole
    // point of the add-on is that Unlimited members KEEP their
    // full-tier access and gain the integration processes on top.
    const { rows: updated } = await sql`
      UPDATE users
      SET workshop_addon_expires_at = ${expiresAt}::timestamptz,
          updated_at = NOW()
      WHERE id = ${user.id}
      RETURNING id, email, tier, workshop_addon_expires_at, updated_at
    `;

    console.log("workshop_addon_granted", {
      email,
      tier: user.tier,
      expires_at: expiresAt,
      granted_by: actorEmail,
    });

    return res.status(200).json({
      ok: true,
      user: updated[0],
      granted_by: actorEmail,
    });
  } catch (err) {
    console.error("grant_workshop_addon_error", { email, message: err?.message });
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message,
    });
  }
}
