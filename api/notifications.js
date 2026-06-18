// api/notifications.js
// Notifications inbox endpoint. Lets a logged-in member fetch every team
// announcement they're allowed to see, with a flag for whether they've
// already opened it, and lets them mark the whole list as read when they
// open the inbox panel.
//
// Endpoints:
//   GET  /api/notifications              → list notifications + unreadCount
//   POST /api/notifications?action=mark-all-read → mark every visible row
//
// Auth: x-session-token header (the member themselves).

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../lib/db.js";

const ADMIN_DOMAIN = "@shimritnativ.com";

function isAdmin(user) {
  return !!user && (user.email || "").toLowerCase().endsWith(ADMIN_DOMAIN);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");

  const token = req.headers["x-session-token"];
  const user = await getUserBySessionToken(token);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  try {
    const action = (req.query && req.query.action) || "";

    // ===== Admin-only actions =====
    if (action === "admin-list") {
      if (!isAdmin(user)) return res.status(403).json({ error: "forbidden" });
      const { rows } = await sql`
        SELECT n.id, n.title, n.body, n.created_at, n.sent_by_email, n.audience,
          n.cta_url, n.cta_label,
          (SELECT COUNT(*)::int FROM notification_reads nr WHERE nr.notification_id = n.id) AS read_count
        FROM notifications n
        ORDER BY n.created_at DESC
        LIMIT 50
      `;
      return res.status(200).json({ notifications: rows });
    }
    if (action === "admin-delete") {
      if (!isAdmin(user)) return res.status(403).json({ error: "forbidden" });
      if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
      const id = (req.body && req.body.id) || (req.query && req.query.id) || "";
      if (!id) return res.status(400).json({ error: "missing_id" });
      // ON DELETE CASCADE on notification_reads handles the read records.
      await sql`DELETE FROM notifications WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === "GET") {
      // Pull the latest 50 announcements the user is allowed to see.
      // LEFT JOIN to notification_reads so we can flag which are unread
      // without two queries.
      const { rows } = await sql`
        SELECT
          n.id,
          n.title,
          n.body,
          n.created_at,
          n.cta_url,
          n.cta_label,
          (nr.read_at IS NOT NULL) AS is_read
        FROM notifications n
        LEFT JOIN notification_reads nr
          ON nr.notification_id = n.id AND nr.user_id = ${user.id}
        WHERE n.audience = 'all'
        ORDER BY n.created_at DESC
        LIMIT 50
      `;
      const unreadCount = rows.filter(r => !r.is_read).length;
      return res.status(200).json({ notifications: rows, unreadCount });
    }

    if (req.method === "POST") {
      const action = (req.query && req.query.action) || "";
      if (action === "mark-all-read") {
        // Insert a read marker for every notification the user is allowed
        // to see. Existing markers stay untouched (ON CONFLICT).
        await sql`
          INSERT INTO notification_reads (notification_id, user_id)
          SELECT n.id, ${user.id}
          FROM notifications n
          WHERE n.audience = 'all'
          ON CONFLICT (notification_id, user_id) DO NOTHING
        `;
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: "unknown_action" });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("notifications_error", { message: err?.message });
    return res.status(500).json({ error: "server_error" });
  }
}
