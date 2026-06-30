// api/admin/ads-metrics.js
//
// Meta (Facebook) Ads metrics for the admin dashboard. Pulls campaign-
// level performance from the Meta Graph API, combines it with our own
// signup data (via UTMs), and returns a single payload the Ads tab can
// render without further computation client-side.
//
// REQUIRED Vercel env vars:
//   META_ADS_ACCESS_TOKEN  — long-lived access token with ads_read scope
//   META_ADS_ACCOUNT_ID    — Meta ad account ID, e.g. "act_1234567890"
//                             (must include the "act_" prefix)
//
// OPTIONAL env vars:
//   META_ADS_API_VERSION   — defaults to v22.0
//
// Auth: same @shimritnativ.com session gate as the rest of the admin.
//
// Query params:
//   ?range=today | 7d | 30d | lifetime           (default: 7d)
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD                (overrides ?range)
//
// Returns:
//   {
//     ok: true,
//     range: { from, to, label },
//     totals: { spend, impressions, clicks, ctr, cpc, cpm,
//               signups_attributed, cost_per_signup,
//               revenue_attributed_cents, roas },
//     campaigns: [
//       { id, name, status, spend, impressions, clicks, ctr, cpc, cpm,
//         signups_attributed, cost_per_signup, revenue_attributed_cents, roas }
//     ],
//     daily: [
//       { date, spend, impressions, clicks, signups, revenue_cents }
//     ],
//     meta: { fetched_at, account_id }
//   }

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
// v22.0 — confirmed working for this account via direct browser test.
// Earlier attempts on v19.0 returned "(#100) nonexisting field"
// errors across every endpoint, likely because the account's app is
// pinned to a newer min-version. v22 is also the latest GA so it's
// what new Meta apps default to today.
const DEFAULT_API_VERSION = "v22.0";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Auth — same session gate as every other admin endpoint.
  const sessionToken = req.headers["x-session-token"];
  const user = await getUserBySessionToken(sessionToken);
  if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const accessToken = process.env.META_ADS_ACCESS_TOKEN;
  const rawAccountId = process.env.META_ADS_ACCOUNT_ID;
  if (!accessToken || !rawAccountId) {
    return res.status(500).json({
      error: "ads_not_configured",
      hint: "Set META_ADS_ACCESS_TOKEN and META_ADS_ACCOUNT_ID in Vercel env vars.",
    });
  }
  // Meta ad account IDs MUST be prefixed with `act_` when used in URLs.
  // Without the prefix, Meta treats the bare number as a generic Graph
  // object and then complains that `insights`/`campaigns` are "non-
  // existing fields" on it. Auto-prepend if missing so a typo in the
  // env var doesn't break the whole tab.
  const accountId = String(rawAccountId).trim().startsWith("act_")
    ? String(rawAccountId).trim()
    : "act_" + String(rawAccountId).trim().replace(/^act_/i, "");
  const apiVersion = process.env.META_ADS_API_VERSION || DEFAULT_API_VERSION;

  // Resolve date range. "today" = just today UTC; "7d" / "30d" = last N
  // full days INCLUDING today. Custom from/to overrides any preset.
  const range = String(req.query?.range || "7d").toLowerCase();
  const fromOverride = String(req.query?.from || "").trim();
  const toOverride = String(req.query?.to || "").trim();
  const { from, to, label } = resolveRange(range, fromOverride, toOverride);

  // Helper that wraps each Meta API call so one bad request can't take
  // down the whole tab. Failures bubble up as errors[] in the response
  // for transparency, but we still return whatever did work.
  const errors = [];
  const safe = async (label, p) => {
    try {
      return await p;
    } catch (e) {
      console.warn("ads_metrics_partial_failure", { label, message: e?.message });
      errors.push({ label, message: e?.message || String(e) });
      return null;
    }
  };

  try {
    // Fire Meta Graph requests in parallel. Each wrapped in safe() so
    // they fail independently — common case: campaign list fetch fails
    // on a field permission, but insights succeed (or vice versa).
    const [campaignInsights, dailyInsights, campaignMeta] = await Promise.all([
      safe("campaign_insights", fetchInsights({
        accessToken,
        accountId,
        apiVersion,
        from,
        to,
        level: "campaign",
        // Use `inline_link_clicks` (Meta's "Link clicks" = clicks that
        // navigate to the destination URL) instead of `clicks` (which
        // is "Clicks (all)" — includes reactions, profile clicks, post
        // engagement, etc.). Meta's own primary CPC, CTR, and ROAS
        // calculations use link clicks too, so this makes our numbers
        // line up with Ads Manager. Geo flagged the mismatch: our tab
        // showed 259 clicks while Meta showed 173 link clicks.
        fields: "campaign_id,campaign_name,spend,impressions,inline_link_clicks,clicks,ctr,cpc,cpm",
      })),
      // Daily series is queried at CAMPAIGN level (not account) so the
      // same exclude/include filter we apply to the totals also applies
      // here — otherwise the daily numbers include boosted "Post:"
      // campaigns and other ad activity that the rest of the tab hides,
      // making the daily sum disagree with the headline totals.
      safe("daily_insights", fetchInsights({
        accessToken,
        accountId,
        apiVersion,
        from,
        to,
        level: "campaign",
        fields: "campaign_name,spend,impressions,inline_link_clicks,clicks",
        timeIncrement: 1,
      })),
      safe("campaign_list", fetchCampaignList({ accessToken, accountId, apiVersion })),
    ]);

    // Pull our own attribution data — signups and purchases tagged with
    // utm_source=meta (or facebook), with optional per-campaign matching.
    // Plus landing-page funnel events (visits + checkout scrolls) for
    // the abandoned-cart picture.
    const [signupsByCampaign, revenueByCampaign, signupsByDay, funnelByCampaign] = await Promise.all([
      loadSignupsByCampaign(from, to),
      loadRevenueByCampaign(from, to),
      loadSignupsByDay(from, to),
      loadFunnelByCampaign(from, to),
    ]);

    // Build a campaign-name → totals map. Both inputs can be null if
    // their fetch failed — treat them as empty so we still render
    // whatever data we did get.
    const statusMap = {};
    const campaignMetaById = {};
    for (const c of (campaignMeta || [])) {
      statusMap[c.id] = c.status;
      campaignMetaById[c.id] = c;
    }

    // Merge insights with campaign metadata so campaigns that exist
    // but have zero spend in the date range still appear in the table.
    // Meta's /insights endpoint only returns campaigns with activity;
    // /campaigns lists all of them. Without this merge, a freshly
    // launched campaign with no spend yet would be invisible to Geo.
    const insightsById = {};
    for (const c of (campaignInsights || [])) {
      insightsById[c.campaign_id] = c;
    }
    // Start with every campaign from the metadata list; overlay insights
    // where they exist. Result: complete campaign list with stats where
    // available, zeros where not.
    const mergedInsights = (campaignMeta || []).map((meta) => {
      const ins = insightsById[meta.id] || {};
      return {
        campaign_id: meta.id,
        campaign_name: ins.campaign_name || meta.name,
        spend: ins.spend || 0,
        impressions: ins.impressions || 0,
        clicks: ins.clicks || 0,
        ctr: ins.ctr || 0,
        cpc: ins.cpc || 0,
        cpm: ins.cpm || 0,
      };
    });
    // Plus any campaigns that DID have insights but somehow weren't in
    // the metadata list (rare, but be defensive).
    for (const c of (campaignInsights || [])) {
      if (!campaignMetaById[c.campaign_id]) {
        mergedInsights.push(c);
      }
    }

    // Campaign name filter. Two layers:
    //   1. EXCLUDE — names matching these patterns never show up.
    //      Default kills "Post: ..." boosted-post campaigns since those
    //      are usually engagement-only and pollute the The Field metrics.
    //   2. INCLUDE — if META_ADS_CAMPAIGN_INCLUDE is set, only names
    //      containing one of those substrings (case-insensitive) pass.
    //      Useful when you only want to track Field-related campaigns
    //      and ignore other product lines on the same ad account.
    //   Both env vars are comma-separated. Either can be empty.
    const excludePatterns = (process.env.META_ADS_CAMPAIGN_EXCLUDE || "Post:")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const includePatterns = (process.env.META_ADS_CAMPAIGN_INCLUDE || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const passesFilter = (name) => {
      const lower = String(name || "").toLowerCase();
      if (excludePatterns.some((p) => lower.includes(p))) return false;
      if (includePatterns.length > 0 && !includePatterns.some((p) => lower.includes(p))) return false;
      return true;
    };

    const campaigns = (campaignInsights || []).filter((c) => passesFilter(c.campaign_name)).map((c) => {
      const id = c.campaign_id;
      const name = c.campaign_name || "(unnamed campaign)";
      const spend = Number(c.spend || 0);
      const impressions = Number(c.impressions || 0);
      // Prefer Meta's `inline_link_clicks` (Link clicks) which matches
      // Meta's Ads Manager headline number. Fall back to `clicks` only
      // if the link-clicks field is missing for some reason (e.g., the
      // campaign has zero qualifying clicks and Meta omits the field).
      const clicks = Number(c.inline_link_clicks != null ? c.inline_link_clicks : (c.clicks || 0));
      // CTR + CPC: recompute from the displayed Spend ÷ Clicks instead of
      // using Meta's headline cpc/ctr fields. Meta's `cpc` is computed
      // from ALL clicks (including reactions/profile views/engagement),
      // but our "Clicks" column shows LINK clicks only — so Meta's CPC
      // would always be smaller than (Spend ÷ displayed Clicks), making
      // it look inconsistent. Same logic for CTR. Geo flagged this.
      const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
      const cpc = clicks > 0 ? spend / clicks : 0;
      const cpm = Number(c.cpm || 0);
      // Lenient attribution match. The utm_campaign string a buyer
      // carried in their URL rarely equals the Meta campaign name byte-
      // for-byte (the Meta name is usually longer / more descriptive).
      // So we sum signups from any utm_campaign value that appears as
      // a substring of the Meta campaign name (case-insensitive).
      // Example: utm_campaign="cold" matches Meta campaign
      // "72-Hour Power Reset | Cold | Purchase Test | Jun 2026".
      const nameLower = String(name || "").toLowerCase();
      const matchUtm = (map) => {
        let sum = 0;
        for (const utmCampaign of Object.keys(map)) {
          if (!utmCampaign) continue;
          if (nameLower.includes(String(utmCampaign).toLowerCase())) {
            sum += Number(map[utmCampaign] || 0);
          }
        }
        return sum;
      };
      const signups = matchUtm(signupsByCampaign);
      const revenueCents = matchUtm(revenueByCampaign);
      // Visits = Meta's link-click count. More reliable than our own
      // page_view tracking (no script blockers, no race conditions, no
      // missed loads). Checkout scrolls still come from our landing
      // page snippet since Meta has no visibility past the click.
      const visits = clicks;
      let checkoutScrolls = 0;
      let ctaClicks = 0;
      for (const utmCampaign of Object.keys(funnelByCampaign)) {
        if (!utmCampaign) continue;
        if (nameLower.includes(String(utmCampaign).toLowerCase())) {
          checkoutScrolls += Number(funnelByCampaign[utmCampaign].checkout_scrolls || 0);
          ctaClicks       += Number(funnelByCampaign[utmCampaign].cta_clicks || 0);
        }
      }
      // CTA clicks is the new headline funnel step (since CTAs now link
      // out to ThriveCart instead of scrolling to an embedded checkout).
      // Abandoned cart = people who clicked the CTA but didn't buy.
      const abandonedCart = Math.max(0, ctaClicks - signups);
      return {
        id,
        name,
        status: statusMap[id] || "UNKNOWN",
        spend,
        impressions,
        clicks,
        ctr,
        cpc,
        cpm,
        signups_attributed: signups,
        cost_per_signup: signups > 0 ? spend / signups : null,
        revenue_attributed_cents: revenueCents,
        roas: spend > 0 ? (revenueCents / 100) / spend : null,
        // Landing funnel — visits → CTA click → bought.
        // checkout_scrolls kept for backward-compat with old landing pages.
        visits,
        cta_clicks: ctaClicks,
        checkout_scrolls: checkoutScrolls,
        cta_to_visit_rate: visits > 0 ? (ctaClicks / visits) * 100 : null,
        purchase_to_cta_rate: ctaClicks > 0 ? (signups / ctaClicks) * 100 : null,
        // Keep the old scroll-based rates so legacy data still shows in the
        // table for any rows from before the CTA redesign.
        scroll_to_visit_rate: visits > 0 ? (checkoutScrolls / visits) * 100 : null,
        purchase_to_scroll_rate: checkoutScrolls > 0 ? (signups / checkoutScrolls) * 100 : null,
        abandoned_cart: abandonedCart,
      };
    });

    // Totals — sum each metric across campaigns. CPC/CTR/CPM recomputed
    // from totals (not averaged) so they're correct weighted values.
    const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0);
    const totalImpressions = campaigns.reduce((s, c) => s + c.impressions, 0);
    const totalClicks = campaigns.reduce((s, c) => s + c.clicks, 0);
    const totalSignups = campaigns.reduce((s, c) => s + c.signups_attributed, 0);
    const totalRevenueCents = campaigns.reduce((s, c) => s + c.revenue_attributed_cents, 0);

    const totalVisits = campaigns.reduce((s, c) => s + (c.visits || 0), 0);
    const totalCheckoutScrolls = campaigns.reduce((s, c) => s + (c.checkout_scrolls || 0), 0);
    const totalCtaClicks = campaigns.reduce((s, c) => s + (c.cta_clicks || 0), 0);

    const totals = {
      spend: totalSpend,
      impressions: totalImpressions,
      clicks: totalClicks,
      ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
      cpc: totalClicks > 0 ? totalSpend / totalClicks : 0,
      cpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0,
      signups_attributed: totalSignups,
      cost_per_signup: totalSignups > 0 ? totalSpend / totalSignups : null,
      revenue_attributed_cents: totalRevenueCents,
      roas: totalSpend > 0 ? (totalRevenueCents / 100) / totalSpend : null,
      // Funnel totals — CTA click is the new headline step
      visits: totalVisits,
      cta_clicks: totalCtaClicks,
      checkout_scrolls: totalCheckoutScrolls,
      // Abandoned cart = visitors who clicked the CTA but didn't buy
      abandoned_cart: Math.max(0, totalCtaClicks - totalSignups),
      cta_to_visit_rate: totalVisits > 0 ? (totalCtaClicks / totalVisits) * 100 : null,
      purchase_to_cta_rate: totalCtaClicks > 0 ? (totalSignups / totalCtaClicks) * 100 : null,
      // Legacy scroll-based rates kept for old landing pages
      scroll_to_visit_rate: totalVisits > 0 ? (totalCheckoutScrolls / totalVisits) * 100 : null,
      purchase_to_scroll_rate: totalCheckoutScrolls > 0 ? (totalSignups / totalCheckoutScrolls) * 100 : null,
    };

    // Daily time series. The Meta call is per-campaign-per-day, so we
    // first drop rows for campaigns we're filtering out, then aggregate
    // what's left by date. This makes daily numbers match the totals
    // exactly (same campaigns counted both places).
    const dailyAgg = {};
    for (const d of (dailyInsights || [])) {
      if (!passesFilter(d.campaign_name)) continue;
      const date = d.date_start;
      if (!dailyAgg[date]) dailyAgg[date] = { spend: 0, impressions: 0, clicks: 0 };
      dailyAgg[date].spend       += Number(d.spend || 0);
      dailyAgg[date].impressions += Number(d.impressions || 0);
      // Same convention as the per-campaign totals: prefer link clicks.
      dailyAgg[date].clicks      += Number(d.inline_link_clicks != null ? d.inline_link_clicks : (d.clicks || 0));
    }
    const daily = Object.keys(dailyAgg).sort().map((date) => ({
      date,
      spend: dailyAgg[date].spend,
      impressions: dailyAgg[date].impressions,
      clicks: dailyAgg[date].clicks,
      signups: Number(signupsByDay[date] || 0),
    }));

    // Organic landing-page metrics — same date range, separate funnel.
    // Pulled here so the Ads tab can render both "Meta paid" and "Organic"
    // sections under one shared range picker. Failure to load is non-fatal:
    // the organic block just returns nulls and the UI hides the section.
    const organic = await safe("organic_metrics", loadOrganicMetrics(from, to));

    return res.status(200).json({
      ok: true,
      range: { from, to, label },
      totals,
      campaigns: campaigns.sort((a, b) => b.spend - a.spend),
      daily,
      organic,
      meta: {
        fetched_at: new Date().toISOString(),
        account_id: accountId,
      },
      // Surface any partial failures (e.g., campaign list 403 while
      // insights work) so the UI can show a soft warning rather than
      // silently displaying half the data.
      partial_errors: errors,
    });
  } catch (err) {
    console.error("ads_metrics_error", { message: err?.message });
    return res.status(500).json({
      ok: false,
      error: "fetch_failed",
      message: err?.message,
    });
  }
}

