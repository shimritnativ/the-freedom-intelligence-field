// api/unlimited/session.js
// Fetch a single Unlimited session's messages for loading a past chat.
// Accepts ?id=<session-uuid> as query param.

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const token = req.headers["x-session-token"];
    const user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const sessionId = req.query.id;
    if (!sessionId) return res.status(400).json({ error: "missing_session_id" });

    // Verify the session belongs to this user.
    const { rows: sessionRows } = await sql`
      SELECT id, title, started_at, last_message_at, metadata
      FROM sessions
      WHERE id = ${sessionId}
        AND user_id = ${user.id}
        AND session_type = 'unlimited'
      LIMIT 1
    `;
    if (sessionRows.length === 0) {
      return res.status(404).json({ error: "session_not_found" });
    }
    const session = sessionRows[0];

    // Load the message history.
    const { rows: messageRows } = await sql`
      SELECT id, role, content, created_at
      FROM messages
      WHERE session_id = ${sessionId}
      ORDER BY created_at ASC
      LIMIT 500
    `;

    return res.status(200).json({
      session: {
        id: session.id,
        title: session.title || "New chat",
        startedAt: session.started_at,
        lastMessageAt: session.last_message_at,
        metadata: session.metadata || {},
      },
      messages: messageRows.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    console.error("unlimited_session_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
