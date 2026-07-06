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
// Coupons we never want polluting revenue stats. These are comp / free
// codes — using any of them = 100% off, so the order is €0 and shouldn't
// inflate average-order-value or appear in the per-product breakdowns.
// Add new comp codes here as you create them in ThriveCart.
const EXCLUDED_COUPONS = [
  "GEO100",       // Geo's personal 100% off comp
  "GEOALL",       // Geo's all-products 100% off comp
  "LAUNCHTEAM",   // Reset team comp (FREE — confirm with Geo whether to keep excluded)
  // NOTE: LAUNCHTEAMUNLIMITED is a 75% off discount, NOT a free comp.
  // Team buyers using it pay €190.40 gross (€160 net) for Unlimited yearly.
  // Real revenue, real members. Keeping it in this list would filter them
  // out of the roster and AOV stats, which Geo flagged as wrong (Kathrine
  // missing from the roster even though she paid).
];
// Subset of EXCLUDED_COUPONS that should ALSO drop the buyer from
// member counts entirely. Use this for codes where the buyer isn't a
// real customer at all — e.g., Geo's personal test comps. LAUNCHTEAM
// and LAUNCHTEAMUNLIMITED stay OUT of this list because team members
// are real people using the product, just unpaid. They count as
// members, their €0 stays out of revenue stats. Without this split,
// adding LAUNCHTEAM to EXCLUDED_COUPONS dropped 6 real team users
// from the roster (32 → 26), which Geo flagged as wrong.
const EXCLUDED_COUPONS_FROM_MEMBERS = [
  "GEO100",
  "GEOALL",
];
// Product name patterns that count as "The Field" revenue. The dashboard
// is for the Field business specifically, so MYP Business Club, Coaching
// Certification, NOW Shift, RISE, etc. shouldn't appear in the Field's
// revenue breakdown — they're separate businesses sold via the same
// ThriveCart account. Reset, Activation, and Unlimited are the only
// Field products. Patterns use ILIKE so casing and variant suffixes
// like "(Yearly)" or "- Ads" still match.
const FIELD_PRODUCT_PATTERNS = [
  "%Power Reset%",
  "%Power Activation%",
  "%Freedom Intelligence Field%",
];
// Personal team gmail addresses that don't end in @shimritnativ.com but still
// shouldn't show up in member-facing segments. Add new ones as the team grows.
const EXTRA_EXCLUDED_EMAILS = [
  // Geo's personal Gmail accounts used for testing The Field.
  "ge.amaral3@gmail.com",
  "geoamaral333@gmail.com",
];
// Wildcard LIKE patterns for emails to ALWAYS hide from member counts,
// roster, segments, and funnels. Combines:
//   - %@shimritnativ.com (the team domain — was previously its own var)
//   - Gmail "+" aliases for Geo's accounts (ge.amaral3+anything@gmail.com,
//     ge.amaral+anything@gmail.com, geoamaral333+anything@gmail.com).
//     These all forward to the same inboxes so they're test rows.
// Used with `email LIKE ANY(${EMAIL_EXCLUDE_PATTERNS})` in SQL.
const EMAIL_EXCLUDE_PATTERNS = [
  "%@shimritnativ.com",
  "ge.amaral3@gmail.com",
  "ge.amaral3+%@gmail.com",
  "ge.amaral+%@gmail.com",
  "geoamaral333@gmail.com",
  "geoamaral333+%@gmail.com",
];

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
  // Aggressive no-cache. Prevents Vercel edge or browser from serving a
  // stale response that makes new signups + purchases feel like they
  // aren't landing until Geo clicks Refresh multiple times.
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // ===== Auth — Field session only =====
  // Access is restricted to Field members whose email ends in @shimritnativ.com.
  // The team logs into the Field normally; that same session unlocks /admin.
  const token = req.headers["x-session-token"];
  if (!token) return res.status(401).json({ error: "no_token" });
  const user = await getUserBySessionToken(token);
  if (!user) return res.status(401).json({ error: "invalid_session" });
  const email = (user.email || "").toLowerCase();
  if (!email.endsWith(ALLOWED_DOMAIN)) {
    return res.status(403).json({ error: "forbidden_domain" });
  }
  const displayName = user.display_name;

  // ===== Date range =====
  // `from` defaults to LAUNCH_DATE so we never count test accounts.
  // `to` defaults to now (NULL in SQL — handled via COALESCE).
  const fromRaw = (req.query && req.query.from) || LAUNCH_DATE;
  const toRaw = (req.query && req.query.to) || null;
  const fromIso = parseDate(fromRaw) || parseDate(LAUNCH_DATE);
  const toIso = endOfDay(toRaw); // null if not provided — means "up to now"

  // Email exclusion patterns for the WHERE clauses. Pulled from the
  // top-level constant so adding a new test account is a one-line edit
  // up there. Single-pattern callers can still use `excludePattern` for
  // the team domain alone; full callers should use `excludePatterns`.
  const excludePattern = `%${ALLOWED_DOMAIN}`;
  const excludePatterns = EMAIL_EXCLUDE_PATTERNS;
  // Excluded coupons as a Postgres-friendly array for ANY() comparisons.
  // Coupon_code can be NULL, so we use COALESCE to make the comparison safe.
  const excludedCoupons = EXCLUDED_COUPONS;
  // Smaller subset used for member-counting / roster queries — only
  // drops Geo's personal test comps. Team comps (LAUNCHTEAM) still
  // count as real members.
  const excludedCouponsFromMembers = EXCLUDED_COUPONS_FROM_MEMBERS;
  // Product name patterns for the Field-only filter on revenue queries.
  // Used with `product_name ILIKE ANY(...)` to keep non-Field sales
  // (Business Club, RISE, Certification, etc.) out of the dashboard.
  const fieldProductPatterns = FIELD_PRODUCT_PATTERNS;
  // Extra emails (non-@shimritnativ.com team accounts) to exclude from
  // Intelligence segments. Used as `u.email <> ALL(${extraExcluded})`.
  const extraExcluded = EXTRA_EXCLUDED_EMAILS;

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
      segReadyForUpsell,
      segHotResetGrad,
      segBookLaunchWarmer,
      segAtRiskSubscriber,
      segStuckReset,
      segResetAlumni,
      segHighIntent,
      todaySignups,
      todayRevenue,
      todayActivity,
      memberSourceBreakdown,
      resetToUnlimitedConversion,
      channelAttribution,
    ] = await Promise.all([
      // 1. Members by tier × plan (filtered)
      //
      // Reset (preview) members are counted when they're Kajabi-entitled
      // AND aren't comp-only (their only purchase was an excluded coupon
      // like GEO100). Unlimited (full) members are counted ONLY when they
      // have a real paid ThriveCart purchase. Same rule applies anywhere
      // we count members below — the comp-only exclusion keeps test
      // accounts like Tomer (GEO100) out of every member roster, count,
      // and funnel without manual per-email blocklisting.
      sql`
        SELECT
          u.tier::text AS tier,
          COALESCE(u.subscription_plan, 'none') AS plan,
          COUNT(*)::int AS n
        FROM users u
        WHERE u.kajabi_entitled = true
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR u.created_at <= ${toIso})
          AND (
            -- No purchases at all → Kajabi-only grant (legit free signup)
            NOT EXISTS (SELECT 1 FROM purchases p WHERE LOWER(p.email) = LOWER(u.email))
            -- OR at least one non-test-comp purchase exists. Uses the
            -- smaller exclude list so LAUNCHTEAM team members still
            -- count as members (only Geo's personal test comps drop).
            OR EXISTS (
              SELECT 1 FROM purchases p
              WHERE LOWER(p.email) = LOWER(u.email)
                AND COALESCE(p.coupon_code, '') <> ALL(${excludedCouponsFromMembers})
            )
          )
          AND (
            u.tier = 'preview'
            OR EXISTS (
              SELECT 1 FROM purchases p
              WHERE p.email = u.email
                AND p.event_type IN ('order.success', 'order.subscription_payment')
                AND p.amount_cents > 0
                AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
            )
          )
        GROUP BY u.tier, COALESCE(u.subscription_plan, 'none')
        ORDER BY tier, plan
      `,
      // 2. Completion funnel — every member who did the Reset, regardless
      // of where they are now. Test comps (GEO100, GEOALL) are excluded
      // so the funnel reflects real launch performance. Team comps
      // (LAUNCHTEAM) stay in because team members really did the Reset.
      sql`
        SELECT
          COUNT(*)::int AS total_members,
          COUNT(*) FILTER (WHERE first_login_at IS NOT NULL)::int AS total_logged_in,
          COUNT(*) FILTER (WHERE first_login_at IS NULL)::int AS never_logged_in,
          COUNT(*) FILTER (WHERE last_completed_day >= 1)::int AS d1,
          COUNT(*) FILTER (WHERE last_completed_day >= 2)::int AS d2,
          COUNT(*) FILTER (WHERE last_completed_day >= 3)::int AS d3
        FROM users u
        WHERE u.kajabi_entitled = true
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR u.created_at <= ${toIso})
          AND (
            NOT EXISTS (SELECT 1 FROM purchases p WHERE LOWER(p.email) = LOWER(u.email))
            OR EXISTS (
              SELECT 1 FROM purchases p
              WHERE LOWER(p.email) = LOWER(u.email)
                AND COALESCE(p.coupon_code, '') <> ALL(${excludedCouponsFromMembers})
            )
          )
      `,
      // 3. Signups per day — test comps excluded, team comps included.
      sql`
        SELECT
          date_trunc('day', u.created_at)::date AS day,
          u.tier::text AS tier,
          COUNT(*)::int AS n
        FROM users u
        WHERE u.kajabi_entitled = true
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR u.created_at <= ${toIso})
          AND (
            NOT EXISTS (SELECT 1 FROM purchases p WHERE LOWER(p.email) = LOWER(u.email))
            OR EXISTS (
              SELECT 1 FROM purchases p
              WHERE LOWER(p.email) = LOWER(u.email)
                AND COALESCE(p.coupon_code, '') <> ALL(${excludedCouponsFromMembers})
            )
          )
        GROUP BY day, u.tier
        ORDER BY day DESC
      `,
      // 4. Unlimited engagement — rolling windows, team excluded, AND only
      // counts PAYING Unlimited members. Free accounts (GEO100 comps, team
      // grants, etc.) inflate engagement numbers and obscure how real
      // customers are using the product. Same has_paid_purchase logic as
      // the COMP pill elsewhere.
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
          AND u.email IS NOT NULL AND u.email <> ''
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.email <> ALL(${extraExcluded})
          AND EXISTS (
            SELECT 1 FROM purchases p
            WHERE p.email = u.email
              AND p.event_type IN ('order.success', 'order.subscription_payment')
              AND p.amount_cents > 0
              AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
          )
      `,
      // 5. Top Unlimited users by message count, last 30 days. Also flags
      // whether each member has any REAL paid purchase — anyone showing up
      // here without a non-zero, non-test-coupon purchase is a comp/test
      // account (team member, GEO100 user, admin-granted, etc.) and gets a
      // visual "COMP" pill in the UI so revenue-impact users are obvious.
      sql`
        SELECT
          u.email,
          u.display_name,
          u.tier::text AS tier,
          u.subscription_plan,
          COUNT(*) FILTER (WHERE m.role = 'user')::int AS messages_30d,
          MAX(m.created_at) AS last_message_at,
          EXISTS (
            SELECT 1 FROM purchases p
            WHERE p.email = u.email
              AND p.event_type IN ('order.success', 'order.subscription_payment')
              AND p.amount_cents > 0
              AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
          ) AS has_paid_purchase
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        JOIN users u ON u.id = m.user_id
        WHERE s.session_type = 'unlimited'
          AND m.created_at > NOW() - INTERVAL '30 days'
          AND u.kajabi_entitled = true
          AND u.email IS NOT NULL AND u.email <> ''
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.email <> ALL(${extraExcluded})
        GROUP BY u.id, u.email, u.display_name, u.tier, u.subscription_plan
        ORDER BY messages_30d DESC
        LIMIT 20
      `,
      // 6. Recent signups (newest 25 in range)
      sql`
        SELECT
          u.email,
          u.display_name,
          u.tier::text AS tier,
          u.subscription_plan,
          u.created_at,
          u.first_login_at,
          u.last_completed_day,
          u.preview_ends_at,
          -- UTM attribution so the admin can see at a glance whether each
          -- member came from a Meta ad (utm_campaign matches a known ad
          -- name like "cold" or "warm"), from a Shimrit email, organic
          -- search, etc. NULL across all three columns = the buyer did
          -- not pass through a tracked URL, so we can only label them
          -- "organic / direct / unknown."
          u.utm_source,
          u.utm_campaign,
          u.utm_content,
          -- Total amount each member has paid on the Field (main products +
          -- OTOs + bumps + recurring), excluding refunds and free comps.
          -- The frontend respects the VAT toggle and divides by 1.19 for
          -- the "ex VAT" view. Returned in cents to match every other
          -- money field on the dashboard.
          COALESCE((
            SELECT SUM(p.amount_cents)
            FROM purchases p
            WHERE p.email = u.email
              AND p.event_type IN ('order.success', 'order.subscription_payment')
              AND p.amount_cents > 0
              AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
          ), 0)::bigint AS total_spent_cents,
          COALESCE((
            SELECT COUNT(DISTINCT p.thrivecart_id)
            FROM purchases p
            WHERE p.email = u.email
              AND p.event_type IN ('order.success', 'order.subscription_payment')
              AND p.amount_cents > 0
              AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
          ), 0)::int AS purchase_count,
          -- Compact JSON list of every purchase, for the hover tooltip
          -- on the "X orders" badge in the roster. One row per purchase,
          -- with the product name + paid amount + coupon code if any.
          -- Includes ALL purchases (even comp ones) so Geo can see
          -- exactly what each member bought, even free LAUNCHTEAM ones.
          COALESCE((
            SELECT JSON_AGG(JSON_BUILD_OBJECT(
              'product', p.product_name,
              'amount_cents', p.amount_cents,
              'coupon', p.coupon_code,
              'created_at', p.created_at
            ) ORDER BY p.created_at) FROM purchases p
            WHERE LOWER(p.email) = LOWER(u.email)
              AND p.event_type IN ('order.success', 'order.subscription_payment')
          ), '[]'::json) AS purchases_json
        FROM users u
        WHERE u.kajabi_entitled = true
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.email <> ALL(${extraExcluded})
          AND u.created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR u.created_at <= ${toIso})
          AND (
            -- Comp-only filter: hide users whose only purchases used a
            -- TEST comp coupon (Geo's personal GEO100 / GEOALL). Real
            -- team comps (LAUNCHTEAM, LAUNCHTEAMUNLIMITED) still count
            -- as members because team members are real users. No-purchase
            -- Kajabi grants also still count.
            NOT EXISTS (SELECT 1 FROM purchases p WHERE LOWER(p.email) = LOWER(u.email))
            OR EXISTS (
              SELECT 1 FROM purchases p
              WHERE LOWER(p.email) = LOWER(u.email)
                AND COALESCE(p.coupon_code, '') <> ALL(${excludedCouponsFromMembers})
            )
          )
          AND (
            -- Tier filter unchanged: Reset members count automatically,
            -- Unlimited members only when they have a paid non-comp purchase.
            u.tier = 'preview'
            OR EXISTS (
              SELECT 1 FROM purchases p
              WHERE p.email = u.email
                AND p.event_type IN ('order.success', 'order.subscription_payment')
                AND p.amount_cents > 0
                AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
            )
          )
        ORDER BY u.created_at DESC
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
          AND NOT (email LIKE ANY(${excludePatterns}))
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
          AND u.email IS NOT NULL AND u.email <> ''
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.email <> ALL(${extraExcluded})
        GROUP BY process_key
        ORDER BY sessions_started DESC
      `,
      // 10. ThriveCart total revenue (excludes team + excluded coupons,
      // restricted to Field products only — no Business Club, RISE, etc.)
      safeQuery(sql`
        SELECT
          COUNT(*) FILTER (WHERE event_type IN ('order.success', 'order.subscription_payment'))::int AS orders,
          COALESCE(SUM(amount_cents) FILTER (WHERE event_type IN ('order.success', 'order.subscription_payment')), 0)::bigint AS gross_cents,
          COALESCE(SUM(amount_cents) FILTER (WHERE event_type = 'order.refund'), 0)::bigint AS refund_cents,
          COUNT(DISTINCT email) FILTER (WHERE event_type IN ('order.success', 'order.subscription_payment'))::int AS unique_buyers
        FROM purchases
        WHERE NOT (email LIKE ANY(${excludePatterns}))
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND product_name ILIKE ANY(${fieldProductPatterns})
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
      `),
      // 11. Revenue by product (Field products only, canonicalized).
      // Collapses "The Power Reset - Ads", "(One-Time Payment)" etc into
      // a single "The Power Reset" row. Same for Activation variants.
      // Keeps Monthly and Yearly Unlimited as separate lines because
      // they're meaningfully different prices.
      safeQuery(sql`
        SELECT
          CASE
            WHEN product_name ILIKE '%Yearly%' THEN 'The Freedom Intelligence Field - Unlimited (Yearly)'
            WHEN product_name ILIKE '%Monthly%' THEN 'The Freedom Intelligence Field - Unlimited (Monthly)'
            WHEN product_name ILIKE '%Freedom Intelligence Field%' THEN 'The Freedom Intelligence Field - Unlimited'
            WHEN product_name ILIKE '%Power Activation%' THEN 'The Power Activation'
            WHEN product_name ILIKE '%Power Reset%' THEN 'The Power Reset'
            ELSE COALESCE(product_name, 'unknown')
          END AS product,
          COUNT(*)::int AS orders,
          COALESCE(SUM(amount_cents), 0)::bigint AS revenue_cents
        FROM purchases
        WHERE event_type IN ('order.success', 'order.subscription_payment')
          AND NOT (email LIKE ANY(${excludePatterns}))
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND product_name ILIKE ANY(${fieldProductPatterns})
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        GROUP BY product
        ORDER BY revenue_cents DESC
        LIMIT 15
      `),
      // 12. Revenue by coupon (Field products only)
      safeQuery(sql`
        SELECT
          COALESCE(coupon_code, '(no coupon)') AS coupon,
          COUNT(*)::int AS orders,
          COALESCE(SUM(amount_cents), 0)::bigint AS revenue_cents,
          COALESCE(AVG(amount_cents), 0)::int AS avg_cents
        FROM purchases
        WHERE event_type IN ('order.success', 'order.subscription_payment')
          AND NOT (email LIKE ANY(${excludePatterns}))
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND product_name ILIKE ANY(${fieldProductPatterns})
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        GROUP BY coupon
        ORDER BY revenue_cents DESC
      `),
      // 13. Top buyers by total spend (Field products only)
      safeQuery(sql`
        SELECT
          email,
          COUNT(*)::int AS orders,
          COALESCE(SUM(amount_cents), 0)::bigint AS revenue_cents,
          MAX(created_at) AS last_purchase
        FROM purchases
        WHERE event_type IN ('order.success', 'order.subscription_payment')
          AND NOT (email LIKE ANY(${excludePatterns}))
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND product_name ILIKE ANY(${fieldProductPatterns})
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        GROUP BY email
        ORDER BY revenue_cents DESC
        LIMIT 15
      `),
      // 14. Revenue by day (Field products only)
      safeQuery(sql`
        SELECT
          date_trunc('day', created_at)::date AS day,
          COALESCE(SUM(amount_cents), 0)::bigint AS revenue_cents,
          COUNT(*)::int AS orders
        FROM purchases
        WHERE event_type IN ('order.success', 'order.subscription_payment')
          AND NOT (email LIKE ANY(${excludePatterns}))
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND product_name ILIKE ANY(${fieldProductPatterns})
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        GROUP BY day
        ORDER BY day DESC
      `),
      // 15. Product × coupon cross-tab (Field products only, canonicalized
      // same way as query 11 so the breakdown is consistent across the
      // dashboard).
      safeQuery(sql`
        SELECT
          CASE
            WHEN product_name ILIKE '%Yearly%' THEN 'The Freedom Intelligence Field - Unlimited (Yearly)'
            WHEN product_name ILIKE '%Monthly%' THEN 'The Freedom Intelligence Field - Unlimited (Monthly)'
            WHEN product_name ILIKE '%Freedom Intelligence Field%' THEN 'The Freedom Intelligence Field - Unlimited'
            WHEN product_name ILIKE '%Power Activation%' THEN 'The Power Activation'
            WHEN product_name ILIKE '%Power Reset%' THEN 'The Power Reset'
            ELSE COALESCE(product_name, 'unknown')
          END AS product,
          COALESCE(coupon_code, '(full price)') AS coupon,
          COUNT(*)::int AS orders,
          COALESCE(SUM(amount_cents), 0)::bigint AS revenue_cents,
          COALESCE(AVG(amount_cents), 0)::int AS avg_cents
        FROM purchases
        WHERE event_type IN ('order.success', 'order.subscription_payment')
          AND NOT (email LIKE ANY(${excludePatterns}))
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND product_name ILIKE ANY(${fieldProductPatterns})
          AND created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR created_at <= ${toIso})
        GROUP BY product, coupon
        ORDER BY revenue_cents DESC, orders DESC
      `),
      // 16. Completion details — one row per member (logged in OR not). The
      // frontend buckets these by login + completion stage to drive the
      // clickable funnel rows, including the "Joined but never logged in"
      // row that surfaces paying members who haven't opened the app yet.
      //
      // No tier filter: query #2 above (the funnel headline counts) dropped
      // the tier = 'preview' constraint so members who finished Day 1-3 then
      // upgraded to Unlimited still show in the funnel. This detail query
      // has to match — otherwise the counts and the clickable name lists
      // disagree (e.g., Saskia counts in Day 2 but is missing from the Day 2
      // detail list because her tier is now 'full').
      sql`
        SELECT
          u.email,
          u.display_name,
          u.tier::text AS tier,
          COALESCE(u.last_completed_day, 0)::int AS last_completed_day,
          u.first_login_at,
          u.created_at,
          u.preview_ends_at
        FROM users u
        WHERE u.kajabi_entitled = true
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR u.created_at <= ${toIso})
          AND (
            NOT EXISTS (SELECT 1 FROM purchases p WHERE LOWER(p.email) = LOWER(u.email))
            OR EXISTS (
              SELECT 1 FROM purchases p
              WHERE LOWER(p.email) = LOWER(u.email)
                AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
            )
          )
        ORDER BY
          CASE WHEN u.first_login_at IS NULL THEN 1 ELSE 0 END,
          u.last_completed_day DESC NULLS LAST,
          u.first_login_at DESC NULLS LAST
      `,
      // ===== Intelligence segments (6 sales/marketing-actionable buckets) =====
      // Each query returns the named members who currently fit the segment,
      // sorted so the most actionable ones are at the top of the list.
      // 18. Ready for upsell — high-engagement paid Unlimited members
      safeQuery(sql`
        SELECT
          u.id, u.email, u.display_name,
          COUNT(*) FILTER (WHERE m.role = 'user')::int AS messages_30d,
          MAX(m.created_at) AS last_message_at
        FROM users u
        JOIN messages m ON m.user_id = u.id
        JOIN sessions s ON s.id = m.session_id
        WHERE u.tier = 'full'
          AND s.session_type = 'unlimited'
          AND m.created_at > NOW() - INTERVAL '30 days'
          AND u.email IS NOT NULL AND u.email <> ''
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.email <> ALL(${extraExcluded})
          AND EXISTS (
            SELECT 1 FROM purchases p
            WHERE p.email = u.email
              AND p.event_type IN ('order.success', 'order.subscription_payment')
              AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
          )
        GROUP BY u.id, u.email, u.display_name
        HAVING COUNT(*) FILTER (WHERE m.role = 'user') >= 30
        ORDER BY messages_30d DESC
      `),
      // 19. Hot Reset graduate — completed Day 3 recently, still on
      // Reset tier. Window is weekend-aware:
      //   - Tue/Wed/Thu/Fri: 3 calendar days (base "peak" window)
      //   - Sat/Sun/Mon:     5 calendar days (bridges the weekend so a
      //                      Fri/Sat/Sun completion isn't dropped before
      //                      Geo can work it on Monday morning)
      // Anything older has lost the conversion heat and rolls into
      // nurture rather than the Convert Today segment.
      safeQuery(sql`
        SELECT
          u.id, u.email, u.display_name,
          MAX(dc.completed_at) AS day3_completed_at,
          MAX(p.coupon_code) AS coupon_used
        FROM users u
        JOIN day_completions dc ON dc.user_id = u.id
        LEFT JOIN purchases p ON p.email = u.email AND p.event_type IN ('order.success', 'order.subscription_payment')
        WHERE u.tier = 'preview'
          AND dc.day = 3
          AND u.email IS NOT NULL AND u.email <> ''
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.email <> ALL(${extraExcluded})
          AND EXISTS (
            SELECT 1 FROM purchases p2
            WHERE p2.email = u.email
              AND p2.event_type IN ('order.success', 'order.subscription_payment')
              AND COALESCE(p2.coupon_code, '') <> ALL(${excludedCoupons})
          )
        GROUP BY u.id, u.email, u.display_name
        HAVING MAX(dc.completed_at) >= NOW() - (
          CASE
            WHEN EXTRACT(DOW FROM NOW())::int IN (6, 0, 1) THEN INTERVAL '5 days'
            ELSE INTERVAL '3 days'
          END
        )
        ORDER BY day3_completed_at DESC
      `),
      // 20. Book Launch warmer — used LAUNCHTEAM coupons + showed engagement
      safeQuery(sql`
        SELECT DISTINCT
          u.id, u.email, u.display_name,
          string_agg(DISTINCT p.coupon_code, ', ') AS coupons,
          MAX(p.created_at) AS purchased_at,
          u.last_completed_day,
          u.tier::text AS tier
        FROM users u
        JOIN purchases p ON p.email = u.email
        WHERE p.event_type IN ('order.success', 'order.subscription_payment')
          AND p.coupon_code IN ('LAUNCHTEAM', 'LAUNCHTEAMUNLIMITED')
          AND u.email IS NOT NULL AND u.email <> ''
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.email <> ALL(${extraExcluded})
        GROUP BY u.id, u.email, u.display_name, u.last_completed_day, u.tier
        ORDER BY purchased_at DESC
      `),
      // 21. At-risk Unlimited subscriber — paid but quiet for 14+ days.
      //
      // Important: "quiet" is measured from the LATER of (a) their last
      // Unlimited message, (b) their first paid Unlimited purchase. This
      // gives fresh subscribers a built-in grace period — someone who
      // upgraded today shouldn't be flagged as at-risk just because they
      // haven't messaged yet. We also require their Unlimited tenure
      // (days since first paid Unlimited purchase) to be at least 14 so
      // brand-new subscribers never appear here at all.
      safeQuery(sql`
        WITH last_unlimited_msg AS (
          SELECT m.user_id, MAX(m.created_at) AS last_at
          FROM messages m
          JOIN sessions s ON s.id = m.session_id
          WHERE s.session_type = 'unlimited' AND m.role = 'user'
          GROUP BY m.user_id
        ),
        first_unlimited_purchase AS (
          SELECT p.email, MIN(p.created_at) AS subscribed_at
          FROM purchases p
          WHERE p.event_type IN ('order.success', 'order.subscription_payment')
            AND p.amount_cents > 0
            AND p.product_name ILIKE '%Unlimited%'
            AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
          GROUP BY p.email
        )
        SELECT
          u.id, u.email, u.display_name,
          u.subscription_plan,
          lm.last_at AS last_message_at,
          -- Use greatest(last message, subscribed_at) as the "last activity"
          -- baseline so a fresh sub with no messages reads as 0 days quiet
          -- (not "days since they signed up for Reset months ago").
          EXTRACT(DAY FROM (NOW() - GREATEST(
            COALESCE(lm.last_at, fp.subscribed_at),
            fp.subscribed_at
          )))::int AS days_quiet
        FROM users u
        JOIN first_unlimited_purchase fp ON fp.email = u.email
        LEFT JOIN last_unlimited_msg lm ON lm.user_id = u.id
        WHERE u.tier = 'full'
          AND u.email IS NOT NULL AND u.email <> ''
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.email <> ALL(${extraExcluded})
          -- Grace period: only flag subscribers who've been Unlimited
          -- for at least 14 days.
          AND fp.subscribed_at < NOW() - INTERVAL '14 days'
          -- And their Unlimited message activity has been quiet for 14d.
          AND (lm.last_at IS NULL OR lm.last_at < NOW() - INTERVAL '14 days')
        ORDER BY days_quiet DESC NULLS FIRST
      `),
      // 22. Stuck Reset — logged in but not completing within 3+ days.
      // Includes members whose preview window has already closed: they
      // still paid, still logged in, still never finished, and are still
      // valid re-engagement candidates. Bullet in the UI surfaces
      // whether the preview is still open or has expired so Geo can pick
      // the right outreach angle (nudge vs "extend your preview" offer).
      // Cap at 60 days since login so the segment doesn't accumulate
      // ancient members who are truly gone. Returns signup date,
      // completed-days array, and preview-window timing so the frontend
      // can show the full member picture without extra round-trips.
      safeQuery(sql`
        SELECT
          u.id, u.email, u.display_name,
          COALESCE(u.last_completed_day, 0)::int AS last_completed_day,
          u.created_at AS signed_up_at,
          u.first_login_at,
          u.preview_ends_at,
          (u.preview_ends_at > NOW()) AS preview_still_open,
          EXTRACT(DAY FROM (NOW() - u.first_login_at))::int AS days_since_login,
          (SELECT ARRAY_AGG(dc.day ORDER BY dc.day)
             FROM day_completions dc WHERE dc.user_id = u.id) AS days_completed
        FROM users u
        WHERE u.tier = 'preview'
          AND u.first_login_at IS NOT NULL
          AND u.first_login_at < NOW() - INTERVAL '3 days'
          AND u.first_login_at > NOW() - INTERVAL '60 days'
          -- Source of truth for "have they finished?" is day_completions
          -- itself, not the u.last_completed_day cache, which was going
          -- stale for members like Nihan (all 3 days done but cache read
          -- 1). Fully-completed members belong in the reset-alumni
          -- segment (need Unlimited upsell), not the stuck segment.
          AND (
            SELECT COUNT(DISTINCT dc2.day)
            FROM day_completions dc2 WHERE dc2.user_id = u.id
          ) < 3
          AND u.email IS NOT NULL AND u.email <> ''
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.email <> ALL(${extraExcluded})
          AND EXISTS (
            SELECT 1 FROM purchases p
            WHERE p.email = u.email
              AND p.event_type IN ('order.success', 'order.subscription_payment')
              AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
          )
        ORDER BY days_since_login DESC
      `),
      // 22.5 Reset alumni ready to upgrade — completed all 3 days but
      // haven't purchased Unlimited yet, and they're past the 72h "hot"
      // window so the Hot Reset graduates segment no longer includes
      // them. Prime upsell candidates: they know the work, they got the
      // full experience, they just need a nudge to keep going.
      safeQuery(sql`
        SELECT
          u.id, u.email, u.display_name,
          u.created_at AS signed_up_at,
          u.first_login_at,
          u.preview_ends_at,
          (u.preview_ends_at > NOW()) AS preview_still_open,
          MAX(dc.completed_at) AS day3_completed_at,
          EXTRACT(DAY FROM (NOW() - MAX(dc.completed_at)))::int AS days_since_day3,
          (SELECT ARRAY_AGG(dcx.day ORDER BY dcx.day)
             FROM day_completions dcx WHERE dcx.user_id = u.id) AS days_completed
        FROM users u
        JOIN day_completions dc ON dc.user_id = u.id
        WHERE u.tier = 'preview'
          AND u.email IS NOT NULL AND u.email <> ''
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.email <> ALL(${extraExcluded})
          AND (
            SELECT COUNT(DISTINCT dc2.day)
            FROM day_completions dc2 WHERE dc2.user_id = u.id
          ) >= 3
          -- Only alumni who finished more than 72h ago; anyone fresher
          -- is already surfacing in the Hot Reset graduates segment with
          -- the peak-conversion window messaging.
          AND (SELECT MAX(dc3.completed_at) FROM day_completions dc3
               WHERE dc3.user_id = u.id AND dc3.day = 3) < NOW() - INTERVAL '3 days'
          AND EXISTS (
            SELECT 1 FROM purchases p
            WHERE p.email = u.email
              AND p.event_type IN ('order.success', 'order.subscription_payment')
              AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
          )
        GROUP BY u.id, u.email, u.display_name, u.created_at,
                 u.first_login_at, u.preview_ends_at
        ORDER BY MAX(dc.completed_at) DESC
      `),
      // 23. High-intent buyer — multiple ThriveCart purchases (front-end stacked)
      safeQuery(sql`
        SELECT
          u.id, u.email, u.display_name,
          u.tier::text AS tier,
          COUNT(DISTINCT p.thrivecart_id)::int AS purchase_count,
          COALESCE(SUM(p.amount_cents), 0)::bigint AS total_cents,
          MAX(p.created_at) AS last_purchase_at
        FROM users u
        JOIN purchases p ON p.email = u.email
        WHERE p.event_type IN ('order.success', 'order.subscription_payment')
          AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
          AND u.email IS NOT NULL AND u.email <> ''
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.email <> ALL(${extraExcluded})
        GROUP BY u.id, u.email, u.display_name, u.tier
        HAVING COUNT(DISTINCT p.thrivecart_id) >= 2
        ORDER BY total_cents DESC
      `),
      // ===== Today's snapshot — split into 3 lightweight queries because a
      // single multi-subquery statement caused parameter-binding issues with
      // @vercel/postgres. Each query is independently safeQuery-wrapped so a
      // missing table never breaks the whole dashboard. The destructuring
      // order at the top expects these in this exact spot: todaySignups,
      // todayRevenue, todayActivity (positions 23/24/25 of Promise.all).
      // Do not interleave these with the segment queries — last time we did,
      // the array offset silently rendered the wrong segment's columns into
      // each card.
      safeQuery(sql`
        SELECT
          COUNT(*)::int AS signups_today,
          COUNT(*) FILTER (WHERE tier = 'preview')::int AS signups_today_reset,
          COUNT(*) FILTER (WHERE tier = 'full')::int AS signups_today_unlimited
        FROM users
        WHERE kajabi_entitled = true
          AND NOT (email LIKE ANY(${excludePatterns}))
          AND created_at >= date_trunc('day', NOW())
      `),
      safeQuery(sql`
        SELECT
          COALESCE(SUM(amount_cents), 0)::bigint AS revenue_today_cents,
          COUNT(*)::int AS orders_today,
          -- Distinct buyers who picked up Unlimited today. Drives the
          -- "Unlimited conversions" tile in Today's Highlights — catches
          -- returning customers (like Maria who upgraded from Reset) that
          -- the signups_today count misses.
          COUNT(DISTINCT email) FILTER (WHERE product_name ILIKE '%Unlimited%')::int AS unlimited_buyers_today,
          COUNT(DISTINCT email) FILTER (
            WHERE product_name ILIKE '%Unlimited%' AND product_name ILIKE '%Yearly%'
          )::int AS unlimited_yearly_today,
          COUNT(DISTINCT email) FILTER (
            WHERE product_name ILIKE '%Unlimited%' AND product_name NOT ILIKE '%Yearly%'
          )::int AS unlimited_monthly_today
        FROM purchases
        WHERE event_type IN ('order.success', 'order.subscription_payment')
          AND NOT (email LIKE ANY(${excludePatterns}))
          AND COALESCE(coupon_code, '') <> ALL(${excludedCoupons})
          AND amount_cents > 0
          AND created_at >= date_trunc('day', NOW())
          -- Field-only filter so today's revenue tile doesn't include
          -- unrelated MYP Business Club / Coaching Cert / RISE purchases
          -- (sold via the same ThriveCart account). Matches the same
          -- product scope as the "Net Revenue (ex VAT)" KPI below.
          AND product_name ILIKE ANY(${fieldProductPatterns})
      `),
      safeQuery(sql`
        SELECT
          (SELECT COUNT(*)::int FROM day_completions dc
             JOIN users u ON u.id = dc.user_id
             WHERE NOT (u.email LIKE ANY(${excludePatterns}))
               AND dc.completed_at >= date_trunc('day', NOW())) AS completions_today,
          -- Per-day breakdowns so Today's Highlights can show specific,
          -- meaningful tiles instead of a vague combined count. Day 3 is
          -- the launch goal — when it's > 0 the tile gets the accent
          -- treatment in the UI.
          (SELECT COUNT(DISTINCT dc.user_id)::int FROM day_completions dc
             JOIN users u ON u.id = dc.user_id
             WHERE NOT (u.email LIKE ANY(${excludePatterns}))
               AND dc.day = 1
               AND dc.completed_at >= date_trunc('day', NOW())) AS day1_today,
          (SELECT COUNT(DISTINCT dc.user_id)::int FROM day_completions dc
             JOIN users u ON u.id = dc.user_id
             WHERE NOT (u.email LIKE ANY(${excludePatterns}))
               AND dc.day = 2
               AND dc.completed_at >= date_trunc('day', NOW())) AS day2_today,
          (SELECT COUNT(DISTINCT dc.user_id)::int FROM day_completions dc
             JOIN users u ON u.id = dc.user_id
             WHERE NOT (u.email LIKE ANY(${excludePatterns}))
               AND dc.day = 3
               AND dc.completed_at >= date_trunc('day', NOW())) AS day3_today,
          (SELECT COUNT(DISTINCT m.user_id)::int FROM messages m
             JOIN sessions s ON s.id = m.session_id
             JOIN users u ON u.id = m.user_id
             WHERE NOT (u.email LIKE ANY(${excludePatterns}))
               AND s.session_type = 'unlimited'
               AND m.created_at >= date_trunc('day', NOW())
               AND EXISTS (
                 SELECT 1 FROM purchases p
                 WHERE p.email = u.email
                   AND p.event_type IN ('order.success', 'order.subscription_payment')
                   AND p.amount_cents > 0
                   AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
               )) AS active_unlimited_today,
          (SELECT COUNT(*)::int FROM messages m
             JOIN sessions s ON s.id = m.session_id
             JOIN users u ON u.id = m.user_id
             WHERE NOT (u.email LIKE ANY(${excludePatterns}))
               AND s.session_type = 'unlimited'
               AND m.role = 'user'
               AND m.created_at >= date_trunc('day', NOW())
               AND EXISTS (
                 SELECT 1 FROM purchases p
                 WHERE p.email = u.email
                   AND p.event_type IN ('order.success', 'order.subscription_payment')
                   AND p.amount_cents > 0
                   AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
               )) AS unlimited_messages_today
      `),
      // Member source breakdown — bucket every Kajabi-entitled member
      // in the current range by where they came from. Drives the
      // "Where members come from" overview tile so Geo can see at a
      // glance how many are from Meta ads vs organic vs email etc.
      // Bucket order matters — first matching CASE branch wins.
      sql`
        SELECT
          CASE
            WHEN LOWER(COALESCE(u.utm_campaign, '')) IN ('cold', 'warm')
              OR LOWER(COALESCE(u.utm_source, '')) IN ('meta', 'facebook', 'instagram', 'fb', 'ig')
              THEN 'Meta ads'
            WHEN LOWER(COALESCE(u.utm_source, '')) = 'power-reset'
              THEN 'Meta ads'
            WHEN LOWER(COALESCE(u.utm_medium, '')) = 'email'
              OR LOWER(COALESCE(u.utm_source, '')) LIKE '%email%'
              OR LOWER(COALESCE(u.utm_source, '')) LIKE '%newsletter%'
              OR LOWER(COALESCE(u.utm_source, '')) LIKE '%klaviyo%'
              OR LOWER(COALESCE(u.utm_source, '')) LIKE '%mailchimp%'
              OR LOWER(COALESCE(u.utm_source, '')) LIKE '%kajabi%'
              THEN 'Email'
            WHEN u.utm_source IS NOT NULL OR u.utm_campaign IS NOT NULL
              THEN 'Other tracked'
            ELSE 'Organic / Direct'
          END AS source_bucket,
          COUNT(*)::int AS members
        FROM users u
        WHERE u.kajabi_entitled = true
          AND NOT (u.email LIKE ANY(${excludePatterns}))
          AND u.created_at >= ${fromIso}
          AND (${toIso}::timestamptz IS NULL OR u.created_at <= ${toIso})
          AND (
            NOT EXISTS (SELECT 1 FROM purchases p WHERE LOWER(p.email) = LOWER(u.email))
            OR EXISTS (
              SELECT 1 FROM purchases p
              WHERE LOWER(p.email) = LOWER(u.email)
                AND COALESCE(p.coupon_code, '') <> ALL(${excludedCouponsFromMembers})
            )
          )
        GROUP BY source_bucket
        ORDER BY members DESC
      `,
      // 25. Reset → Unlimited conversion. Of all Reset buyers, how many
      // upgraded to Unlimited? Split by monthly vs yearly plan so Geo
      // can see the LTV mix of upgraders. Excludes team comps and tests
      // so the number reflects real customer behavior.
      //
      // Definition:
      //   Reset buyer    = bought ANY Reset purchase (any coupon except
      //                    GEO test comps) before/around the cutoff
      //   Converted      = same buyer ALSO has an Unlimited purchase
      //   Yearly/monthly = based on the Unlimited product_name suffix
      sql`
        WITH reset_buyers AS (
          SELECT DISTINCT LOWER(p.email) AS email
          FROM purchases p
          JOIN users u ON LOWER(u.email) = LOWER(p.email)
          WHERE p.event_type IN ('order.success', 'order.subscription_payment')
            AND p.product_name ILIKE '%Power Reset%'
            AND COALESCE(p.coupon_code, '') <> ALL(${excludedCouponsFromMembers})
            AND NOT (u.email LIKE ANY(${excludePatterns}))
            AND u.email <> ALL(${extraExcluded})
        ),
        unlimited_buyers AS (
          SELECT DISTINCT LOWER(p.email) AS email,
                 BOOL_OR(p.product_name ILIKE '%Yearly%') AS has_yearly,
                 BOOL_OR(p.product_name ILIKE '%Monthly%') AS has_monthly
          FROM purchases p
          WHERE p.event_type IN ('order.success', 'order.subscription_payment')
            AND p.amount_cents > 0
            AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
            AND (
              p.product_name ILIKE '%Unlimited%'
              OR p.product_name ILIKE '%Freedom Intelligence Field%'
            )
          GROUP BY LOWER(p.email)
        )
        SELECT
          (SELECT COUNT(*)::int FROM reset_buyers) AS total_reset_buyers,
          (SELECT COUNT(*)::int FROM reset_buyers r JOIN unlimited_buyers u ON r.email = u.email) AS converted_total,
          (SELECT COUNT(*)::int FROM reset_buyers r JOIN unlimited_buyers u ON r.email = u.email WHERE u.has_yearly) AS converted_yearly,
          (SELECT COUNT(*)::int FROM reset_buyers r JOIN unlimited_buyers u ON r.email = u.email WHERE u.has_monthly AND NOT u.has_yearly) AS converted_monthly
      `,
      // Channel P&L revenue attribution (cold / warm / whatsapp buckets).
      // Frontend combines this with data.realProfit for spend to compute ROAS.
      loadChannelRevenueAttribution(),
    ]);

    return res.status(200).json({
      asOf: new Date().toISOString(),
      viewer: { email: email, displayName: displayName },
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
      intelligence: {
        ready_for_upsell: segReadyForUpsell ? segReadyForUpsell.rows : [],
        hot_reset_graduate: segHotResetGrad ? segHotResetGrad.rows : [],
        book_launch_warmer: segBookLaunchWarmer ? segBookLaunchWarmer.rows : [],
        at_risk_subscriber: segAtRiskSubscriber ? segAtRiskSubscriber.rows : [],
        stuck_reset: segStuckReset ? segStuckReset.rows : [],
        reset_alumni: segResetAlumni ? segResetAlumni.rows : [],
        high_intent_buyer: segHighIntent ? segHighIntent.rows : [],
      },
      signupsByDay: signupsByDay.rows,
      unlimitedEngagement: unlimitedEngagement.rows[0],
      perUserUnlimited: perUserUnlimited.rows,
      recentSignups: recentSignups.rows,
      memberSourceBreakdown: memberSourceBreakdown ? memberSourceBreakdown.rows : [],
      resetToUnlimitedConversion: resetToUnlimitedConversion ? resetToUnlimitedConversion.rows[0] : null,
      // Channel P&L revenue attribution grouped by first-touch UTM channel.
      // Consumed by the Overview widget alongside data.realProfit for spend.
      channelAttribution: channelAttribution || {
        cold: { signups: 0, buyers: 0, upgraded: 0, reset_revenue_cents: 0, activation_revenue_cents: 0, unlimited_revenue_cents: 0, total_revenue_cents: 0 },
        warm: { signups: 0, buyers: 0, upgraded: 0, reset_revenue_cents: 0, activation_revenue_cents: 0, unlimited_revenue_cents: 0, total_revenue_cents: 0 },
        whatsapp: { signups: 0, buyers: 0, upgraded: 0, reset_revenue_cents: 0, activation_revenue_cents: 0, unlimited_revenue_cents: 0, total_revenue_cents: 0 },
        other: { signups: 0, buyers: 0, upgraded: 0, reset_revenue_cents: 0, activation_revenue_cents: 0, unlimited_revenue_cents: 0, total_revenue_cents: 0 },
      },
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
      monthlyCosts: await fetchMonthlyCosts(),
    });
  } catch (err) {
    console.error("admin_metrics_error", { message: err?.message });
    return res.status(500).json({ error: "server_error", message: err?.message });
  }
}

// Wrap a promise so a missing-table error (purchases not created yet) resolves
// to null instead of crashing the whole metrics fan-out. Real errors still log.
// Pull the monthly cost snapshot — one row per service (GHL, Anthropic,
// Channel P&L revenue attribution. Groups every buyer by their first-touch
// UTM into one of three channels (cold ads / warm ads / whatsapp) and sums
// their lifetime purchases split by product (Reset, Activation, Unlimited)
// so the Overview widget can show spend vs revenue per channel.
//
// Attribution logic:
//   - Cold ads:  utm_campaign = 'cold'
//   - Warm ads:  utm_campaign = 'warm'
//   - WhatsApp:  utm_source = 'whatsapp' OR no utm at all (legacy
//                organic/past-WhatsApp bucket per Geo's Jul 2026 decision;
//                Google organic detection is a future add via landing_events.referrer)
//   - Other:     anything else (dropped from the widget, still queryable)
//
// The result is combined on the frontend with data.realProfit.breakdown.ads
// (for cold/warm spend) and data.realProfit.breakdown.ops (for WhatsApp
// spend = GHL + per-message costs) to compute ROAS per channel.
async function loadChannelRevenueAttribution() {
  const excludedCoupons = EXCLUDED_COUPONS;
  try {
    const { rows } = await sql`
      WITH user_channel AS (
        SELECT
          u.id,
          LOWER(u.email) AS email_lc,
          CASE
            WHEN LOWER(COALESCE(u.utm_campaign, '')) = 'cold'    THEN 'cold'
            WHEN LOWER(COALESCE(u.utm_campaign, '')) = 'warm'    THEN 'warm'
            WHEN LOWER(COALESCE(u.utm_source, ''))   = 'whatsapp' THEN 'whatsapp'
            WHEN COALESCE(u.utm_source, '') = ''
              AND COALESCE(u.utm_campaign, '') = ''              THEN 'whatsapp'
            ELSE 'other'
          END AS channel
        FROM users u
        WHERE u.email IS NOT NULL AND u.email <> ''
          AND u.email NOT LIKE '%@shimritnativ.com'
          -- Match the "Total Members" KPI: only count real Field members
          -- (paid Reset preview tier + paid Unlimited full tier), not all
          -- users in the DB (Kajabi grants, mailing list, guests, etc.).
          -- Without this, "signups per channel" was inflated to ~131 for
          -- WhatsApp vs. the true member count of ~42.
          AND u.tier::text IN ('preview', 'full')
      ),
      per_user AS (
        SELECT
          uc.channel,
          uc.email_lc,
          SUM(CASE WHEN p.product_name ILIKE '%Reset%'      THEN p.amount_cents ELSE 0 END)::bigint AS reset_cents,
          SUM(CASE WHEN p.product_name ILIKE '%Activation%' THEN p.amount_cents ELSE 0 END)::bigint AS activation_cents,
          SUM(CASE
            WHEN p.product_name ILIKE '%Unlimited%'
              OR p.product_name ILIKE '%Freedom%Field%'
              OR p.event_type = 'order.subscription_payment'
            THEN p.amount_cents ELSE 0 END)::bigint AS unlimited_cents,
          BOOL_OR(
            p.product_name ILIKE '%Unlimited%'
            OR p.product_name ILIKE '%Freedom%Field%'
            OR p.event_type = 'order.subscription_payment'
          ) AS is_upgrader
        FROM user_channel uc
        LEFT JOIN purchases p
          ON LOWER(p.email) = uc.email_lc
          AND p.event_type IN ('order.success', 'order.subscription_payment')
          AND p.amount_cents > 0
          AND COALESCE(p.coupon_code, '') <> ALL(${excludedCoupons})
        GROUP BY uc.channel, uc.email_lc
      )
      SELECT
        channel,
        COUNT(*)::int AS signups,
        COUNT(*) FILTER (
          WHERE reset_cents > 0 OR activation_cents > 0 OR unlimited_cents > 0
        )::int AS buyers,
        COUNT(*) FILTER (WHERE is_upgrader = true)::int AS upgraded,
        COALESCE(SUM(reset_cents), 0)::bigint AS reset_revenue_cents,
        COALESCE(SUM(activation_cents), 0)::bigint AS activation_revenue_cents,
        COALESCE(SUM(unlimited_cents), 0)::bigint AS unlimited_revenue_cents,
        (COALESCE(SUM(reset_cents), 0)
          + COALESCE(SUM(activation_cents), 0)
          + COALESCE(SUM(unlimited_cents), 0))::bigint AS total_revenue_cents
      FROM per_user
      GROUP BY channel
    `;
    const byChannel = { cold: null, warm: null, whatsapp: null, other: null };
    for (const r of rows) {
      byChannel[r.channel] = {
        signups: Number(r.signups),
        buyers: Number(r.buyers),
        upgraded: Number(r.upgraded),
        reset_revenue_cents: Number(r.reset_revenue_cents),
        activation_revenue_cents: Number(r.activation_revenue_cents),
        unlimited_revenue_cents: Number(r.unlimited_revenue_cents),
        total_revenue_cents: Number(r.total_revenue_cents),
      };
    }
    // Empty shape so the frontend can always destructure. If a channel
    // has no signups yet (e.g. warm ads before first buyer), we return
    // zeros rather than null so the widget renders cleanly.
    const empty = {
      signups: 0, buyers: 0, upgraded: 0,
      reset_revenue_cents: 0, activation_revenue_cents: 0,
      unlimited_revenue_cents: 0, total_revenue_cents: 0,
    };
    return {
      cold: byChannel.cold || empty,
      warm: byChannel.warm || empty,
      whatsapp: byChannel.whatsapp || empty,
      other: byChannel.other || empty,
    };
  } catch (e) {
    console.warn("channel_revenue_attribution_failed", e?.message);
    return null;
  }
}

// Vercel, etc.). Used by the Launch Tracker to auto-fill its operational
// cost fields without making the admin maintain costs in two places.
// Returns an empty array if the table doesn't exist yet so callers don't
// crash before migration 007 has been run.
async function fetchMonthlyCosts() {
  try {
    const { rows } = await sql`
      SELECT service_key, amount::text, currency, notes, updated_at
      FROM monthly_costs
      ORDER BY service_key
    `;
    return rows.map(r => ({
      service_key: r.service_key,
      amount: Number(r.amount || 0),
      currency: r.currency || "USD",
      notes: r.notes || "",
      updated_at: r.updated_at || null,
    }));
  } catch (err) {
    // Table missing or unreachable — return empty so the dashboard still
    // renders. The admin will see zeros in the snapshot panel until they
    // run migration 007.
    return [];
  }
}

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