// =============================================================================
// Meta Graph API helpers
// =============================================================================

async function fetchInsights({ accessToken, accountId, apiVersion, from, to, level, fields, timeIncrement }) {
  const params = new URLSearchParams({
    access_token: accessToken,
    fields,
    level,
    time_range: JSON.stringify({ since: from, until: to }),
    limit: "200",
  });
  if (timeIncrement) params.set("time_increment", String(timeIncrement));

  const url = `https://graph.facebook.com/${apiVersion}/${accountId}/insights?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`meta_insights_${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data || [];
}

async function fetchCampaignList({ accessToken, accountId, apiVersion }) {
  // Just the basics. `effective_status` and budget fields sometimes
  // trigger permission errors on tokens that only have ads_read —
  // status is enough for the dashboard's ACTIVE/PAUSED badge.
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: "id,name,status",
    limit: "100",
  });
  const url = `https://graph.facebook.com/${apiVersion}/${accountId}/campaigns?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`meta_campaigns_${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return (json.data || []).map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
  }));
}

// =============================================================================
// Attribution from our own database
// =============================================================================

// Attribution is matched lenient — we accept ANY utm_source, not just
// "meta"/"facebook", because Geo uses utm_source=power-reset (the
// product) rather than the channel. Anyone tagging UTMs gets to pick
// their own convention; we just trust that if a utm is set, the signup
// came from an attributed campaign.
async function loadSignupsByCampaign(from, to) {
  try {
    const { rows } = await sql`
      SELECT utm_campaign, COUNT(*)::int AS n
      FROM users
      WHERE created_at >= ${from}::date
        AND created_at < (${to}::date + INTERVAL '1 day')
        AND utm_source IS NOT NULL
        AND utm_campaign IS NOT NULL
        AND email NOT LIKE '%@shimritnativ.com'
      GROUP BY utm_campaign
    `;
    const map = {};
    for (const r of rows) {
      if (r.utm_campaign) map[r.utm_campaign] = Number(r.n);
    }
    return map;
  } catch (e) {
    // If utm columns don't exist yet (migration 011 not run), return empty
    // map gracefully so the rest of the dashboard still loads.
    console.warn("signups_by_campaign_failed", e?.message);
    return {};
  }
}

