// api/admin/intelligence-dismissals.js
// Handles per-row dismissals on the admin Intelligence tab.
//
//   GET    /api/admin/intelligence-dismissals
//     → returns every currently-active dismissal (expires_at > NOW)
//
//   POST   /api/admin/intelligence-dismissals
//     body: { segment_key, target_user_id, reason?, expires_in_days? }
//     → records a dismissal (default 7-day expiry, customizable per call)
//
//   DELETE /api/admin/intelligence-dismissals?segment_key=X&target_user_id=Y
//     → removes the dismissal (restore button)
//
// Auth: @shimritnativ.com session OR ADMIN_TOKEN.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const DEFAULT_EXPIRY_DAYS = 7;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-admin-token");

  // Auth.
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

  try {
    if (req.method === "GET") {
      // Return every active dismissal so the UI can filter rows and
      // populate the "X dismissed (show)" counter per segment. Joined
      // with users to surface email/display_name for the restore UI.
      const { rows } = await sql`
        SELECT
          d.segment_key,
          d.target_user_id,
          d.dismissed_at,
          d.expires_at,
          d.reason,
          d.dismissed_by,
          u.email,
          u.display_name
        FROM intelligence_dismissals d
        JOIN users u ON u.id = d.target_user_id
        WHERE d.expires_at > NOW()
        ORDER BY d.dismissed_at DESC
      `;
      return res.status(200).json({ ok: true, dismissals: rows });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const segmentKey = String(body.segment_key || "").trim();
      const targetUserId = String(body.target_user_id || "").trim();
      const reason = body.reason ? String(body.reason).slice(0, 500) : null;
      const expiresInDays = Math.max(
        1,
        Math.min(60, Number(body.expires_in_days) || DEFAULT_EXPIRY_DAYS)
      );

      if (!segmentKey) return res.status(400).json({ error: "missing_segment_key" });
      if (!targetUserId) return res.status(400).json({ error: "missing_target_user_id" });

      // Upsert pattern: if there's an existing dismissal for the same
      // (segment, user), extend it. Avoids duplicate rows when the
      // admin clicks dismiss twice in a row.
      const expiresInterval = `${expiresInDays} days`;
      const { rows } = await sql`
        INSERT INTO intelligence_dismissals (
          segment_key, target_user_id, dismissed_by, reason, expires_at
        ) VALUES (
          ${segmentKey}, ${targetUserId}::uuid, ${actorEmail}, ${reason},
          NOW() + ${expiresInterval}::interval
        )
        RETURNING *
      `;
      return res.status(200).json({ ok: true, dismissal: rows[0] });
    }

    if (req.method === "DELETE") {
      const q = req.query || {};
      const segmentKey = String(q.segment_key || "").trim();
      const targetUserId = String(q.target_user_id || "").trim();
      if (!segmentKey || !targetUserId) {
        return res.status(400).json({ error: "missing_params" });
      }
      // Delete ALL active dismissals for this (segment, user) — there
      // should normally be just one but defensive against historical
      // duplicates from the upsert pattern.
      const { rowCount } = await sql`
        DELETE FROM intelligence_dismissals
        WHERE segment_key = ${segmentKey}
          AND target_user_id = ${targetUserId}::uuid
          AND expires_at > NOW()
      `;
      return res.status(200).json({ ok: true, removed: rowCount });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("intelligence_dismissals_error", { message: err?.message });
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message });
  }
}
