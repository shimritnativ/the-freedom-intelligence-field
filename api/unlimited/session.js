// api/unlimited/session.js
// Read, rename, pin/unpin, or delete a single Unlimited session.
//
//   GET    /api/unlimited/session?id=<uuid>     -> session + messages
//   PATCH  /api/unlimited/session?id=<uuid>     -> rename or pin/unpin
//                  body: { title?: string, pin?: true|false }
//   DELETE /api/unlimited/session?id=<uuid>     -> permanently delete
//
// Tier-gated to Unlimited members. Demo accounts (kajabi_entitled=false)
// bypass the gate so testing still works.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

// Hard cap on simultaneously pinned chats. If a customer tries to pin a 6th
// chat, the API returns 409 pin_limit_reached and the UI surfaces a tooltip
// telling them to unpin one first. Five is generous for most users without
// turning the pinned section into a second chat list.
const PIN_LIMIT = 5;

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
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const token = req.headers["x-session-token"];
    const user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    // Tier gate: real Kajabi members on preview tier blocked; anonymous
    // demo accounts (kajabi_entitled = false) bypass so demo testing works.
    if (user.tier !== "full" && user.kajabi_entitled === true) {
      return res.status(403).json({ error: "unlimited_locked" });
    }

    const sessionId = req.query.id;
    if (!sessionId) return res.status(400).json({ error: "missing_session_id" });

    // All three verbs need ownership confirmed first. One lookup, three
    // branches — keeps the auth check in one place and prevents cross-user
    // tampering via guessed UUIDs.
    const { rows: ownershipRows } = await sql`
      SELECT id, title, started_at, last_message_at, metadata, pinned_at
        FROM sessions
       WHERE id = ${sessionId}
         AND user_id = ${user.id}
         AND session_type = 'unlimited'
       LIMIT 1
    `;
    if (ownershipRows.length === 0) {
      return res.status(404).json({ error: "session_not_found" });
    }
    const ownedSession = ownershipRows[0];

    // ===== GET: full session + messages =====
    if (req.method === "GET") {
      const { rows: messageRows } = await sql`
        SELECT id, role, content, created_at
          FROM messages
         WHERE session_id = ${sessionId}
         ORDER BY created_at ASC
         LIMIT 500
      `;
      return res.status(200).json({
        session: serializeSession(ownedSession),
        messages: messageRows.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
        })),
      });
    }

    // ===== PATCH: rename or pin/unpin =====
    if (req.method === "PATCH") {
      const body = req.body || {};
      const hasTitle = typeof body.title === "string";
      const hasPin = typeof body.pin === "boolean";

      if (!hasTitle && !hasPin) {
        return res.status(400).json({ error: "no_changes_provided" });
      }

      // RENAME path
      if (hasTitle) {
        const trimmed = body.title.trim();
        if (trimmed.length === 0) {
          return res.status(400).json({ error: "title_empty" });
        }
        if (trimmed.length > 200) {
          return res.status(400).json({ error: "title_too_long" });
        }
        const { rows } = await sql`
          UPDATE sessions
             SET title = ${trimmed}
           WHERE id = ${sessionId}
             AND user_id = ${user.id}
           RETURNING id, title, started_at, last_message_at, metadata, pinned_at
        `;
        return res.status(200).json({ session: serializeSession(rows[0]) });
      }

      // PIN / UNPIN path
      if (hasPin) {
        if (body.pin === true) {
          // Enforce the 5-pin cap. Counts pins OTHER than this session so
          // re-pinning an already-pinned chat is a no-op rather than an
          // off-by-one error.
          const { rows: pinCount } = await sql`
            SELECT COUNT(*)::int AS count
              FROM sessions
             WHERE user_id = ${user.id}
               AND session_type = 'unlimited'
               AND pinned_at IS NOT NULL
               AND id <> ${sessionId}
          `;
          if (pinCount[0].count >= PIN_LIMIT) {
            return res.status(409).json({
              error: "pin_limit_reached",
              limit: PIN_LIMIT,
            });
          }
          const { rows } = await sql`
            UPDATE sessions
               SET pinned_at = NOW()
             WHERE id = ${sessionId}
               AND user_id = ${user.id}
             RETURNING id, title, started_at, last_message_at, metadata, pinned_at
          `;
          return res.status(200).json({ session: serializeSession(rows[0]) });
        } else {
          // body.pin === false → unpin
          const { rows } = await sql`
            UPDATE sessions
               SET pinned_at = NULL
             WHERE id = ${sessionId}
               AND user_id = ${user.id}
             RETURNING id, title, started_at, last_message_at, metadata, pinned_at
          `;
          return res.status(200).json({ session: serializeSession(rows[0]) });
        }
      }
    }

    // ===== DELETE: permanently remove session + messages =====
    if (req.method === "DELETE") {
      // Messages have ON DELETE CASCADE to sessions, so deleting the parent
      // row drops the full conversation history. If that constraint ever
      // changes, this will leave orphaned messages — flag for revisit.
      await sql`
        DELETE FROM sessions
         WHERE id = ${sessionId}
           AND user_id = ${user.id}
      `;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("unlimited_session_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}

function serializeSession(row) {
  return {
    id: row.id,
    title: row.title || "New chat",
    startedAt: row.started_at,
    lastMessageAt: row.last_message_at,
    metadata: row.metadata || {},
    pinnedAt: row.pinned_at,
  };
}
