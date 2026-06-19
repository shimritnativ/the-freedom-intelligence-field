// api/admin/launch-tracker-state.js
// Shared launch tracker state. Two methods:
//   GET  /api/admin/launch-tracker-state   → current state + who last saved
//   POST /api/admin/launch-tracker-state   → replace state with body.state
//
// Auth: @shimritnativ.com session only.
//
// POST body shape:
//   { state: { "launch-people": "5000", ... } }
//
// The endpoint stores the whole state blob. We do not merge — the client
// always sends the full state it knows about, so a partial post would
// silently drop fields. Send-everything is safer and the payload is tiny
// (~50 fields, each a short numeric string).
//
// Why not patch? Two admins editing at the same time would lose each
// other's writes either way without versioning. The launch tracker is
// used by 1-2 people occasionally, so last-write-wins is acceptable.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

function isAdmin(user) {
  return !!user && (user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");

  const token = req.headers["x-session-token"];
  const user = await getUserBySessionToken(token);
  if (!isAdmin(user)) return res.status(403).json({ error: "forbidden" });

  try {
    if (req.method === "GET") {
      const { rows } = await sql`
        SELECT state, updated_by_email, updated_at
        FROM launch_tracker_state
        WHERE id = 'singleton'
        LIMIT 1
      `;
      const row = rows[0] || { state: {}, updated_by_email: null, updated_at: null };
      return res.status(200).json({
        state: row.state || {},
        updated_by_email: row.updated_by_email || null,
        updated_at: row.updated_at || null,
      });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const state = (body.state && typeof body.state === "object") ? body.state : null;
      if (!state) {
        return res.status(400).json({ error: "missing_state" });
      }
      const senderEmail = (user.email || "").toLowerCase();

      // Singleton upsert. INSERT will hit the conflict on every call after
      // the migration's seed row, so this effectively becomes UPDATE.
      const { rows } = await sql`
        INSERT INTO launch_tracker_state (id, state, updated_by_email, updated_at)
        VALUES ('singleton', ${JSON.stringify(state)}::jsonb, ${senderEmail}, NOW())
        ON CONFLICT (id) DO UPDATE SET
          state = EXCLUDED.state,
          updated_by_email = EXCLUDED.updated_by_email,
          updated_at = NOW()
        RETURNING state, updated_by_email, updated_at
      `;
      const row = rows[0];
      return res.status(200).json({
        ok: true,
        state: row.state || {},
        updated_by_email: row.updated_by_email || null,
        updated_at: row.updated_at || null,
      });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("launch_tracker_state_error", { message: err?.message });
    return res.status(500).json({ error: "server_error" });
  }
}
