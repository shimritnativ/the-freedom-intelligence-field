// lib/adminNotify.js
// Shared helper for pushing notifications to every @shimritnativ.com
// admin who has a push subscription registered. Used by the ThriveCart
// webhook (on successful sales), milestone detection, and the daily
// summary cron.
//
// Why a helper: three different code paths now push to admins, and
// each one was previously doing its own DB query + loop. Centralizing
// keeps the audience definition consistent (everyone with the team
// domain who has subscribed) and makes it easy to tweak later — e.g.,
// add an env flag to throttle, change the audience, or log every
// admin push to an audit table.

import { sql } from "@vercel/postgres";
import { sendPushToUser } from "./push.js";

const ADMIN_DOMAIN = "@shimritnativ.com";

/**
 * Push a notification to every admin user. Never throws — returns a
 * summary so callers can log how many devices got the ping.
 *
 * payload fields:
 *   - title (required)
 *   - body (required)
 *   - url (optional, the deep-link when the user taps the notification)
 *   - tag (optional, used to coalesce repeated notifications with the
 *     same tag so the user's lock screen doesn't pile up duplicates)
 *   - requireInteraction (optional, keeps the notification visible
 *     until the user taps — use sparingly for genuinely important things)
 *
 * notificationKey is the dedup key inside our push_notifications_sent
 * table; defaults to tag.
 */
export async function notifyAdmins({
  title,
  body,
  url,
  tag,
  notificationKey,
  requireInteraction = false,
}) {
  const result = { admins_total: 0, sent_count: 0, errors: 0 };
  try {
    const { rows: admins } = await sql`
      SELECT DISTINCT u.id, u.email
      FROM users u
      JOIN push_subscriptions ps ON ps.user_id = u.id
      WHERE LOWER(u.email) LIKE ${"%" + ADMIN_DOMAIN}
    `;
    result.admins_total = admins.length;
    for (const a of admins) {
      try {
        const r = await sendPushToUser({
          userId: a.id,
          payload: {
            title,
            body,
            url: url || "/admin",
            tag: tag || notificationKey,
            requireInteraction,
          },
          notificationKey: notificationKey || tag,
        });
        if (r && r.sent > 0) result.sent_count++;
      } catch (e) {
        result.errors++;
      }
    }
  } catch (e) {
    console.warn("notifyAdmins_failed", e?.message);
  }
  return result;
}
