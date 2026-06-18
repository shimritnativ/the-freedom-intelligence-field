// lib/push.js
// Web Push helpers. Sends notifications to subscribed members via the
// Web Push protocol (works on iOS 16.4+ installed PWAs, Android Chrome,
// and all desktop browsers). Wraps the `web-push` library with our
// subscription storage and dedup logic.
//
// Environment variables required:
//   VAPID_PUBLIC_KEY    — public key (also exposed to the client)
//   VAPID_PRIVATE_KEY   — private key (kept server-side)
//   VAPID_SUBJECT       — contact mailto: or https: URL, e.g. mailto:support@shimritnativ.com

import webpush from "web-push";
import { sql } from "@vercel/postgres";

// One-time configuration. Throws if VAPID env vars are missing — callers
// catch and surface a clean error to the user.
function configure() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:support@shimritnativ.com";
  if (!publicKey || !privateKey) {
    throw new Error("VAPID keys not configured");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

/**
 * Save (or upsert) a push subscription for a user. Multiple subscriptions per
 * user are allowed — one per device. ON CONFLICT updates timestamps so the
 * same device re-subscribing doesn't create duplicates.
 */
export async function saveSubscription({ userId, subscription, userAgent }) {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error("invalid_subscription");
  }
  const { endpoint } = subscription;
  const { p256dh, auth } = subscription.keys;
  await sql`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    VALUES (${userId}, ${endpoint}, ${p256dh}, ${auth}, ${userAgent || null})
    ON CONFLICT (endpoint) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      user_agent = EXCLUDED.user_agent,
      failed_count = 0
  `;
}

/**
 * Remove a subscription by endpoint. Called when the browser tells us the
 * subscription is no longer valid (HTTP 410 from the push service).
 */
