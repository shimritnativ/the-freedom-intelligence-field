// api/admin/metrics.js
// Internal team metrics dashboard backend. Returns JSON of every metric the
// /admin.html page needs in a single fan-out query. Gated to @shimritnativ.com
// emails via the session token.
//
// Auth: x-session-token header (same as /api/chat). Server looks up the user
// from the token, then refuses anyone whose email does not end in
// @shimritnativ.com. Anyone else gets a 403 even if they are entitled.
//
// Adding new metrics: add a query to the Promise.all block and return a new
// key in the JSON. The dashboard reads from those keys directly.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  // CORS — same shape as /api/chat. Lets the dashboard live on the same domain
  // and call this endpoint from the browser.
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // ===== Auth =====
  const token = req.headers["x-session-token"];
  if (!token) return res.status(401).json({ error: "no_token" });
  const user = await getUserBySessionToken(token);
  if (!user) return res.status(401).json({ error: "invalid_session" });
  const email = (user.email || "").toLowerCase();
  if (!email.endsWith(ALLOWED_DOMAIN)) {
    return res.status(403).json({ error: "forbidden_domain" });
  }

  try {
    // Fan out every query in parallel — they hit independent tables.
    const [
      tierCounts,
      completion,
      signupsByDay,
      unlimitedEngagement,
      perUserUnlimited,
      recentSignups,
      windowState,
      webhookActivity,
      processUsage,
    ] = await Promise.all([
      // 1. Total members by tier + subscription plan
      sql`
        SELECT
          tier,
          COALESCE(subscription_plan, 'none') AS plan,
          COUNT(*)::int AS n
        FROM users
        WHERE kajabi_entitled = true
        GROUP BY tier, COALESCE(subscription_plan, 'none')
        ORDER BY tier, plan
      `,
      // 2. Completion funnel — members who have logged in at least once
      sql`
        SELECT
          COUNT(*)::int AS total_logged_in,
          COUNT(*) FILTER (WHERE last_completed_day >= 1)::int AS d1,
          COUNT(*) FILTER (WHERE last_completed_day >= 2)::int AS d2,
          COUNT(*) FILTER (WHERE last_completed_day >= 3)::int AS d3
        FROM users
        WHERE kajabi_entitled = true AND first_login_at IS NOT NULL
      `,
      // 3. Signups per day, last 30 days
      sql`
        SELECT
          date_trunc('day', created_at)::date AS day,
          tier::text AS tier,
          COUNT(*)::int AS n
        FROM users
        WHERE kajabi_entitled = true
          AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY day, tier
        ORDER BY day DESC
      `,
      // 4. Unlimited engagement — total + active users across windows
      sql`
        SELECT
          COUNT(DISTINCT m.user_id) FILTER (
            WHERE m.created_at > NOW() - INTERVAL '7 days'
          )::int AS active_users_7d,
          COUNT(DISTINCT m.user_id) FILTER (
            WHERE m.created_at > NOW() - INTERVAL '30 days'
          )::int AS active_users_30d,
          COUNT(*) FILTER (
            WHERE m.created_at > NOW() - INTERVAL '7 days'
              AND m.role = 'user'
          )::int AS user_messages_7d,
          COUNT(*) FILTER (
            WHERE m.created_at > NOW() - INTERVAL '30 days'
              AND m.role = 'user'
          )::int AS user_messages_30d
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE s.session_type = 'unlimited'
      `,
      // 5. Top 20 Unlimited users by message count (last 30 days)
      sql`
        SELECT
          u.email,
          u.display_name,
          u.tier::text AS tier,
          u.subscription_plan,
          COUNT(*) FILTER (WHERE m.role = 'user')::int AS messages_30d,
          MAX(m.created_at) AS last_message_at
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        JOIN users u ON u.id = m.user_id
        WHERE s.session_type = 'unlimited'
          AND m.created_at > NOW() - INTERVAL '30 days'
          AND u.kajabi_entitled = true
        GROUP BY u.id, u.email, u.display_name, u.tier, u.subscription_plan
        ORDER BY messages_30d DESC
        LIMIT 20
      `,
      // 6. Recent signups list (newest 25)
      sql`
        SELECT
          email,
          display_name,
          tier::text AS tier,
          subscription_plan,
          created_at,
          first_login_at,
          last_completed_day,
          preview_ends_at
        FROM users
        WHERE kajabi_entitled = true
        ORDER BY created_at DESC
        LIMIT 25
      `,
      // 7. 72-Hour Reset window state — active vs expired
      sql`
        SELECT
          COUNT(*) FILTER (
            WHERE tier = 'preview'
              AND first_login_at IS NOT NULL
              AND preview_ends_at > NOW()
          )::int AS active_reset,
          COUNT(*) FILTER (
            WHERE tier = 'preview'
              AND first_login_at IS NOT NULL
              AND preview_ends_at <= NOW()
          )::int AS expired_reset,
          COUNT(*) FILTER (
            WHERE tier = 'preview'
              AND first_login_at IS NULL
          )::int AS never_logged_in_reset
        FROM users
        WHERE kajabi_entitled = true
      `,
      // 8. Webhook activity last 30 days — useful for spotting ThriveCart/Kajabi sync issues
      sql`
        SELECT
          event_type,
          COUNT(*)::int AS n,
          MAX(processed_at) AS last_at
        FROM webhook_events
        WHERE processed_at > NOW() - INTERVAL '30 days'
        GROUP BY event_type
        ORDER BY n DESC
      `,
      // 9. Top Unlimited processes used in the last 30 days. The session
      // metadata column stores the process key when a guided process is
      // started. NULL means a freeform Unlimited chat.
      sql`
        SELECT
          COALESCE(s.metadata->>'process', 'freeform') AS process_key,
          COUNT(DISTINCT s.user_id)::int AS unique_users,
          COUNT(DISTINCT s.id)::int AS sessions_started
        FROM sessions s
        WHERE s.session_type = 'unlimited'
          AND s.started_at > NOW() - INTERVAL '30 days'
        GROUP BY process_key
        ORDER BY sessions_started DESC
      `,
    ]);

    return res.status(200).json({
      asOf: new Date().toISOString(),
      viewer: { email: user.email, displayName: user.display_name },
      tierCounts: tierCounts.rows,
      completion: completion.rows[0],
      signupsByDay: signupsByDay.rows,
      unlimitedEngagement: unlimitedEngagement.rows[0],
      perUserUnlimited: perUserUnlimited.rows,
      recentSignups: recentSignups.rows,
      windowState: windowState.rows[0],
      webhookActivity: webhookActivity.rows,
      processUsage: processUsage.rows,
    });
  } catch (err) {
    console.error("admin_metrics_error", { message: err?.message });
    return res.status(500).json({ error: "server_error", message: err?.message });
  }
}
