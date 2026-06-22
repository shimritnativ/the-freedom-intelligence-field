// api/admin/daily-summary.js
// 8pm daily roundup pushed to admins. Cron-triggered (18:00 UTC =
// 20:00 Berlin CEST). Reads today's sales, new members, and Unlimited
// upgrades from the database and packs them into a single push so Geo
// can glance at her lock screen and know how the day went without
// opening the admin.
//
// Auth:
//   - Vercel-cron User-Agent (auto, the primary trigger)
//   - ADMIN_TOKEN via header/query (manual trigger for testing)
//   - x-session-token from @shimritnativ.com (manual trigger from admin)
//
// Cron schedule lives in vercel.json — "0 18 * * *" runs once at 18:00
// UTC each day. Switch to "0 19 * * *" in winter (CET) if needed.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";
import { notifyAdmins } from "../../lib/adminNotify.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

// VAT divisor — match the dashboard's "ex VAT" mode (€1 gross / 1.19
// = €0.84 net). The daily summary reports net so it matches the
// numbers Geo sees on the admin dashboard with the VAT toggle on net.
const VAT_DIVISOR = 1.19;

export const config = {
  maxDuration: 30,
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
    // Today's stats — define "today" as "the last 24 hours" so the
    // summary captures everything since yesterday's 8pm summary,
    // regardless of which timezone "today" lands in for Geo.
    const { rows: salesRows } = await sql`
      SELECT
        COUNT(*)::int AS order_count,
        COALESCE(SUM(amount_cents), 0)::bigint AS gross_cents,
        COUNT(DISTINCT email)::int AS unique_buyers
      FROM purchases
      WHERE event_type IN ('order.success', 'order.subscription_payment')
        AND amount_cents > 0
        AND created_at > NOW() - INTERVAL '24 hours'
    `;
    const sales = salesRows[0] || { order_count: 0, gross_cents: 0, unique_buyers: 0 };

    const { rows: signupRows } = await sql`
      SELECT
        COUNT(*) FILTER (WHERE tier = 'preview')::int AS new_reset,
        COUNT(*) FILTER (WHERE tier = 'full')::int AS new_unlimited,
        COUNT(*)::int AS total_new
      FROM users
      WHERE kajabi_entitled = true
        AND created_at > NOW() - INTERVAL '24 hours'
        AND email NOT LIKE ${"%" + ALLOWED_DOMAIN}
    `;
    const signups = signupRows[0] || { new_reset: 0, new_unlimited: 0, total_new: 0 };

    const { rows: completionRows } = await sql`
      SELECT
        COUNT(DISTINCT user_id) FILTER (WHERE day = 1)::int AS day1_completions,
        COUNT(DISTINCT user_id) FILTER (WHERE day = 2)::int AS day2_completions,
        COUNT(DISTINCT user_id) FILTER (WHERE day = 3)::int AS day3_completions
      FROM day_completions
      WHERE completed_at > NOW() - INTERVAL '24 hours'
    `;
    const completions = completionRows[0] || {
      day1_completions: 0,
      day2_completions: 0,
      day3_completions: 0,
    };

    // Format the numbers. Revenue shown net of VAT to match the admin
    // dashboard's default "ex VAT" view.
    const netRevenueEur = Math.round((Number(sales.gross_cents) / 100 / VAT_DIVISOR) * 100) / 100;
    const grossEur = Math.round((Number(sales.gross_cents) / 100) * 100) / 100;

    // Compose the notification body. Multiple short lines so it reads
    // like a tidy receipt at a glance — each one is a specific number
    // Geo cares about, not generic copy.
    const parts = [];
    parts.push(`€${netRevenueEur.toFixed(2)} net · ${sales.order_count} orders · ${sales.unique_buyers} buyers`);
    if (signups.total_new > 0) {
      const sub = [];
      if (signups.new_reset > 0) sub.push(`${signups.new_reset} Reset`);
      if (signups.new_unlimited > 0) sub.push(`${signups.new_unlimited} Unlimited`);
      parts.push(`${signups.total_new} new ${signups.total_new === 1 ? "member" : "members"} (${sub.join(", ")})`);
    } else {
      parts.push("No new signups today");
    }
    const completed = (completions.day1_completions || 0)
      + (completions.day2_completions || 0)
      + (completions.day3_completions || 0);
    if (completed > 0) {
      parts.push(`${completions.day1_completions} D1 · ${completions.day2_completions} D2 · ${completions.day3_completions} D3 finished`);
    }

    const dayKey = new Date().toISOString().slice(0, 10);
    const result = await notifyAdmins({
      title: "📊 Today on The Field",
      body: parts.join(" · "),
      url: "/admin",
      tag: `daily-summary-${dayKey}`,
      notificationKey: `daily-summary-${dayKey}`,
      requireInteraction: false,
    });

    return res.status(200).json({
      ok: true,
      day: dayKey,
      ...sales,
      ...signups,
      ...completions,
      notification: result,
    });
  } catch (err) {
    console.error("daily_summary_error", { message: err?.message });
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message,
    });
  }
}