async function deleteSubscriptionByEndpoint(endpoint) {
  await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`;
}

/**
 * Send a notification to one specific subscription. Handles cleanup if the
 * subscription is expired/invalid.
 */
async function sendToSubscription(subscription, payload) {
  try {
    configure();
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      { TTL: 60 * 60 * 24 }
    );
    await sql`
      UPDATE push_subscriptions
      SET last_sent_at = NOW(), failed_count = 0
      WHERE id = ${subscription.id}
    `;
    return { ok: true };
  } catch (err) {
    const status = err.statusCode || 0;
    console.warn("push_send_failed", { endpoint: subscription.endpoint, status, message: err.message });
    if (status === 404 || status === 410) {
      // Subscription is gone — push services return 410 when the user
      // uninstalled the PWA or revoked permissions.
      await deleteSubscriptionByEndpoint(subscription.endpoint);
      return { ok: false, gone: true };
    }
    await sql`
      UPDATE push_subscriptions
      SET failed_count = failed_count + 1
      WHERE id = ${subscription.id}
    `;
    return { ok: false, error: err.message };
  }
}

/**
 * Send a notification to all of a user's subscribed devices. Tracks dedup
 * via push_notifications_sent — if `notificationKey` is provided and the
 * user has already received this notification type, this is a no-op.
 *
 * Returns the count of devices the notification was successfully sent to.
 */
export async function sendPushToUser({ userId, payload, notificationKey }) {
  if (notificationKey) {
    const { rows: already } = await sql`
      SELECT 1 FROM push_notifications_sent
      WHERE user_id = ${userId} AND notification_key = ${notificationKey}
      LIMIT 1
    `;
    if (already.length > 0) return { sent: 0, deduped: true };
  }

  const { rows: subs } = await sql`
    SELECT id, endpoint, p256dh, auth
    FROM push_subscriptions
    WHERE user_id = ${userId} AND failed_count < 5
  `;

  if (subs.length === 0) return { sent: 0, no_subscriptions: true };

  let sent = 0;
  for (const sub of subs) {
    const result = await sendToSubscription(sub, payload);
    if (result.ok) sent++;
  }

  if (sent > 0 && notificationKey) {
    await sql`
      INSERT INTO push_notifications_sent (user_id, notification_key)
      VALUES (${userId}, ${notificationKey})
      ON CONFLICT (user_id, notification_key) DO NOTHING
    `;
  }

  return { sent };
}

// ===== Reminder logic =====
//
// Reminder schedule for preview-tier (72-Hour Power Reset) members. All
// times are relative to the user's first_login_at (when their 4-day window
// started). Each reminder fires at most once per user.
//
//   day2_unlocked   first_login + 24h    "Day 2 is unlocked"
//   day2_nudge      first_login + 30h    "Don't forget Day 2"  (if d1 done, d2 not started)
//   day3_unlocked   first_login + 48h    "Day 3 is unlocked"
//   day3_nudge      first_login + 54h    "Don't forget Day 3"  (if d2 done, d3 not started)
//   window_closing  first_login + 84h    "12 hours left"       (if d3 not done)

export const REMINDER_COPY = {
  day2_unlocked: {
    title: "Day 2 is open ✨",
    body: "Your Day 1 work is done. Day 2 — Decision and Action Alignment — is ready when you are.",
  },
  day2_nudge: {
    title: "Day 2 is waiting",
    body: "You started yesterday. The clarity from Day 1 deepens when Day 2 lands today.",
  },
  day3_unlocked: {
    title: "Day 3 is open ✨",
    body: "The peak of your Reset. Today the Field takes you inside the frequency of what you decided.",
  },
  day3_nudge: {
    title: "Day 3 is waiting",
    body: "The frequency calibration is the last piece. Show up today.",
  },
  window_closing: {
    title: "Your Reset window closes soon",
    body: "Less than 12 hours left to complete the 72-Hour Power Reset. The Field is here when you are.",
  },
};

/**
 * Walk through users due for reminders and dispatch notifications. Designed
 * to be called by a cron job (see vercel.json `crons`). Idempotent — dedup
 * lives in push_notifications_sent so re-running mid-window does no harm.
 */
export async function runReminders() {
  const stats = { day2_unlocked: 0, day2_nudge: 0, day3_unlocked: 0, day3_nudge: 0, window_closing: 0 };

  // Pull every preview-tier member who has logged in, hasn't expired, and
  // hasn't already finished Day 3. The window logic + dedup happens in JS
  // so each notification type can have nuanced conditions.
  const { rows: members } = await sql`
    SELECT id, email, display_name, first_login_at, preview_ends_at, last_completed_day, tier
    FROM users
    WHERE tier = 'preview'
      AND kajabi_entitled = true
      AND first_login_at IS NOT NULL
      AND preview_ends_at > NOW()
      AND COALESCE(last_completed_day, 0) < 3
      AND email NOT LIKE '%@shimritnativ.com'
  `;

  const now = Date.now();

  for (const m of members) {
    const loginMs = new Date(m.first_login_at).getTime();
    const hours = (now - loginMs) / (1000 * 60 * 60);
    const d = m.last_completed_day || 0;

    // Day 2 unlocked at 24h — fires for everyone past 24h (they may or may
    // not have completed Day 1, but the unlock window is open)
    if (hours >= 24 && hours < 48) {
      const r = await sendPushToUser({
        userId: m.id,
        payload: REMINDER_COPY.day2_unlocked,
        notificationKey: "day2_unlocked",
      });
      if (r.sent > 0) stats.day2_unlocked++;
    }

    // Day 2 nudge at 30h — only if Day 1 completed but Day 2 hasn't been
    if (hours >= 30 && hours < 48 && d === 1) {
      const r = await sendPushToUser({
        userId: m.id,
        payload: REMINDER_COPY.day2_nudge,
        notificationKey: "day2_nudge",
      });
      if (r.sent > 0) stats.day2_nudge++;
    }

    // Day 3 unlocked at 48h
    if (hours >= 48 && hours < 72) {
      const r = await sendPushToUser({
        userId: m.id,
        payload: REMINDER_COPY.day3_unlocked,
        notificationKey: "day3_unlocked",
      });
      if (r.sent > 0) stats.day3_unlocked++;
    }

    // Day 3 nudge at 54h — only if Day 2 completed but Day 3 hasn't been
    if (hours >= 54 && hours < 96 && d === 2) {
      const r = await sendPushToUser({
        userId: m.id,
        payload: REMINDER_COPY.day3_nudge,
        notificationKey: "day3_nudge",
      });
      if (r.sent > 0) stats.day3_nudge++;
    }

    // Window-closing at 84h (12h before the 96h window expires)
    if (hours >= 84 && hours < 96 && d < 3) {
      const r = await sendPushToUser({
        userId: m.id,
        payload: REMINDER_COPY.window_closing,
        notificationKey: "window_closing",
      });
      if (r.sent > 0) stats.window_closing++;
    }
  }

  return stats;
}
