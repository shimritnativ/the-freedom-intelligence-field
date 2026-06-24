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
import { notifyAdmins } from "../../lib/adminNotify.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

// How long to wait after a Kajabi activation before declaring the
// ThriveCart webhook a no-show. ThriveCart usually fires within
// seconds. 5 min covers the rare lag we've seen without making Geo
// wait forever to see fresh sales. The Refresh button passes
// ?force=1 to bypass this entirely for immediate manual triggers.
const GRACE_WINDOW_MINUTES = 5;

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
    // Force mode bypasses the grace window so the Refresh button can
    // immediately reconcile sales that JUST landed without waiting 5min.
    // Used by the admin Refresh button — Geo just saw a sale come in
    // and wants it on the dashboard NOW, not in 5 minutes.
    const force = req.query && (req.query.force === "1" || req.query.force === "true");
    const lookback = `${LOOKBACK_HOURS} hours`;
    const grace = force ? "0 seconds" : `${GRACE_WINDOW_MINUTES} minutes`;
    const { rows: gaps } = await sql`
      WITH activations AS (
        SELECT
          LOWER((we.payload::jsonb->>'member_email')) AS email,
          we.event_type,
          -- _product is set by the Kajabi handler when the offer URL
          -- includes ?product=reset|activation|unlimited. Falls back to
          -- whatever's after the second colon in event_type (e.g.
          -- activate:preview:reset -> reset), then to NULL for legacy
          -- events with no product tag.
          COALESCE(
            NULLIF(LOWER(we.payload::jsonb->>'_product'), ''),
            NULLIF(LOWER(SPLIT_PART(we.event_type, ':', 3)), ''),
            NULL
          ) AS product,
          we.processed_at
        FROM webhook_events we
        WHERE we.source = 'kajabi'
          AND we.event_type LIKE 'activate:%'
          AND we.processed_at > NOW() - ${lookback}::interval
          AND we.processed_at < NOW() - ${grace}::interval
      ),
      latest_per_user AS (
        -- One row per (email, product) so a user who bought Reset AND
        -- Activation in one checkout gets TWO placeholders. Previously
        -- this keyed on (email, event_type), which collapsed identical
        -- event_types like two "activate:preview" rows into one and lost
        -- the second product entirely (Kaija: Reset + Activation both
        -- missed → only Reset placeholder was created at €4.50, hiding
        -- the €16.99 Activation purchase). When product is NULL (legacy
        -- URLs without ?product=), falls back to event_type for dedup.
        SELECT DISTINCT ON (email, COALESCE(product, event_type))
          email, event_type, product, processed_at
        FROM activations
        ORDER BY email, COALESCE(product, event_type), processed_at DESC
      )
      SELECT
        lpu.email,
        lpu.event_type AS activation_event,
        lpu.product AS product_tag,
        lpu.processed_at AS activated_at,
        u.id AS user_id,
        u.tier::text AS tier,
        u.subscription_plan
      FROM latest_per_user lpu
      JOIN users u ON LOWER(u.email) = lpu.email
      WHERE NOT EXISTS (
        -- No real purchase exists for this email + product near the
        -- activation moment. We match on the inferred product name so
        -- buying Reset + Activation in one checkout doesn't suppress
        -- the second placeholder just because the first product's
        -- ThriveCart row landed. When product is NULL (legacy URLs),
        -- fall back to "any purchase in the window" to preserve the
        -- old behavior and avoid duplicates.
        SELECT 1 FROM purchases p
        WHERE LOWER(p.email) = lpu.email
          AND p.created_at BETWEEN lpu.processed_at - INTERVAL '2 hours'
                               AND lpu.processed_at + INTERVAL '2 hours'
          AND (
            lpu.product IS NULL
            OR LOWER(p.product_name) LIKE '%' || lpu.product || '%'
          )
      )
      AND NOT EXISTS (
        -- We haven't already auto-created a placeholder for THIS
        -- specific (email, product) in the window. Keyed on product
        -- when present, falls back to activation_event for legacy.
        SELECT 1 FROM purchases p
        WHERE LOWER(p.email) = lpu.email
          AND (p.raw_payload->>'auto_created')::boolean = true
          AND COALESCE(p.raw_payload->>'product_tag', p.raw_payload->>'activation_event')
              = COALESCE(lpu.product, lpu.event_type)
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
        const defaults = inferDefaults(g.tier, g.subscription_plan, g.activation_event, g.email, g.product_tag);
        // Include product tag in the synthetic id so the same email
        // activating Reset and Activation in the same second produces
        // two distinct purchase rows (ON CONFLICT was collapsing them).
        const productSuffix = g.product_tag ? `-${g.product_tag}` : "";
        const syntheticId = `AUTO-${g.user_id}-${Math.floor(new Date(g.activated_at).getTime() / 1000)}${productSuffix}`;

        const raw = {
          auto_created: true,
          source: "auto_reconcile_cron",
          activation_event: g.activation_event,
          product_tag: g.product_tag || null,
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

        // Notify admins on REAL placeholders (anything that's not a
        // LAUNCHTEAM €0 comp). Why: ThriveCart webhooks have been
        // dropping silently. When auto-reconcile catches the gap, the
        // regular "new sale" push from the ThriveCart webhook handler
        // never ran, so Geo gets no signal. Without a ping here, the
        // sale only surfaces on the next dashboard refresh and the
        // amount is a default placeholder she may not realize needs
        // verifying. Keep LAUNCHTEAM silent: routine comps, not money.
        const isComp = defaults.coupon_code === "LAUNCHTEAM"
          || defaults.coupon_code === "LAUNCHTEAMUNLIMITED"
          || defaults.amount_cents === 0;
        if (!isComp) {
          try {
            const r = await notifyAdmins({
              title: "Sale recovered (ThriveCart webhook dropped)",
              body: `${g.email}: ${defaults.product_name}, default €${(defaults.amount_cents / 100).toFixed(2)}. Verify the real amount in the roster.`,
              url: "/admin#members",
              tag: `auto-recon-${syntheticId}`,
              notificationKey: `auto-recon-${syntheticId}`,
              requireInteraction: false,
            });
            if (r && r.sent_count > 0) summary.notifications_sent++;
          } catch (e) {
            console.warn("auto_reconcile_notify_failed", e?.message);
          }
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

// LAUNCHTEAM email allowlist. Anyone on this list gets a €0 LAUNCHTEAM
// placeholder when auto-reconcile fires, instead of the POWER50 €4.50
// default. Sourced from the LAUNCHTEAM_EMAILS env var (comma-separated)
// so it can be updated without redeploying — set it in Vercel project
// env vars: LAUNCHTEAM_EMAILS="alex@a.com,bob@b.com,..."
//
// Why an allowlist instead of detecting comp status from the webhook?
// Kajabi activation events carry no coupon info (only grant=preview /
// grant=full). We have no way to tell "this user came via LAUNCHTEAM"
// from the activation alone. The allowlist is a small, low-maintenance
// way to keep team comps from being miscounted as paying customers.
function isLaunchteamEmail(email) {
  if (!email) return false;
  const list = String(process.env.LAUNCHTEAM_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(String(email).trim().toLowerCase());
}

function inferDefaults(tier, plan, activationEvent, email, productTag) {
  // STRONGEST SIGNAL: the explicit product tag from the Kajabi webhook
  // URL (?product=reset|activation|unlimited). Set by the admin in
  // Kajabi offer settings. When present, this is authoritative and
  // overrides every other heuristic. NULL for legacy URLs that don't
  // include ?product= — those fall through to the event_type and tier
  // inference below.
  const tag = String(productTag || "").toLowerCase().trim();

  // ZERO-TH check: is this email on the LAUNCHTEAM comp allowlist?
  // If yes, this is a team comp regardless of what tier or activation
  // event we see. Create a €0 LAUNCHTEAM placeholder so the existing
  // excludedCoupons filter automatically drops the row from revenue
  // and member counts (matches how a real LAUNCHTEAM webhook would
  // have landed if it hadn't missed).
  if (isLaunchteamEmail(email)) {
    const ev = String(activationEvent || "").toLowerCase();
    const isUnlimited = tag === "unlimited" || ev.includes("unlimited") || tier === "full";
    return {
      product_name: isUnlimited
        ? "The Freedom Intelligence Field - Unlimited (LAUNCHTEAM comp)"
        : "The Power Reset (LAUNCHTEAM comp)",
      amount_cents: 0,
      coupon_code: isUnlimited ? "LAUNCHTEAMUNLIMITED" : "LAUNCHTEAM",
      basis: "email on LAUNCHTEAM allowlist → €0 comp placeholder",
    };
  }

  // If the product tag is set, trust it 100%. This is the path we want
  // every new sale to take going forward (after Kajabi URLs updated).
  if (tag === "reset" || tag === "power-reset" || tag === "power_reset") {
    return {
      product_name: "The Power Reset",
      amount_cents: 900,
      coupon_code: null,
      basis: "Kajabi URL tagged product=reset → €9.00 gross (full price, no coupon)",
    };
  }
  if (tag === "activation" || tag === "power-activation" || tag === "power_activation") {
    return {
      product_name: "The Power Activation",
      amount_cents: 1699,
      coupon_code: null,
      basis: "Kajabi URL tagged product=activation → €16.99 gross",
    };
  }
  if (tag === "unlimited" || tag === "field-unlimited") {
    if (plan === "yearly") {
      return {
        product_name: "The Freedom Intelligence Field - Unlimited (Yearly)",
        amount_cents: 77700,
        coupon_code: null,
        basis: "Kajabi URL tagged product=unlimited + plan=yearly → €777 gross",
      };
    }
    return {
      product_name: "The Freedom Intelligence Field - Unlimited (Monthly)",
      amount_cents: 7700,
      coupon_code: null,
      basis: "Kajabi URL tagged product=unlimited + plan=monthly → €77 gross",
    };
  }

  // LEGACY FALLBACK: the Kajabi activation event itself names the product.
  // Reading this BEFORE the user's current tier means a Reset buyer who
  // later upgrades to Unlimited still gets a Reset placeholder for the
  // Reset activation (and a separate Unlimited placeholder for the
  // Unlimited activation), instead of both activations being collapsed
  // into a single Unlimited-tier inference.
  // Antonella's case: she bought Reset (€4.50 POWER50) THEN upgraded to
  // Unlimited Yearly. Both webhooks missed. Old logic looked at her
  // current tier=full and created an Unlimited placeholder for both
  // activations, hiding the Reset purchase entirely.
  const ev = String(activationEvent || "").toLowerCase();
  // Check Power Activation BEFORE Reset, because both contain shared
  // word fragments and "activation" is the more specific match.
  // Power Activation is a Kajabi-native upsell to Reset (€16.99 gross
  // standard price). Without this, Activation buyers got either a Reset
  // placeholder or fell through to "Unknown product" and lost €16.99
  // of attributable revenue per sale.
  if (ev.includes("power_activation") || ev.includes("power-activation") || ev.includes("activation")) {
    return {
      product_name: "The Power Activation",
      amount_cents: 1699,
      coupon_code: null,
      basis: "activation event indicates Power Activation (€16.99 gross default)",
    };
  }
  if (ev.includes("power_reset") || ev.includes("power-reset") || ev.includes("reset")) {
    return {
      product_name: "The Power Reset",
      amount_cents: 450,
      coupon_code: "POWER50",
      basis: "activation event indicates Reset (POWER50 default €4.50 gross)",
    };
  }
  if (ev.includes("unlimited")) {
    // Sub-classify yearly vs monthly via the user's plan field — by the
    // time an Unlimited activation arrives the subscription_plan column
    // is set, so this is reliable.
    if (plan === "yearly") {
      return {
        product_name: "The Freedom Intelligence Field - Unlimited (Yearly)",
        amount_cents: 77700,
        coupon_code: null,
        basis: "activation event indicates Unlimited Yearly (€777 gross default)",
      };
    }
    return {
      product_name: "The Freedom Intelligence Field - Unlimited (Monthly)",
      amount_cents: 7700,
      coupon_code: null,
      basis: "activation event indicates Unlimited Monthly (€77 gross default)",
    };
  }

  // FALLBACK: if the activation event string is opaque, fall back to
  // tier-based inference (the original behavior). Still a reasonable
  // guess for the common single-product case.
  if (tier === "full" && plan === "yearly") {
    return {
      product_name: "The Freedom Intelligence Field - Unlimited (Yearly)",
      amount_cents: 77700,
      coupon_code: null,
      basis: "fallback: tier=full plan=yearly → €777 gross",
    };
  }
  if (tier === "full" && plan === "monthly") {
    return {
      product_name: "The Freedom Intelligence Field - Unlimited (Monthly)",
      amount_cents: 7700,
      coupon_code: null,
      basis: "fallback: tier=full plan=monthly → €77 gross",
    };
  }
  if (tier === "preview") {
    return {
      product_name: "The Power Reset",
      amount_cents: 450,
      coupon_code: "POWER50",
      basis: "fallback: tier=preview → POWER50 Reset (€4.50 gross)",
    };
  }
  return {
    product_name: "Unknown product (auto-reconcile placeholder)",
    amount_cents: 0,
    coupon_code: null,
    basis: "no default match — needs manual entry",
  };
}
