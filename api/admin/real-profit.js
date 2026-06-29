// api/admin/real-profit.js
//
// "Real Profit" KPI for the Overview tab. Combines three sources:
//   1. Net revenue: SUM of purchases.amount_cents for Field products,
//      excluding test/comp coupons. amount_cents is NET (see pricing table
//      memory) so no VAT math needed.
//   2. Ops costs: parsed from launch_tracker_state.state JSON, using the
//      same formula the launch tracker page computes client-side. Excludes
//      `launch-ad-cost` (the manual ads input) because we pull the real
//      ads number from Meta below.
//   3. Ads spend: lifetime Meta spend for Field-filtered campaigns, using
//      the same META_ADS_CAMPAIGN_INCLUDE env var as ads-metrics.js.
//
// Real Profit = netRevenue - opsCosts - adsSpend.
//
// Auth: @shimritnativ.com session only.
// Returns: { netRevenue, opsCosts, adsSpend, realProfit, breakdown, errors }

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";
import { fetchAnthropicSpendUsd } from "../../lib/anthropicCosts.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const DEFAULT_API_VERSION = "v22.0";

// "Field" product filter for net revenue. Matches Reset / Activation /
// Unlimited regardless of suffix variants like "(Yearly)" or "- Ads".
const FIELD_PRODUCT_PATTERNS = [
  "%Power Reset%",
  "%Power Activation%",
  "%Freedom Intelligence Field%",
];

// Comp/test coupons whose orders shouldn't count toward revenue. Same
// list as the rest of the admin uses.
const EXCLUDED_COUPONS = ["GEO100", "GEOALL", "LAUNCHTEAM"];

// Lifetime ads start date. Pulling from 2024-01-01 is wide enough to
// catch every campaign ever run on this account.
const LIFETIME_FROM = "2024-01-01";

