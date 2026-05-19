// api/unlimited/sessions.js
// List a user's Unlimited chat sessions (most recent first).
// Used by the sidebar to render the chat history list.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

function applyCors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!origin && process.env.NODE_ENV !== "production") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const token = req.headers["x-session-token"];
    const user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    if (req.method === "GET") {
      // List the user's Unlimited sessions, most recent first.
      const { rows } = await sql`
        SELECT
          id,
          title,
          started_at,
          last_message_at,
          metadata
        FROM sessions
        WHERE user_id = ${user.id} AND session_type = 'unlimited'
        ORDER BY COALESCE(last_message_at, started_at) DESC
        LIMIT 100
      `;
      return res.status(200).json({
        sessions: rows.map((r) => ({
          id: r.id,
          title: r.title || "New chat",
          startedAt: r.started_at,
          lastMessageAt: r.last_message_at,
          metadata: r.metadata || {},
        })),
      });
    }

    if (req.method === "POST") {
      // Create a new Unlimited session.
      const { rows } = await sql`
        INSERT INTO sessions (user_id, session_type, title)
        VALUES (${user.id}, 'unlimited', 'New chat')
        RETURNING id, title, started_at, last_message_at, metadata
      `;
      const row = rows[0];
      return res.status(200).json({
        session: {
          id: row.id,
          title: row.title,
          startedAt: row.started_at,
          lastMessageAt: row.last_message_at,
          metadata: row.metadata || {},
        },
      });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("unlimited_sessions_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
