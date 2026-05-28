// api/state.js
// Returns the current state for the authenticated user. Used by the embed
// on initial render and on reload, so the UI knows which day, how much time
// remains, whether to show the expired view, and the full message history.

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const token = req.headers["x-session-token"];
    const user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const session = await getOrCreateSession(user.id);
    const messages = await fetchConversation(session.id);

    return res.status(200).json({
      currentDay: resolveActiveDay(user),
      timeRemainingMs: timeRemainingMs(user),
      tier: user.tier,
      lastCompletedDay: user.last_completed_day,
      dayUnlocks: buildDayUnlocks(user),
      firstLoginAt: user.first_login_at,
      previewEndsAt: user.preview_ends_at,
      displayName: user.display_name || null,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });
  } catch (err) {
    console.error("state_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
