// api/admin/update-member-name.js
// Set the display_name on a member's user record. Used by the inline
// edit on the admin roster — click a name, type the correct one, save.
// Solves the "Mikesheridan" problem where Kajabi-only signups show the
// email-prefix as a fallback name until ThriveCart fires a webhook
// with the real first+last.
//
// Auth: @shimritnativ.com session OR ADMIN_TOKEN.
//
// POST body: { email: "...", display_name: "Michael Sheridan" }

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-admin-token");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Auth.
  const adminToken = process.env.ADMIN_TOKEN;
  const providedAdminToken =
    (req.headers && req.headers["x-admin-token"]) || "";
  const sessionToken = req.headers["x-session-token"];
  let authorized = false;
  if (adminToken && providedAdminToken === adminToken) {
    authorized = true;
  } else if (sessionToken) {
    const user = await getUserBySessionToken(sessionToken);
    if (user && (user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
      authorized = true;
    }
  }
  if (!authorized) return res.status(401).json({ error: "unauthorized" });

  const body = req.body || {};
  const email = String(body.email || "").trim().toLowerCase();
  const displayName = String(body.display_name || "").trim();

  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "invalid_email" });
  }
  if (!displayName || displayName.length < 1 || displayName.length > 120) {
    return res.status(400).json({ error: "invalid_display_name" });
  }

  try {
    const { rows } = await sql`
      UPDATE users
      SET display_name = ${displayName}, updated_at = NOW()
      WHERE email = ${email}
      RETURNING id, email, display_name
    `;
    if (rows.length === 0) {
      return res.status(404).json({ error: "user_not_found" });
    }
    return res.status(200).json({ ok: true, user: rows[0] });
  } catch (err) {
    console.error("update_member_name_error", { message: err?.message });
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