function todayUtcDate() {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");

  // Auth
  const token = req.headers["x-session-token"];
  const user = await getUserBySessionToken(token);
  const email = (user?.email || "").toLowerCase();
  if (!email.endsWith(ALLOWED_DOMAIN)) {
    return res.status(403).json({ error: "forbidden" });
  }

  const errors = [];

  // ---- 1. Net revenue from purchases ----
  let netRevenue = 0;
  try {
    const { rows } = await sql`
      SELECT COALESCE(SUM(amount_cents), 0)::bigint AS cents
      FROM purchases
      WHERE event_type IN ('order.success', 'order.subscription_payment')
        AND amount_cents > 0
        AND COALESCE(coupon_code, '') <> ALL(${EXCLUDED_COUPONS})
        AND (
          product_name ILIKE ANY(${FIELD_PRODUCT_PATTERNS})
        )
    `;
    netRevenue = Number(rows[0]?.cents || 0) / 100;
  } catch (e) {
    errors.push({ source: "net_revenue", message: e?.message || String(e) });
  }

  // ---- 2a. Anthropic lifetime spend (live from Admin API) ----
  // Pull this BEFORE computing ops costs so we can substitute the auto-pulled
  // number into the launch tracker formula instead of the user's manual
  // `op-anthropic` field. Avoids double-counting and keeps the number always
  // current with what's actually been spent on tokens.
  let anthropicUsd = 0;
  let anthropicEur = 0;
  let anthropicSource = null;
  try {
    const result = await fetchAnthropicSpendUsd({
      startingAt: LIFETIME_FROM + "T00:00:00Z",
      endingAt: todayUtcDate() + "T23:59:59Z",
    });
    anthropicUsd = result.totalUsd || 0;
    anthropicSource = result.ok ? "anthropic_admin_api" : "unavailable";
    if (!result.ok) {
      errors.push({ source: "anthropic_admin", message: result.reason });
    }
  } catch (e) {
    errors.push({ source: "anthropic_admin", message: e?.message || String(e) });
  }

  // ---- 2b. Ops costs from launch tracker state + monthly_costs table ----
  // Important: the launch tracker shows op-ghl, op-anthropic, op-vercel, etc.
  // but these values actually live in the `monthly_costs` table — the admin
  // saves them there via the "Monthly costs" snapshot panel, then the launch
  // tracker iframe receives them via postMessage from the parent. So they're
  // NOT in launch_tracker_state.state — we have to pull both sources and
  // merge them.
  let opsCosts = 0;
  let opsBreakdown = null;
  try {
    const { rows: stateRows } = await sql`
      SELECT state FROM launch_tracker_state WHERE id = 'singleton' LIMIT 1
    `;
    const state = (stateRows[0]?.state) || {};

    // Pull the monthly_costs table — same source the admin's Monthly Costs
    // panel reads/writes. service_key → amount.
    let monthlyCostsByKey = {};
    try {
      const { rows: costRows } = await sql`
        SELECT service_key, amount FROM monthly_costs
      `;
      for (const r of costRows) {
        monthlyCostsByKey[r.service_key] = Number(r.amount || 0);
      }
    } catch (e) {
      // Table may not be migrated — silent fall-through; values stay 0.
    }

    // Convert Anthropic USD → EUR using the same fx rate the launch tracker
    // uses for the other USD-billed services. Default to 1 if not set so the
    // number is at least visible. (Most cost rows are already in EUR per the
    // admin's "billed USD — enter EUR" convention.)
    const fx = Number(String(state?.["op-fx"] ?? "1").replace(",", ".")) || 1;
    anthropicEur = anthropicUsd * fx;
    opsBreakdown = computeOpsCosts(state, {
      anthropicEurOverride: anthropicEur,
      monthlyCostsByKey,
    });
    opsCosts = opsBreakdown.total;
  } catch (e) {
    errors.push({ source: "launch_tracker_state", message: e?.message || String(e) });
  }

  // ---- 3. Lifetime Meta ads spend, Field campaigns only ----
  let adsSpend = 0;
  let adsCampaigns = [];
  try {
    const accessToken = process.env.META_ADS_ACCESS_TOKEN;
    const rawAccountId = process.env.META_ADS_ACCOUNT_ID;
    if (!accessToken || !rawAccountId) {
      errors.push({
        source: "meta_ads",
        message: "META_ADS_ACCESS_TOKEN or META_ADS_ACCOUNT_ID not configured.",
      });
    } else {
      const accountId = String(rawAccountId).trim().startsWith("act_")
        ? String(rawAccountId).trim()
        : "act_" + String(rawAccountId).trim().replace(/^act_/i, "");
      const apiVersion = process.env.META_ADS_API_VERSION || DEFAULT_API_VERSION;

      // Reuse the same include/exclude filter logic as ads-metrics.js so
      // "what counts as a Field campaign" stays consistent across the
      // dashboard.
      const excludePatterns = (process.env.META_ADS_CAMPAIGN_EXCLUDE || "Post:")
        .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const includePatterns = (process.env.META_ADS_CAMPAIGN_INCLUDE || "")
        .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const passesFilter = (name) => {
        const lower = String(name || "").toLowerCase();
        if (excludePatterns.some((p) => lower.includes(p))) return false;
        if (includePatterns.length > 0 && !includePatterns.some((p) => lower.includes(p))) return false;
        return true;
      };

      const insights = await fetchInsights({
        accessToken,
        accountId,
        apiVersion,
        from: LIFETIME_FROM,
        to: todayUtcDate(),
        level: "campaign",
        fields: "campaign_id,campaign_name,spend",
      });

      adsCampaigns = (insights || [])
        .filter((c) => passesFilter(c.campaign_name))
        .map((c) => ({
          id: c.campaign_id,
          name: c.campaign_name || "(unnamed)",
          spend: Number(c.spend || 0),
        }));
      adsSpend = adsCampaigns.reduce((sum, c) => sum + c.spend, 0);
    }
  } catch (e) {
    errors.push({ source: "meta_ads", message: e?.message || String(e) });
  }

  // ---- Combine ----
  const realProfit = netRevenue - opsCosts - adsSpend;

  return res.status(200).json({
    asOf: new Date().toISOString(),
    netRevenue,
    opsCosts,
    adsSpend,
    realProfit,
    breakdown: {
      ops: opsBreakdown,
      ads: {
        from: LIFETIME_FROM,
        to: todayUtcDate(),
        campaigns: adsCampaigns,
        totalSpend: adsSpend,
      },
      anthropic: {
        totalUsd: anthropicUsd,
        totalEur: anthropicEur,
        source: anthropicSource,
        notes: anthropicSource === "anthropic_admin_api"
          ? "Pulled live via Anthropic Admin API. Folded into opsCosts in place of the manual launch tracker field."
          : "Not pulled; falling back to whatever the launch tracker has manually entered.",
      },
    },
    errors,
  });
}