// Revenue (in cents) from purchases by ad-attributed users, grouped by
// utm_campaign. Joins purchases against users so we don't need UTMs on
// every purchase row — one capture at signup is enough.
async function loadRevenueByCampaign(from, to) {
  try {
    const { rows } = await sql`
      SELECT u.utm_campaign, SUM(p.amount_cents)::bigint AS revenue_cents
      FROM purchases p
      JOIN users u ON LOWER(u.email) = LOWER(p.email)
      WHERE p.created_at >= ${from}::date
        AND p.created_at < (${to}::date + INTERVAL '1 day')
        AND p.event_type IN ('order.success', 'order.subscription_payment')
        AND p.amount_cents > 0
        AND u.utm_source IS NOT NULL
        AND u.utm_campaign IS NOT NULL
        AND u.email NOT LIKE '%@shimritnativ.com'
      GROUP BY u.utm_campaign
    `;
    const map = {};
    for (const r of rows) {
      if (r.utm_campaign) map[r.utm_campaign] = Number(r.revenue_cents);
    }
    return map;
  } catch (e) {
    console.warn("revenue_by_campaign_failed", e?.message);
    return {};
  }
}

// Landing-page funnel events grouped by utm_campaign. Returns a map
// { campaignName: { visits, checkout_scrolls } } for joining with
// Meta campaign data. Events come from the public tracking endpoint
// /api/track-landing-event (called by the GHL landing page snippet).
async function loadFunnelByCampaign(from, to) {
  try {
    // CTA clicks are recorded with event_type prefixed `power_reset_cta_click`
    // (optionally followed by `:label` like `:start` or `:instant_access`).
    // We count UNIQUE SESSIONS that fired any CTA event so a visitor who
    // tapped two buttons doesn't double-count. checkout_scrolls is kept for
    // legacy rows but the CTA event is the relevant signal now that CTAs
    // link out to ThriveCart instead of opening an embedded checkout.
    const { rows } = await sql`
      SELECT utm_campaign,
             COUNT(*) FILTER (WHERE event_type = 'page_view')::int                                   AS visits,
             COUNT(*) FILTER (WHERE event_type = 'checkout_scroll')::int                             AS checkout_scrolls,
             COUNT(DISTINCT session_id) FILTER (WHERE event_type LIKE 'power_reset_cta_click%')::int AS cta_clicks
      FROM landing_events
      WHERE created_at >= ${from}::date
        AND created_at < (${to}::date + INTERVAL '1 day')
        AND utm_campaign IS NOT NULL
      GROUP BY utm_campaign
    `;
    const map = {};
    for (const r of rows) {
      if (r.utm_campaign) {
        map[r.utm_campaign] = {
          visits: Number(r.visits),
          checkout_scrolls: Number(r.checkout_scrolls),
          cta_clicks: Number(r.cta_clicks),
        };
      }
    }
    return map;
  } catch (e) {
    // landing_events table may not exist yet (migration 012 not run).
    // Return empty map so the rest of the dashboard still loads.
    console.warn("funnel_by_campaign_failed", e?.message);
    return {};
  }
}

