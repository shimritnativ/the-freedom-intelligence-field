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
    if (action === "my-subscription") return await handleMySubscription(req, res, user);

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

async function handleMySubscription(req, res, user) {
  // Returns whether the LOGGED-IN user has any active push subscription on
  // the server. Used by the Preferences toggle to show the true state per
  // account — browser-level Notification.permission only tells us about
  // the origin, not which account the subscription is registered to.
  const { rows } = await sql`
    SELECT COUNT(*)::int AS n
    FROM push_subscriptions
    WHERE user_id = ${user.id} AND failed_count < 5
  `;
  const n = rows[0]?.n || 0;
  return res.status(200).json({ hasSubscription: n > 0, deviceCount: n });
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
  // Inbox flag: when true, the message also gets written to the
  // notifications table so members see it in their bell-icon inbox even
  // if they don't have push enabled. Default true — that's the safer
  // setting for the kind of team announcement the admin sends.
  const alsoSaveToInbox = body.alsoSaveToInbox !== false;

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

  // Inbox-only mode: when the caller wants the announcement to land in
  // every member's bell-icon inbox but NOT fire push notifications to any
  // device, they can send with userIds=[] AND alsoSaveToInbox=true. Skip
  // the recipients check and the push loop, just save the inbox row.
  const inboxOnly = userIds.length === 0 && alsoSaveToInbox;
  if (!inboxOnly && userIds.length === 0) {
    return res.status(400).json({ error: "no_recipients" });
  }

  // Write the announcement to the notifications inbox so members without
  // active push subscriptions still see the message. audience='all' for
  // now — future scoping (e.g. only Reset members) can use a different
  // value. We don't filter by userIds here; the inbox is intentionally
  // visible to everyone so members on a fresh device still see history.
  let inboxId = null;
  if (alsoSaveToInbox) {
    try {
      const senderEmail =
        (req.headers["x-admin-sender-email"] && String(req.headers["x-admin-sender-email"])) ||
        null;
      // Optional tap-to-go destination. When set, the Field renders a small
      // gold button at the bottom of the notification card — tapping it
      // navigates to cta_url (internal ?process=X or external https://).
      const ctaUrl = body.ctaUrl ? String(body.ctaUrl).slice(0, 500) : null;
      const ctaLabel = body.ctaLabel ? String(body.ctaLabel).slice(0, 40) : null;
      const ins = await sql`
        INSERT INTO notifications (title, body, audience, sent_by_email, cta_url, cta_label)
        VALUES (${payload.title}, ${payload.body || ""}, 'all', ${senderEmail}, ${ctaUrl}, ${ctaLabel})
        RETURNING id
      `;
      inboxId = ins.rows[0]?.id || null;
    } catch (err) {
      // Don't fail the push if the inbox write fails — log it and continue.
      console.warn("inbox_insert_failed", { message: err?.message });
    }
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
    inboxId,
    savedToInbox: alsoSaveToInbox && !!inboxId,
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
