// api/push.js
// Push notification endpoint. Consolidates four actions into one file to
// minimize Vercel function count:
//
//   POST /api/push?action=public-key   -> returns VAPID public key (for JS)
//   POST /api/push?action=subscribe    -> stores a push subscription
//   POST /api/push?action=unsubscribe  -> removes a push subscription
//   POST /api/push?action=test         -> fires a test notification to self
//   POST /api/push?action=reminders    -> cron-triggered reminder dispatcher
//
// Auth:
//   - public-key: no auth (it's public)
//   - subscribe, unsubscribe, test: x-session-token (the user themselves)
//   - reminders: Vercel-cron User-Agent OR ADMIN_TOKEN

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../lib/db.js";
import {
  getVapidPublicKey,
  saveSubscription,
  sendPushToUser,
  runReminders,
  REMINDER_COPY,
} from "../lib/push.js";

const ALLOWED_ADMIN_DOMAIN = "@shimritnativ.com";

// Shared admin gate. Accepts either:
//   - A Field session token belonging to a @shimritnativ.com member
//   - An ADMIN_TOKEN (header or query param) for scripts/cron
async function isAdmin(req) {
  const sessionToken = req.headers["x-session-token"];
  if (sessionToken) {
    const user = await getUserBySessionToken(sessionToken);
    if (user && (user.email || "").toLowerCase().endsWith(ALLOWED_ADMIN_DOMAIN)) {
      return true;
    }
  }
  const adminToken = process.env.ADMIN_TOKEN;
  const provided =
    (req.headers && req.headers["x-admin-token"]) ||
    (req.query && req.query.token) ||
    "";
  if (adminToken && provided === adminToken) return true;
  return false;
}

export const config = {
  maxDuration: 300, // reminders cron can take a while
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-admin-token");

  const action = (req.query && req.query.action) || "";

  try {
    if (action === "public-key") {
      return handlePublicKey(req, res);
    }
    if (action === "reminders") {
      return await handleReminders(req, res);
    }

    // Admin-only actions — accept session-token-with-domain OR admin token,
    // dispatched before the regular user-session gate below.
    if (action === "subscribers") {
      if (!(await isAdmin(req))) return res.status(401).json({ error: "unauthorized" });
      return await handleListSubscribers(req, res);
    }
    if (action === "send") {
      if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
      if (!(await isAdmin(req))) return res.status(401).json({ error: "unauthorized" });
      return await handleSend(req, res);
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "method_not_allowed" });
    }

    const token = req.headers["x-session-token"];
    const user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    if (action === "subscribe") return await handleSubscribe(req, res, user);
    if (action === "unsubscribe") return await handleUnsubscribe(req, res, user);
    if (action === "test") return await handleTest(req, res, user);

    return res.status(400).json({ error: "unknown_action" });
  } catch (err) {
    console.error("push_error", { action, message: err?.message });
    return res.status(500).json({ error: "server_error", message: err?.message });
  }
}

function handlePublicKey(req, res) {
  const key = getVapidPublicKey();
  if (!key) {
    return res.status(500).json({ error: "vapid_not_configured" });
  }
  return res.status(200).json({ publicKey: key });
}

async function handleSubscribe(req, res, user) {
  const body = req.body || {};
  if (!body.subscription) return res.status(400).json({ error: "missing_subscription" });
  await saveSubscription({
    userId: user.id,
    subscription: body.subscription,
    userAgent: req.headers["user-agent"] || null,
  });
  return res.status(200).json({ ok: true });
}

async function handleUnsubscribe(req, res, user) {
  const body = req.body || {};
  const endpoint = body.endpoint || null;
  if (endpoint) {
    await sql`
      DELETE FROM push_subscriptions
      WHERE user_id = ${user.id} AND endpoint = ${endpoint}
    `;
  } else {
    await sql`DELETE FROM push_subscriptions WHERE user_id = ${user.id}`;
  }
  return res.status(200).json({ ok: true });
}

async function handleTest(req, res, user) {
  // Optional `key` param selects which reminder copy to send. Use to
  // preview the exact production notifications from the admin dashboard
  // without waiting for the cron schedule. Falls back to a generic test
  // when key is missing or unrecognized.
  const key = (req.query && req.query.key) || "";
  const payload = REMINDER_COPY[key] || {
    title: "Test notification from The Field",
    body: "If you see this, notifications are working. 🌿",
  };
  const result = await sendPushToUser({ userId: user.id, payload });
  return res.status(200).json({ ok: true, key: key || "generic", ...result });
}

async function handleListSubscribers(req, res) {
  const { rows } = await sql`
    SELECT
      u.id,
      u.email,
      u.display_name,
      u.tier::text AS tier,
      COUNT(ps.id)::int AS devices,
      MAX(ps.last_sent_at) AS last_sent
    FROM users u
    JOIN push_subscriptions ps ON ps.user_id = u.id
    WHERE ps.failed_count < 5
    GROUP BY u.id, u.email, u.display_name, u.tier
    ORDER BY u.email
  `;
  return res.status(200).json({ subscribers: rows });
}

async function handleSend(req, res) {
  const body = req.body || {};
  const userIds = Array.isArray(body.userIds) ? body.userIds : [];
  const key = String(body.key || "").trim();
  const custom = body.payload && typeof body.payload === "object" ? body.payload : null;

  // Build the notification payload. Either an existing reminder key OR a
  // custom payload from the admin form. Custom needs at least a title.
  let payload;
  if (custom && custom.title) {
    payload = { title: String(custom.title).slice(0, 80), body: String(custom.body || "").slice(0, 300) };
  } else if (key && REMINDER_COPY[key]) {
    payload = REMINDER_COPY[key];
  } else {
    return res.status(400).json({ error: "missing_payload" });
  }

  if (userIds.length === 0) {
    return res.status(400).json({ error: "no_recipients" });
  }

  let totalSent = 0;
  let usersReached = 0;
  let usersWithNoDevices = 0;
  const failures = [];

  for (const userId of userIds) {
    try {
      const r = await sendPushToUser({ userId, payload });
      if (r.sent > 0) {
        totalSent += r.sent;
        usersReached++;
      } else if (r.no_subscriptions) {
        usersWithNoDevices++;
      }
    } catch (err) {
      failures.push({ userId, error: err?.message });
    }
  }

  return res.status(200).json({
    ok: true,
    totalSent,
    usersReached,
    usersWithNoDevices,
    failures,
  });
}

async function handleReminders(req, res) {
  // Authorize: Vercel cron User-Agent OR ADMIN_TOKEN.
  const userAgent = String(req.headers["user-agent"] || "");
  const isVercelCron = userAgent.includes("vercel-cron");
  const adminToken = process.env.ADMIN_TOKEN;
  const providedAdminToken =
    (req.headers && req.headers["x-admin-token"]) ||
    (req.query && req.query.token) ||
    "";
  const authorized =
    isVercelCron || (adminToken && providedAdminToken === adminToken);
  if (!authorized) return res.status(401).json({ error: "unauthorized" });

  const stats = await runReminders();
  return res.status(200).json({ ok: true, ...stats });
}
