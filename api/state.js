// api/state.js
// GET: returns the current state for the authenticated user. Used by the embed
//   on initial render and on reload, so the UI knows which day, how much time
//   remains, whether to show the expired view, and the full message history.
// POST: updates mutable account fields (currently just display_name) and
//   returns the same state payload. Used by the Your Account modal's name save
//   so we don't need a separate /api/account endpoint (saves a Vercel function
//   slot under the 12-function Hobby limit).

import { sql } from "@vercel/postgres";
import {
  getUserBySessionToken,
  getOrCreateSession,
  fetchConversation,
  resolveActiveDay,
  timeRemainingMs,
  buildDayUnlocks,
} from "../lib/db.js";

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
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const token = req.headers["x-session-token"];
    let user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    // POST: apply the mutation, then fall through to the GET response so the
    // client gets the updated state in one round trip. Currently only
    // display_name is mutable here; add new fields as needed.
    if (req.method === "POST") {
      const body = (req.body && typeof req.body === "object") ? req.body : {};
      if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
        const raw = body.displayName;
        const sanitized = (raw == null)
          ? null
          : String(raw).trim().slice(0, 80) || null;
        const { rows } = await sql`
          UPDATE users
             SET display_name = ${sanitized}, updated_at = NOW()
           WHERE id = ${user.id}
           RETURNING *
        `;
        if (rows[0]) user = rows[0];
      }
    }

    const session = await getOrCreateSession(user.id);
    const messages = await fetchConversation(session.id);

    return res.status(200).json({
      currentDay: resolveActiveDay(user),
      timeRemainingMs: timeRemainingMs(user),
      tier: user.tier,
      subscriptionPlan: user.subscription_plan || null,
      lastCompletedDay: user.last_completed_day,
      dayUnlocks: buildDayUnlocks(user),
      firstLoginAt: user.first_login_at,
      previewEndsAt: user.preview_ends_at,
      displayName: user.display_name || null,
      email: user.email,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        dayAtSend: m.day_at_send,
      })),
    });
  } catch (err) {
    console.error("state_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