// Mirrors the launch tracker's client-side cost math (see
// public/launch-tracker.html recalc()). Excludes launch-ad-cost because
// we pull the live ads number from Meta. If you change the launch
// tracker formula, update this too.
//
// Options:
//   anthropicEurOverride — if provided (a number), it replaces the manual
//   `op-anthropic` field in the calculation. Used to fold the live
//   Anthropic Admin API value in without double-counting against the
//   user's manual input. Pass undefined / null to fall back to manual.
function computeOpsCosts(state, opts = {}) {
  const n = (key) => {
    const v = state?.[key];
    if (v === null || v === undefined || v === "") return 0;
    // Handle European decimal separator: "97,47" → 97.47. Without this
    // every cost field parses as NaN → 0 and opsCosts comes out €0 even
    // though the launch tracker shows real values. Geo's data is stored
    // with commas because the launch tracker UI uses comma as decimal sep.
    const normalized = String(v).replace(",", ".").replace(/[^\d.\-]/g, "");
    const num = Number(normalized);
    return Number.isFinite(num) ? num : 0;
  };

  const prePeople = n("pre-people");
  const preMsgsPer = n("pre-msgs-per");
  const preMsgCost = n("pre-msg-cost");
  const preMsgTotal = prePeople * preMsgsPer;
  const preWhatsAppCost = preMsgTotal * preMsgCost;
  const preGhl = n("pre-ghl-cost");

  const launchPeople = n("launch-people");
  const launchMsgsPer = n("launch-msgs-per");
  const launchMsgCost = n("launch-msg-cost");
  const launchMsgTotal = launchPeople * launchMsgsPer;
  const launchWhatsAppCost = launchMsgTotal * launchMsgCost;

  const fx = n("op-fx") || 1;

  // Per-service monthly cost lookup. The launch tracker iframe gets these
  // from the admin's monthly_costs table (via postMessage from parent), so
  // they're NOT in launch_tracker_state.state. Caller passes them in.
  // Falls back to whatever's in state if monthlyCostsByKey isn't provided.
  const mc = opts.monthlyCostsByKey || {};
  const costFor = (snapshotKey, stateKey) => {
    const fromTable = mc[snapshotKey];
    if (Number.isFinite(fromTable) && fromTable > 0) return Number(fromTable);
    return n(stateKey);
  };

  // Anthropic: prefer the live Admin API number (already in EUR) over the
  // saved value in monthly_costs. Fall back to monthly_costs anthropic if
  // the API call failed.
  const useAnthropicOverride = Number.isFinite(opts.anthropicEurOverride) && opts.anthropicEurOverride > 0;
  const manualAnthropicEur = costFor("anthropic", "op-anthropic"); // already in EUR per admin convention
  // Other ops costs — all already in EUR per "billed USD — enter EUR".
  const opGhl = costFor("ghl", "op-ghl");
  const opVercel = costFor("vercel", "op-vercel");
  const opResend = costFor("resend", "op-resend");
  const opNeon = costFor("neon", "op-neon");
  const opElevenLabs = costFor("elevenlabs", "op-elevenlabs");
  const opWhisper = costFor("whisper", "op-whisper");
  const opOther = costFor("other", "op-other");
  const opDomain = costFor("domain", "op-domain");

  const opMonthlyEur =
    opGhl + opVercel + opResend + opNeon +
    opElevenLabs + opWhisper + opOther + opDomain +
    (useAnthropicOverride ? opts.anthropicEurOverride : manualAnthropicEur);
  const opLaunchPortion = opMonthlyEur * 2;

  const total = preWhatsAppCost + preGhl + launchWhatsAppCost + opLaunchPortion;

  return {
    preWhatsApp: preWhatsAppCost,
    preGhl,
    launchWhatsApp: launchWhatsAppCost,
    opsMonthly: opMonthlyEur,
    opsLaunchPortion: opLaunchPortion,
    anthropicSource: useAnthropicOverride ? "admin_api" : "monthly_costs_table",
    anthropicEur: useAnthropicOverride ? opts.anthropicEurOverride : manualAnthropicEur,
    total,
  };
}

async function fetchInsights({ accessToken, accountId, apiVersion, from, to, level, fields }) {
  const params = new URLSearchParams({
    access_token: accessToken,
    fields,
    level,
    time_range: JSON.stringify({ since: from, until: to }),
    limit: "200",
  });
  const url = `https://graph.facebook.com/${apiVersion}/${accountId}/insights?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`meta_insights_${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data || [];
}
