// api/folders.js
//
// User-created folders for organizing Unlimited chats.
//
// GET     → list all folders for the current user + how many chats each
//           holds, ordered by sort_order then created_at.
// POST    → create a new folder. Body: { name }
// PATCH   → rename a folder. Body: { id, name }
// DELETE  → remove a folder. Body: { id }. Chats inside are gently
//           uncategorized (folder_id set to NULL) via ON DELETE SET NULL.
//
// Auth: standard x-session-token. Tier-gated to Unlimited (full) since
// only Unlimited members have chat history to organize. Anonymous demo
// accounts also allowed for testing.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../lib/db.js";

const MAX_NAME_LEN = 60;
const MAX_FOLDERS_PER_USER = 40;

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
}

function sanitizeName(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LEN);
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = req.headers["x-session-token"];
  const user = await getUserBySessionToken(token);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  // Tier gate: same as unlimited/sessions.js — only Unlimited members
  // (or anonymous demo accounts) can use folders.
  if (user.tier !== "full" && user.kajabi_entitled === true) {
    return res.status(403).json({ error: "unlimited_locked" });
  }

  try {
    // ---------- GET: list ----------
    if (req.method === "GET") {
      const { rows } = await sql`
        SELECT
          f.id,
          f.name,
          f.sort_order,
          f.created_at,
          COUNT(s.id) AS chat_count
        FROM folders f
        LEFT JOIN sessions s
          ON s.folder_id = f.id
          AND s.user_id = f.user_id
          AND s.session_type = 'unlimited'
        WHERE f.user_id = ${user.id}
        GROUP BY f.id
        ORDER BY f.sort_order ASC, f.created_at ASC
      `;
      return res.status(200).json({
        folders: rows.map((r) => ({
          id: r.id,
          name: r.name,
          sortOrder: r.sort_order,
          createdAt: r.created_at,
          chatCount: Number(r.chat_count) || 0,
        })),
      });
    }

    // ---------- POST: create ----------
    if (req.method === "POST") {
      const name = sanitizeName(req.body && req.body.name);
      if (!name) return res.status(400).json({ error: "name_required" });

      // Cap folders per user so a runaway loop can't fill the table.
      const { rows: countRows } = await sql`
        SELECT COUNT(*)::int AS n FROM folders WHERE user_id = ${user.id}
      `;
      if ((countRows[0]?.n || 0) >= MAX_FOLDERS_PER_USER) {
        return res.status(400).json({
          error: "folder_limit_reached",
          message: `You've reached the ${MAX_FOLDERS_PER_USER}-folder limit.`,
        });
      }

      // Next sort_order = max + 1 so new folders land at the bottom
      // by default. Members can reorder later if we build that.
      const { rows: sortRows } = await sql`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort
        FROM folders WHERE user_id = ${user.id}
      `;
      const nextSort = sortRows[0]?.next_sort || 0;

      const { rows } = await sql`
        INSERT INTO folders (user_id, name, sort_order)
        VALUES (${user.id}, ${name}, ${nextSort})
        RETURNING id, name, sort_order, created_at
      `;
      const f = rows[0];
      return res.status(200).json({
        folder: {
          id: f.id,
          name: f.name,
          sortOrder: f.sort_order,
          createdAt: f.created_at,
          chatCount: 0,
        },
      });
    }

    // ---------- PATCH: rename ----------
    if (req.method === "PATCH") {
      const id = String((req.body && req.body.id) || "").trim();
      const name = sanitizeName(req.body && req.body.name);
      if (!id) return res.status(400).json({ error: "id_required" });
      if (!name) return res.status(400).json({ error: "name_required" });

      const { rowCount } = await sql`
        UPDATE folders
        SET name = ${name}, updated_at = NOW()
        WHERE id = ${id}::uuid AND user_id = ${user.id}
      `;
      if (rowCount === 0) return res.status(404).json({ error: "not_found" });
      return res.status(200).json({ ok: true });
    }

    // ---------- DELETE: remove folder (chats inside are uncategorized) ----------
    if (req.method === "DELETE") {
      const id = String((req.body && req.body.id) || "").trim();
      if (!id) return res.status(400).json({ error: "id_required" });

      const { rowCount } = await sql`
        DELETE FROM folders
        WHERE id = ${id}::uuid AND user_id = ${user.id}
      `;
      if (rowCount === 0) return res.status(404).json({ error: "not_found" });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("folders_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