// Daily signup counts for the spend-vs-signups chart
async function loadSignupsByDay(from, to) {
  try {
    const { rows } = await sql`
      SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
      FROM users
      WHERE created_at >= ${from}::date
        AND created_at < (${to}::date + INTERVAL '1 day')
        AND utm_source IS NOT NULL
        AND email NOT LIKE '%@shimritnativ.com'
      GROUP BY 1
    `;
    const map = {};
    for (const r of rows) map[r.day] = Number(r.n);
    return map;
  } catch (e) {
    console.warn("signups_by_day_failed", e?.message);
    return {};
  }
}

// =============================================================================
// Organic landing-page metrics
// =============================================================================
// Same shape as the Meta funnel but pulled entirely from our own data
// (landing_events for visits/CTA clicks + purchases for orders/revenue).
// "Organic" = traffic to /the-power-reset (without the -ads suffix).
// Distinct from the ads funnel which uses /the-power-reset-ads.
async function loadOrganicMetrics(from, to) {
  // Match the organic LP URL specifically. The page_url column captures
  // the full URL the snippet fired from, so we filter for the org LP
  // path and explicitly exclude the -ads variant.
  const ORG_URL_PATTERN = '%go.shimritnativ.com/the-power-reset%';
  const ADS_URL_PATTERN = '%/the-power-reset-ads%';
  // Match the organic ThriveCart product specifically. The admin
  // distinguishes "The Power Reset" (organic) from "The Power Reset - Ads"
  // (paid) — different products in ThriveCart for separate attribution.
  const ORG_PRODUCT_EXACT = 'The Power Reset';

  let visits = 0;
  let ctaClicks = 0;
  let purchases = 0;
  let revenueCents = 0;
  let daily = [];

  try {
    const { rows: funnelRows } = await sql`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'page_view')::int AS visits,
        COUNT(DISTINCT session_id) FILTER (WHERE event_type LIKE 'power_reset_cta_click%')::int AS cta_clicks
      FROM landing_events
      WHERE created_at >= ${from}::date
        AND created_at < (${to}::date + INTERVAL '1 day')
        AND page_url LIKE ${ORG_URL_PATTERN}
        AND page_url NOT LIKE ${ADS_URL_PATTERN}
    `;
    visits = Number(funnelRows[0]?.visits || 0);
    ctaClicks = Number(funnelRows[0]?.cta_clicks || 0);
  } catch (e) {
    console.warn("organic_funnel_failed", e?.message);
  }

  try {
    const { rows: revRows } = await sql`
      SELECT
        COUNT(*)::int AS orders,
        COALESCE(SUM(amount_cents), 0)::bigint AS revenue_cents
      FROM purchases
      WHERE created_at >= ${from}::date
        AND created_at < (${to}::date + INTERVAL '1 day')
        AND event_type IN ('order.success', 'order.subscription_payment')
        AND amount_cents > 0
        AND product_name = ${ORG_PRODUCT_EXACT}
    `;
    purchases = Number(revRows[0]?.orders || 0);
    revenueCents = Number(revRows[0]?.revenue_cents || 0);
  } catch (e) {
    console.warn("organic_revenue_failed", e?.message);
  }

  try {
    // Daily breakdown for the chart: visits, CTA clicks, purchases per day.
    // Two joined CTEs since events live in one table and purchases in another.
    const { rows: dailyRows } = await sql`
      WITH days AS (
        SELECT generate_series(
          ${from}::date,
          ${to}::date,
          INTERVAL '1 day'
        )::date AS d
      ),
      ev AS (
        SELECT
          DATE(created_at) AS d,
          COUNT(*) FILTER (WHERE event_type = 'page_view') AS visits,
          COUNT(DISTINCT session_id) FILTER (WHERE event_type LIKE 'power_reset_cta_click%') AS cta_clicks
        FROM landing_events
        WHERE created_at >= ${from}::date
          AND created_at < (${to}::date + INTERVAL '1 day')
          AND page_url LIKE ${ORG_URL_PATTERN}
          AND page_url NOT LIKE ${ADS_URL_PATTERN}
        GROUP BY DATE(created_at)
      ),
      pu AS (
        SELECT
          DATE(created_at) AS d,
          COUNT(*) AS purchases,
          COALESCE(SUM(amount_cents), 0) AS revenue_cents
        FROM purchases
        WHERE created_at >= ${from}::date
          AND created_at < (${to}::date + INTERVAL '1 day')
          AND event_type IN ('order.success', 'order.subscription_payment')
          AND amount_cents > 0
          AND product_name = ${ORG_PRODUCT_EXACT}
        GROUP BY DATE(created_at)
      )
      SELECT
        TO_CHAR(days.d, 'YYYY-MM-DD') AS date,
        COALESCE(ev.visits, 0)::int        AS visits,
        COALESCE(ev.cta_clicks, 0)::int    AS cta_clicks,
        COALESCE(pu.purchases, 0)::int     AS purchases,
        COALESCE(pu.revenue_cents, 0)::int AS revenue_cents
      FROM days
      LEFT JOIN ev ON ev.d = days.d
      LEFT JOIN pu ON pu.d = days.d
      ORDER BY days.d
    `;
    daily = dailyRows;
  } catch (e) {
    console.warn("organic_daily_failed", e?.message);
  }

  return {
    visits,
    cta_clicks: ctaClicks,
    purchases,
    abandoned_cart: Math.max(0, ctaClicks - purchases),
    revenue_cents: revenueCents,
    cta_to_visit_rate: visits > 0 ? (ctaClicks / visits) * 100 : null,
    purchase_to_visit_rate: visits > 0 ? (purchases / visits) * 100 : null,
    purchase_to_cta_rate: ctaClicks > 0 ? (purchases / ctaClicks) * 100 : null,
    daily,
  };
}

// =============================================================================
// Date range resolution
// =============================================================================

function todayIso() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Field launch date — the day Geo opened the ads + organic LP. Used as the
// "since launch" preset since anything before this is zero data anyway.
const LAUNCH_DATE = "2026-06-15";

function resolveRange(range, fromOverride, toOverride) {
  // Custom range wins if both endpoints are valid YYYY-MM-DD.
  const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (isYmd(fromOverride) && isYmd(toOverride)) {
    return { from: fromOverride, to: toOverride, label: "custom" };
  }
  const today = todayIso();
  if (range === "today") {
    return { from: today, to: today, label: "today" };
  }
  if (range === "30d" || range === "30") {
    return { from: daysAgoIso(29), to: today, label: "last 30 days" };
  }
  if (range === "since_launch" || range === "launch") {
    return { from: LAUNCH_DATE, to: today, label: "since launch" };
  }
  if (range === "lifetime" || range === "all") {
    // Meta requires a finite range — use a wide default (2 years back).
    return { from: daysAgoIso(730), to: today, label: "lifetime" };
  }
  // default: 7d
  return { from: daysAgoIso(6), to: today, label: "last 7 days" };
}
