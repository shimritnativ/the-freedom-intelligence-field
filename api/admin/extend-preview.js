// api/admin/extend-preview.js
// Extend a member's Reset preview window by N days. Used by the "Extend
// Preview" action in the admin Members roster — the manual UPDATE we
// used to run in Neon whenever a member emailed asking for another
// window (technical issue, "I paid but haven't opened it yet", etc.).
//
// Sets preview_ends_at = GREATEST(current, NOW()) + INTERVAL 'N days'
// so the extension is always FROM RIGHT NOW, never eating unused
// remaining time. If the member's preview already expired, the new
// window starts fresh from today.
//
// Auth: @shimritnativ.com session OR ADMIN_TOKEN.
//
// POST body: { email: "...", days: 4 }

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

  const adminToken = process.env.ADMIN_TOKEN;
  const providedAdminToken =
    (req.headers && req.headers["x-admin-token"]) || "";
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
  const days = Math.floor(Number(body.days || 0));

  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "invalid_email" });
  }
  if (!Number.isFinite(days) || days < 1 || days > 60) {
    return res.status(400).json({ error: "invalid_days", message: "Days must be between 1 and 60." });
  }

  try {
    // Extend from GREATEST(current preview_ends_at, NOW()). This means:
    //   - If preview still open: new end = old end + N days (extra time)
    //   - If preview already expired: new end = NOW() + N days (fresh window)
    // Either way, the member gets at least N days of usable time from now.
    // Interval interpolated as a string like '4 days' because sql tagged
    // templates don't accept INTERVAL expressions directly.
    const interval = `${days} days`;
    const { rows } = await sql`
      UPDATE users
      SET preview_ends_at = GREATEST(COALESCE(preview_ends_at, NOW()), NOW()) + ${interval}::interval,
          updated_at = NOW()
      WHERE LOWER(email) = ${email}
      RETURNING id, email, tier::text AS tier, preview_ends_at
    `;
    if (rows.length === 0) {
      return res.status(404).json({ error: "user_not_found" });
    }
    const row = rows[0];
    console.log("extend_preview_ok", {
      actor: actorEmail,
      target: email,
      days_added: days,
      new_ends_at: row.preview_ends_at,
    });
    return res.status(200).json({
      ok: true,
      user: {
        email: row.email,
        tier: row.tier,
        preview_ends_at: row.preview_ends_at,
      },
      days_added: days,
    });
  } catch (err) {
    console.error("extend_preview_error", { message: err?.message });
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
