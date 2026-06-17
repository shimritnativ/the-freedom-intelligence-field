// api/admin/metrics.js
// Internal team metrics dashboard backend. Returns JSON of every metric the
// /admin.html page needs, all filtered by:
//   1. Launch date floor (default: LAUNCH_DATE constant below) so test/dev
//      accounts created before launch don't pollute the numbers.
//   2. Team domain exclusion (@shimritnativ.com) so internal accounts don't
//      show up as members.
//   3. Optional ?from= and ?to= query params for custom date ranges.
//
// Auth: x-session-token header. Gated to @shimritnativ.com viewers — viewing
// the dashboard requires team domain, but team accounts are excluded from
// the metrics themselves.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const LAUNCH_DATE = "2026-06-15"; // hard floor — no signups before this count
// Coupons we never want polluting revenue stats. GEO100 was a free comp for
// Tomer, used once for testing. Add others here as needed.
const EXCLUDED_COUPONS = ["GEO100"];

// Parse a YYYY-MM-DD query param into an ISO timestamp string we can safely
// pass to Postgres. Returns null for empty/invalid input so the caller can
// fall back to defaults.
function parseDate(s) {
  if (!s || typeof s !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function endOfDay(s) {
  if (!s || typeof s !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T23:59:59.999Z");
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

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

  // ===== Date range =====
  // `from` defaults to LAUNCH_DATE so we never count test accounts.
  // `to` defaults to now (NULL in SQL — handled via COALESCE).
  const fromRaw = (req.query && req.query.from) || LAUNCH_DATE;
  const toRaw = (req.query && req.query.to) || null;
  const fromIso = parseDate(fromRaw) || parseDate(LAUNCH_DATE);
  const toIso = endOfDay(toRaw); // null if not provided — means "up to now"

  // Domain exclusion pattern for the WHERE clauses.
  const excludePattern = `%${ALLOWED_DOMAIN}`;
  // Excluded coupons as a Postgres-friendly array for ANY() comparisons.
  // Coupon_code can be NULL, so we use COALESCE to make the comparison safe.
  const excludedCoupons = EXCLUDED_COUPONS;

  try {
    // Fan out every query in parallel. Every query that touches users or
    // purchases applies: (a) the launch-date floor / range, (b) the team
    // domain exclusion. Engagement queries on the messages table use rolling
    // 7d/30d windows — those are intentionally rolling regardless of the
    // selected range.
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
      thrivecartRevenue,
      thrivecartByProduct,
      thrivecartByCoupon,
      thrivecartTopBuyers,
      thrivecartRevenueByDay,
      thrivecartByProductCoupon,
      completionDetails,
      todaySignups,
      todayRevenue,
      todayActivity,
    ] = await Promise.all([
      // 1. Members by tier × plan (filtered)
      sql`
        SELECT
          tier::text AS tier,
          COALESCE(subscription_plan, 'none') AS plan,
          COUNT(*)::int AS n
        FROM users
        WHERE kajabi_entitled = true
          AND email NOT LIKE ${excludePattern}
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        GROUP BY tier, COALESCE(subscription_plan, 'none')
        ORDER BY tier, plan
      `,
      // 2. Completion funnel — Power Reset members only. The 72-Hour Power
      // Reset funnel measures Reset-tier members specifically; Unlimited
      // members aren't doing the Reset experience.
      sql`
        SELECT
          COUNT(*)::int AS total_members,
          COUNT(*) FILTER (WHERE first_login_at IS NOT NULL)::int AS total_logged_in,
          COUNT(*) FILTER (WHERE first_login_at IS NULL)::int AS never_logged_in,
          COUNT(*) FILTER (WHERE last_completed_day >= 1)::int AS d1,
          COUNT(*) FILTER (WHERE last_completed_day >= 2)::int AS d2,
          COUNT(*) FILTER (WHERE last_completed_day >= 3)::int AS d3
        FROM users
        WHERE kajabi_entitled = true
          AND tier = 'preview'
          AND email NOT LIKE ${excludePattern}
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
      `,
      // 3. Signups per day
      sql`
        SELECT
          date_trunc('day', created_at)::date AS day,
          tier::text AS tier,
          COUNT(*)::int AS n
        FROM users
        WHERE kajabi_entitled = true
          AND email NOT LIKE ${excludePattern}
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        GROUP BY day, tier
        ORDER BY day DESC
      `,
      // 4. Unlimited engagement — rolling windows, team excluded
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
        JOIN users u ON u.id = m.user_id
        WHERE s.session_type = 'unlimited'
          AND u.email NOT LIKE ${excludePattern}
      `,
      // 5. Top Unlimited users by message count, last 30 days
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
          AND u.email NOT LIKE ${excludePattern}
        GROUP BY u.id, u.email, u.display_name, u.tier, u.subscription_plan
        ORDER BY messages_30d DESC
        LIMIT 20
      `,
      // 6. Recent signups (newest 25 in range)
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
          AND email NOT LIKE ${excludePattern}
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        ORDER BY created_at DESC
        LIMIT 25
      `,
      // 7. 72-Hour Reset window state
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
          AND email NOT LIKE ${excludePattern}
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
      `,
      // 8. Webhook activity, rolling 30 days
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
      // 9. Top Unlimited processes used, rolling 30 days
      sql`
        SELECT
          COALESCE(s.metadata->>'process', 'freeform') AS process_key,
          COUNT(DISTINCT s.user_id)::int AS unique_users,
          COUNT(DISTINCT s.id)::int AS sessions_started
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.session_type = 'unlimited'
          AND s.started_at > NOW() - INTERVAL '30 days'
          AND u.email NOT LIKE ${excludePattern}
        GROUP BY process_key
        ORDER BY sessions_started DESC
      `,
      // 10. ThriveCart total revenue (excludes team + excluded coupons)
      safeQuery(sql`
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'order.success')::int AS orders,
          COALESCE(SUM(amount_cents) FILTER (WHERE event_type = 'order.success'), 0)::bigint AS gross_cents,
          COALESCE(SUM(amount_cents) FILTER (WHERE event_type = 'order.refund'), 0)::bigint AS refund_cents,
          COUNT(DISTINCT email) FILTER (WHERE event_type = 'order.success')::int AS unique_buyers
        FROM purchases
        WHERE email NOT LIKE ${excludePattern}
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
      `),
      // 11. Revenue by product
      safeQuery(sql`
        SELECT
          COALESCE(product_name, product_id, 'unknown') AS product,
          COUNT(*)::int AS orders,
          COALESCE(SUM(amount_cents), 0)::bigint AS revenue_cents
        FROM purchases
        WHERE event_type = 'order.success'
          AND email NOT LIKE ${excludePattern}
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        GROUP BY product
        ORDER BY revenue_cents DESC
        LIMIT 15
      `),
      // 12. Revenue by coupon
      safeQuery(sql`
        SELECT
          COALESCE(coupon_code, '(no coupon)') AS coupon,
          COUNT(*)::int AS orders,
          COALESCE(SUM(amount_cents), 0)::bigint AS revenue_cents,
          COALESCE(AVG(amount_cents), 0)::int AS avg_cents
        FROM purchases
        WHERE event_type = 'order.success'
          AND email NOT LIKE ${excludePattern}
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        GROUP BY coupon
        ORDER BY revenue_cents DESC
      `),
      // 13. Top buyers by total spend
      safeQuery(sql`
        SELECT
          email,
          COUNT(*)::int AS orders,
          COALESCE(SUM(amount_cents), 0)::bigint AS revenue_cents,
          MAX(created_at) AS last_purchase
        FROM purchases
        WHERE event_type = 'order.success'
          AND email NOT LIKE ${excludePattern}
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        GROUP BY email
        ORDER BY revenue_cents DESC
        LIMIT 15
      `),
      // 14. Revenue by day
      safeQuery(sql`
        SELECT
          date_trunc('day', created_at)::date AS day,
          COALESCE(SUM(amount_cents), 0)::bigint AS revenue_cents,
          COUNT(*)::int AS orders
        FROM purchases
        WHERE event_type = 'order.success'
          AND email NOT LIKE ${excludePattern}
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        GROUP BY day
        ORDER BY day DESC
      `),
      // 15. Product × coupon cross-tab
      safeQuery(sql`
        SELECT
          COALESCE(product_name, product_id, 'unknown') AS product,
          COALESCE(coupon_code, '(full price)') AS coupon,
          COUNT(*)::int AS orders,
          COALESCE(SUM(amount_cents), 0)::bigint AS revenue_cents,
          COALESCE(AVG(amount_cents), 0)::int AS avg_cents
        FROM purchases
        WHERE event_type = 'order.success'
          AND email NOT LIKE ${excludePattern}
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        GROUP BY product, coupon
        ORDER BY revenue_cents DESC, orders DESC
      `),
      // 16. Completion details — one row per member (logged in OR not). The
      // frontend buckets these by login + completion stage to drive the
      // clickable funnel rows, including the new "Joined but never logged in"
      // row that surfaces paying members who haven't opened the app yet.
      sql`
        SELECT
          email,
          display_name,
          tier::text AS tier,
          COALESCE(last_completed_day, 0)::int AS last_completed_day,
          first_login_at,
          created_at
        FROM users
        WHERE kajabi_entitled = true
          AND tier = 'preview'
          AND email NOT LIKE ${excludePattern}
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        ORDER BY
          CASE WHEN first_login_at IS NULL THEN 1 ELSE 0 END,
          last_completed_day DESC NULLS LAST,
          first_login_at DESC NULLS LAST
      `,
      // 17. Today's snapshot — split into 3 lightweight queries because a
      // single multi-subquery statement caused parameter-binding issues with
      // @vercel/postgres. Each query is independently safeQuery-wrapped so a
      // missing table never breaks the whole dashboard.
      safeQuery(sql`
        SELECT
          COUNT(*)::int AS signups_today,
          COUNT(*) FILTER (WHERE tier = 'preview')::int AS signups_today_reset,
          COUNT(*) FILTER (WHERE tier = 'full')::int AS signups_today_unlimited
        FROM users
        WHERE kajabi_entitled = true
          AND email NOT LIKE ${excludePattern}
          AND created_at >= date_trunc('day', NOW())
      `),
      safeQuery(sql`
        SELECT
          COALESCE(SUM(amount_cents), 0)::bigint AS revenue_today_cents,
          COUNT(*)::int AS orders_today
        FROM purchases
        WHERE event_type = 'order.success'
          AND email NOT LIKE ${excludePattern}
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND created_at >= date_trunc('day', NOW())
      `),
      safeQuery(sql`
        SELECT
          (SELECT COUNT(*)::int FROM day_completions dc
             JOIN users u ON u.id = dc.user_id
             WHERE u.email NOT LIKE ${excludePattern}
               AND dc.created_at >= date_trunc('day', NOW())) AS completions_today,
          (SELECT COUNT(DISTINCT m.user_id)::int FROM messages m
             JOIN sessions s ON s.id = m.session_id
             JOIN users u ON u.id = m.user_id
             WHERE u.email NOT LIKE ${excludePattern}
               AND s.session_type = 'unlimited'
               AND m.created_at >= date_trunc('day', NOW())) AS active_unlimited_today,
          (SELECT COUNT(*)::int FROM messages m
             JOIN sessions s ON s.id = m.session_id
             JOIN users u ON u.id = m.user_id
             WHERE u.email NOT LIKE ${excludePattern}
               AND s.session_type = 'unlimited'
               AND m.role = 'user'
               AND m.created_at >= date_trunc('day', NOW())) AS unlimited_messages_today
      `),
    ]);

    return res.status(200).json({
      asOf: new Date().toISOString(),
      viewer: { email: user.email, displayName: user.display_name },
      dateRange: {
        from: fromIso,
        to: toIso,
        launchDate: LAUNCH_DATE,
        excludedDomain: ALLOWED_DOMAIN,
      },
      today: {
        ...(todaySignups ? todaySignups.rows[0] : {}),
        ...(todayRevenue ? todayRevenue.rows[0] : {}),
        ...(todayActivity ? todayActivity.rows[0] : {}),
      },
      tierCounts: tierCounts.rows,
      completion: completion.rows[0],
      completionDetails: completionDetails.rows,
      signupsByDay: signupsByDay.rows,
      unlimitedEngagement: unlimitedEngagement.rows[0],
      perUserUnlimited: perUserUnlimited.rows,
      recentSignups: recentSignups.rows,
      windowState: windowState.rows[0],
      webhookActivity: webhookActivity.rows,
      processUsage: processUsage.rows,
      thrivecart: {
        connected: thrivecartRevenue !== null,
        summary: thrivecartRevenue ? thrivecartRevenue.rows[0] : null,
        byProduct: thrivecartByProduct ? thrivecartByProduct.rows : [],
        byCoupon: thrivecartByCoupon ? thrivecartByCoupon.rows : [],
        byProductCoupon: thrivecartByProductCoupon ? thrivecartByProductCoupon.rows : [],
        topBuyers: thrivecartTopBuyers ? thrivecartTopBuyers.rows : [],
        byDay: thrivecartRevenueByDay ? thrivecartRevenueByDay.rows : [],
      },
    });
  } catch (err) {
    console.error("admin_metrics_error", { message: err?.message });
    return res.status(500).json({ error: "server_error", message: err?.message });
  }
}

// Wrap a promise so a missing-table error (purchases not created yet) resolves
// to null instead of crashing the whole metrics fan-out. Real errors still log.
async function safeQuery(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err && err.message && /relation .* does not exist/i.test(err.message)) {
      return null; // table not migrated yet — show as "not connected"
    }
    console.error("metrics_subquery_error", { message: err?.message });
    return null;
  }
}
