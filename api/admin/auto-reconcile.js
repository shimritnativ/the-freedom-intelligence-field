// api/admin/auto-reconcile.js
// Self-healing reconciliation. Runs on a cron and catches sales where
// the ThriveCart webhook never fired but Kajabi correctly granted
// access. For each gap:
//   1. Insert a placeholder purchase row with sensible default amount
//      (tier + plan + current launch context drives the default)
//   2. Mark it raw_payload.needs_verification = true so the admin can
//      audit and correct the amount/coupon later
//   3. Fire a push notification to every @shimritnativ.com admin
//
// Why we need this: ThriveCart webhooks have been dropping silently —
// at least four sales lost in a single day. Kajabi's activation
// webhook is more reliable AND comes through with the user's tier
// info, so we can use it as a fallback signal that money changed
// hands. Defaults will be wrong for free comps and non-default
// coupons; the verification flag tells the admin which rows to audit.
//
// Auth:
//   - Vercel-cron User-Agent (auto, the primary trigger)
//   - ADMIN_TOKEN via header/query (manual trigger for testing)
//   - x-session-token from @shimritnativ.com (manual trigger from admin UI)
//
// Cron schedule lives in vercel.json — every 10 minutes is the sweet
// spot: tight enough that Geo's phone pings within ~10 min of a
// missing sale, sparse enough that the cost is negligible.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";
import { sendPushToUser } from "../../lib/push.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

// How long to wait after a Kajabi activation before declaring the
// ThriveCart webhook a no-show. ThriveCart usually fires within
// seconds, but we've seen rare 5-minute lags. 15 min is the safe
// threshold — anything later than that is genuinely missing.
const GRACE_WINDOW_MINUTES = 15;

// How far back to look for orphan activations. 24 hours covers a full
// day of misses while keeping the query indexed and fast.
const LOOKBACK_HOURS = 24;

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-admin-token");

  // Auth.
  const adminToken = process.env.ADMIN_TOKEN;
  const providedAdminToken =
    (req.headers && req.headers["x-admin-token"]) ||
    (req.query && req.query.token) ||
    "";
  const sessionToken = req.headers["x-session-token"];
  const userAgent = String(req.headers["user-agent"] || "");
  let authorized = userAgent.includes("vercel-cron");
  if (!authorized && adminToken && providedAdminToken === adminToken) {
    authorized = true;
  } else if (!authorized && sessionToken) {
    const user = await getUserBySessionToken(sessionToken);
    if (user && (user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
      authorized = true;
    }
  }
  if (!authorized) return res.status(401).json({ error: "unauthorized" });

  try {
    // Find every Kajabi activation in the last 24h where:
    //   - We have a user record for the email
    //   - The activation is older than the 15min grace window
    //   - No purchase row exists for that email within ±2h of the activation
    //   - We haven't already auto-created a placeholder for them
    // The ±2h window catches both early ThriveCart fires (rare) and
    // late ones; the user identity is the email, which both sides share.
    //
    // Note on intervals: @vercel/postgres parameterizes interpolations,
    // so they must be passed as cast strings ("24 hours"::interval)
    // rather than embedded inside INTERVAL '24 hours' literals.
    const lookback = `${LOOKBACK_HOURS} hours`;
    const grace = `${GRACE_WINDOW_MINUTES} minutes`;
    const { rows: gaps } = await sql`
      WITH activations AS (
        SELECT
          LOWER((we.payload::jsonb->>'member_email')) AS email,
          we.event_type,
          we.processed_at
        FROM webhook_events we
        WHERE we.source = 'kajabi'
          AND we.event_type LIKE 'activate:%'
          AND we.processed_at > NOW() - ${lookback}::interval
          AND we.processed_at < NOW() - ${grace}::interval
      ),
      latest_per_user AS (
        SELECT DISTINCT ON (email)
          email, event_type, processed_at
        FROM activations
        ORDER BY email, processed_at DESC
      )
      SELECT
        lpu.email,
        lpu.event_type AS activation_event,
        lpu.processed_at AS activated_at,
        u.id AS user_id,
        u.tier::text AS tier,
        u.subscription_plan
      FROM latest_per_user lpu
      JOIN users u ON LOWER(u.email) = lpu.email
      WHERE NOT EXISTS (
        -- No ThriveCart purchase landed for this email near the
        -- activation moment — webhook genuinely missed.
        SELECT 1 FROM purchases p
        WHERE LOWER(p.email) = lpu.email
          AND p.created_at BETWEEN lpu.processed_at - INTERVAL '2 hours'
                               AND lpu.processed_at + INTERVAL '2 hours'
      )
      AND NOT EXISTS (
        -- We haven't already auto-created a placeholder for them in
        -- this activation window — prevents the cron from spamming
        -- the same gap over and over.
        SELECT 1 FROM purchases p
        WHERE LOWER(p.email) = lpu.email
          AND (p.raw_payload->>'auto_created')::boolean = true
          AND p.created_at > lpu.processed_at - INTERVAL '1 day'
      )
    `;

    const summary = {
      gaps_found: gaps.length,
      placeholders_created: 0,
      notifications_sent: 0,
      errors: 0,
      details: [],
    };

    for (const g of gaps) {
      try {
        const defaults = inferDefaults(g.tier, g.subscription_plan, g.activation_event);
        const syntheticId = `AUTO-${g.user_id}-${Math.floor(new Date(g.activated_at).getTime() / 1000)}`;

        const raw = {
          auto_created: true,
          source: "auto_reconcile_cron",
          activation_event: g.activation_event,
          activated_at: g.activated_at,
          needs_verification: true,
          default_basis: defaults.basis,
          created_at: new Date().toISOString(),
        };

        await sql`
          INSERT INTO purchases (
            thrivecart_id, event_type, email,
            product_name, amount_cents, currency, coupon_code,
            raw_payload
          ) VALUES (
            ${syntheticId},
            'order.success',
            ${g.email},
            ${defaults.product_name},
            ${defaults.amount_cents},
            'EUR',
            ${defaults.coupon_code},
            ${JSON.stringify(raw)}::jsonb
          )
          ON CONFLICT (thrivecart_id, event_type) DO NOTHING
        `;
        summary.placeholders_created++;
        summary.details.push({
          email: g.email,
          tier: g.tier,
          plan: g.subscription_plan,
          default_amount_eur: defaults.amount_cents / 100,
          default_coupon: defaults.coupon_code,
          basis: defaults.basis,
        });

        // Fire push notifications to every @shimritnativ.com admin with
        // a push subscription. The notification CTA deep-links into the
        // admin manual-purchase form so a tap → verify in seconds.
        try {
          const { rows: admins } = await sql`
            SELECT DISTINCT u.id, u.email
            FROM users u
            JOIN push_subscriptions ps ON ps.user_id = u.id
            WHERE LOWER(u.email) LIKE ${"%" + ALLOWED_DOMAIN}
          `;
          for (const a of admins) {
            const sent = await sendPushToUser({
              userId: a.id,
              payload: {
                title: "Missing ThriveCart webhook auto-filled",
                body: `${g.email} — ${g.activation_event.replace("activate:", "")}. Defaulted to €${(defaults.amount_cents / 100).toFixed(2)}. Tap to verify.`,
                url: `/admin?verify=${encodeURIComponent(syntheticId)}`,
                tag: `auto-reconcile-${syntheticId}`,
                requireInteraction: false,
              },
              notificationKey: `auto-reconcile-${syntheticId}`,
            });
            if (sent.sent > 0) summary.notifications_sent++;
          }
        } catch (notifyErr) {
          // Notification failure shouldn't roll back the placeholder.
          console.warn("auto_reconcile_notify_failed", {
            email: g.email,
            error: notifyErr?.message,
          });
        }
      } catch (err) {
        summary.errors++;
        console.warn("auto_reconcile_gap_error", {
          email: g.email,
          error: err?.message,
        });
      }
    }

    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error("auto_reconcile_error", { message: err?.message });
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message,
    });
  }
}

