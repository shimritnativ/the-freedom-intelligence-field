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

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");

  const token = req.headers["x-session-token"];
  const user = await getUserBySessionToken(token);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  try {
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
