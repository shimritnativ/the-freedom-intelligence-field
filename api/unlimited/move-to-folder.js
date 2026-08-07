// api/unlimited/move-to-folder.js
//
// Move an Unlimited chat session into a folder (or remove it from all
// folders). Auth-scoped to the current user — you can only move your
// own sessions into your own folders.
//
// POST body:
//   { sessionId: "<uuid>", folderId: "<uuid>" | null }
//
// folderId === null → chat is uncategorized (folder_id = NULL).

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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const token = req.headers["x-session-token"];
    const user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    if (user.tier !== "full" && user.kajabi_entitled === true) {
      return res.status(403).json({ error: "unlimited_locked" });
    }

    const sessionId = String((req.body && req.body.sessionId) || "").trim();
    const rawFolderId = req.body && req.body.folderId;
    const folderId = rawFolderId ? String(rawFolderId).trim() : null;
    if (!sessionId) return res.status(400).json({ error: "session_id_required" });

    // If a folder is specified, verify the caller owns it — otherwise
    // someone could move their session into another user's folder.
    if (folderId) {
      const { rows: fRows } = await sql`
        SELECT id FROM folders
        WHERE id = ${folderId}::uuid AND user_id = ${user.id}
        LIMIT 1
      `;
      if (fRows.length === 0) return res.status(404).json({ error: "folder_not_found" });
    }

    // Move only if the session belongs to this user AND is an Unlimited
    // chat (folders don't apply to Reset sessions).
    const { rowCount } = folderId
      ? await sql`
          UPDATE sessions
          SET folder_id = ${folderId}::uuid
          WHERE id = ${sessionId}::uuid
            AND user_id = ${user.id}
            AND session_type = 'unlimited'
        `
      : await sql`
          UPDATE sessions
          SET folder_id = NULL
          WHERE id = ${sessionId}::uuid
            AND user_id = ${user.id}
            AND session_type = 'unlimited'
        `;
    if (rowCount === 0) return res.status(404).json({ error: "session_not_found" });
    return res.status(200).json({ ok: true, sessionId, folderId });
  } catch (err) {
    console.error("move_to_folder_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