// =============================================================================
// inferDefaults — pick a sensible amount/coupon based on tier + plan
// =============================================================================
//
// The defaults assume the dominant pricing path in the current launch
// (POWER50 for Reset, LAUNCHTEAMUNLIMITED for Unlimited upgrades). The
// admin can correct any individual placeholder via the manual-purchase
// form (which will UPSERT on the same synthetic id and overwrite).
//
// Stored as GROSS cents to match how ThriveCart webhooks store amounts.

function inferDefaults(tier, plan, activationEvent) {
  if (tier === "full" && plan === "yearly") {
    // Yearly Unlimited — assume full price €777. Antonella's invoice
    // shows the standard yearly offer is €777 (sometimes with a 10%-
    // off promo applied to year 1). For LAUNCHTEAMUNLIMITED yearly at
    // €190.40 (Sofie's case), Geo edits manually. €777 covers the
    // common case better post-launch.
    return {
      product_name: "The Freedom Intelligence Field - Unlimited (Yearly)",
      amount_cents: 77700,
      coupon_code: null,
      basis: "default: yearly full price (€777 gross)",
    };
  }
  if (tier === "full" && plan === "monthly") {
    // Monthly Unlimited — full price €77.
    return {
      product_name: "The Freedom Intelligence Field - Unlimited (Monthly)",
      amount_cents: 7700,
      coupon_code: null,
      basis: "default: monthly full price (€77 gross)",
    };
  }
  if (tier === "preview") {
    // Reset — POWER50 launch price (€4.50 gross). During the active
    // launch wave most Reset buyers use POWER50; full-price €9 buyers
    // are the exception. Geo edits if needed.
    return {
      product_name: "The Power Reset",
      amount_cents: 450,
      coupon_code: "POWER50",
      basis: "default: POWER50 Reset (€4.50 gross)",
    };
  }
  // Shouldn't hit this — but if tier/plan combo is unknown, default to
  // €0 and flag for review. Better to make Geo enter the amount than
  // to invent one.
  return {
    product_name: "Unknown product (auto-reconcile placeholder)",
    amount_cents: 0,
    coupon_code: null,
    basis: "no default match — needs manual entry",
  };
}
