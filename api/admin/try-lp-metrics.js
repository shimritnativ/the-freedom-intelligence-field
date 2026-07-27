// api/admin/try-lp-metrics.js
//
// Analytics for the /try Free Trial Landing Page. Powers the
// "Free Trial Landing Page" section under the Ads tab in the admin
// dashboard. Reads from landing_events (client-side tracked events)
// and free_trials (authoritative form-submission source).
//
// Auth: same @shimritnativ.com session gate as the rest of the admin.
//
// Query params:
//   ?range=today | 7d | 30d | lifetime      (default: 7d)
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD          (overrides ?range)
//
// Returns:
//   {
//     ok: true,
//     range: { from, to, label },
//     totals: {
//       page_views, form_starts, form_completions,
//       reset_cta_clicks, free_cta_clicks,
//       video_plays, video_completes, audio_unmutes
//     },
//     by_doorway: {
//       results:       { starts, completions },
//       relationships: { starts, completions },
//       decisions:     { starts, completions }
//     },
//     reset_cta_by_position: [{ position, clicks }],
//     free_cta_by_position:  [{ position, clicks }],
//     video_funnel: { plays, watch_25, watch_50, watch_75, complete },
//     rates: { form_conversion, video_completion, audio_unmute }
//   }

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

// Resolve ?range or ?from/?to into concrete start/end timestamps.
// Mirrors the pattern in ads-metrics.js so date ranges behave the
// same way across all admin sections.
function resolveRange(query) {
  const now = new Date();
  const toIso = (d) => d.toISOString();
  const startOfDayUtc = (d) => {
    const x = new Date(d);
    x.setUTCHours(0, 0, 0, 0);
    return x;
  };
  const endOfDayUtc = (d) => {
    const x = new Date(d);
    x.setUTCHours(23, 59, 59, 999);
    return x;
  };

  // Custom from/to overrides everything else.
  if (query.from && query.to) {
    const from = new Date(query.from + "T00:00:00Z");
    const to = new Date(query.to + "T23:59:59Z");
    if (!isNaN(from) && !isNaN(to)) {
      return { from: toIso(from), to: toIso(to), label: "custom" };
    }
  }

  const range = (query.range || "7d").toLowerCase();
  if (range === "today") {
    return { from: toIso(startOfDayUtc(now)), to: toIso(endOfDayUtc(now)), label: "today" };
  }
  if (range === "lifetime") {
    return { from: "2020-01-01T00:00:00Z", to: toIso(endOfDayUtc(now)), label: "lifetime" };
  }
  const daysMap = { "7d": 7, "30d": 30, "90d": 90 };
  const days = daysMap[range] || 7;
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: toIso(startOfDayUtc(from)), to: toIso(endOfDayUtc(now)), label: range };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Auth — same gate as every other admin endpoint.
  const sessionToken = req.headers["x-session-token"];
  const user = await getUserBySessionToken(sessionToken);
  if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const range = resolveRange(req.query || {});
  const from = range.from;
  const to = range.to;

  try {
    // Top-line counts — one query per event bucket. Simpler than a
    // single grouped query and easier to read/edit later.
    const [
      pageViewsRes,
      formStartsRes,
      resetCtaRes,
      freeCtaRes,
      videoPlaysRes,
      videoCompleteRes,
      audioUnmuteRes,
    ] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n FROM landing_events
          WHERE event_type = 'try_page_view'
            AND created_at >= ${from} AND created_at <= ${to}`,
      sql`SELECT COUNT(*)::int AS n FROM landing_events
          WHERE event_type LIKE 'try_form_start:%'
            AND created_at >= ${from} AND created_at <= ${to}`,
      sql`SELECT COUNT(*)::int AS n FROM landing_events
          WHERE event_type LIKE 'try_cta_click:%'
            AND created_at >= ${from} AND created_at <= ${to}`,
      sql`SELECT COUNT(*)::int AS n FROM landing_events
          WHERE event_type LIKE 'try_free_cta_click:%'
            AND created_at >= ${from} AND created_at <= ${to}`,
      sql`SELECT COUNT(*)::int AS n FROM landing_events
          WHERE event_type = 'try_video_play'
            AND created_at >= ${from} AND created_at <= ${to}`,
      sql`SELECT COUNT(*)::int AS n FROM landing_events
          WHERE event_type = 'try_video_complete'
            AND created_at >= ${from} AND created_at <= ${to}`,
      sql`SELECT COUNT(*)::int AS n FROM landing_events
          WHERE event_type = 'try_audio_unmute'
            AND created_at >= ${from} AND created_at <= ${to}`,
    ]);

    // Doorway breakdown — starts (from events) + completions (from
    // free_trials, which is the source of truth for actual form
    // submissions). is_staff_test = false filters out Shimrit/team.
    // free_trials has no created_at column; expires_at = created_at
    // + 15 minutes so it's a close-enough proxy for time-filtering.
    const [doorwayStartsRes, doorwayCompletionsRes] = await Promise.all([
      sql`SELECT SPLIT_PART(event_type, ':', 2) AS scenario, COUNT(*)::int AS n
          FROM landing_events
          WHERE event_type LIKE 'try_form_start:%'
            AND created_at >= ${from} AND created_at <= ${to}
          GROUP BY scenario`,
      sql`SELECT scenario, COUNT(*)::int AS n
          FROM free_trials
          WHERE is_staff_test = false
            AND expires_at >= ${from} AND expires_at <= ${to}
          GROUP BY scenario`,
    ]);

    // CTA breakdown by position (utm_content label).
    const [resetCtaByPosRes, freeCtaByPosRes] = await Promise.all([
      sql`SELECT SPLIT_PART(event_type, ':', 2) AS position, COUNT(*)::int AS clicks
          FROM landing_events
          WHERE event_type LIKE 'try_cta_click:%'
            AND created_at >= ${from} AND created_at <= ${to}
          GROUP BY position
          ORDER BY clicks DESC`,
      sql`SELECT SPLIT_PART(event_type, ':', 2) AS position, COUNT(*)::int AS clicks
          FROM landing_events
          WHERE event_type LIKE 'try_free_cta_click:%'
            AND created_at >= ${from} AND created_at <= ${to}
          GROUP BY position
          ORDER BY clicks DESC`,
    ]);

    // Video funnel — all milestone counts in one grouped query so the
    // shape is easy to render as a step chart.
    const videoFunnelRes = await sql`
      SELECT event_type, COUNT(*)::int AS n
      FROM landing_events
      WHERE event_type IN (
        'try_video_play',
        'try_video_watch_25',
        'try_video_watch_50',
        'try_video_watch_75',
        'try_video_complete'
      )
        AND created_at >= ${from} AND created_at <= ${to}
      GROUP BY event_type
    `;
    const videoFunnel = {
      plays: 0, watch_25: 0, watch_50: 0, watch_75: 0, complete: 0
    };
    for (const row of videoFunnelRes.rows) {
      const key = row.event_type.replace("try_video_", "").replace("play", "plays");
      if (key in videoFunnel) videoFunnel[key] = row.n;
    }

    // Assemble doorway breakdown into a single object keyed by scenario.
    const SCENARIOS = ["results", "relationships", "decisions"];
    const byDoorway = {};
    for (const s of SCENARIOS) {
      byDoorway[s] = { starts: 0, completions: 0 };
    }
    for (const row of doorwayStartsRes.rows) {
      if (byDoorway[row.scenario]) byDoorway[row.scenario].starts = row.n;
    }
    for (const row of doorwayCompletionsRes.rows) {
      if (byDoorway[row.scenario]) byDoorway[row.scenario].completions = row.n;
    }

    const totals = {
      page_views: pageViewsRes.rows[0]?.n || 0,
      form_starts: formStartsRes.rows[0]?.n || 0,
      form_completions: Object.values(byDoorway).reduce((s, d) => s + d.completions, 0),
      reset_cta_clicks: resetCtaRes.rows[0]?.n || 0,
      free_cta_clicks: freeCtaRes.rows[0]?.n || 0,
      video_plays: videoPlaysRes.rows[0]?.n || 0,
      video_completes: videoCompleteRes.rows[0]?.n || 0,
      audio_unmutes: audioUnmuteRes.rows[0]?.n || 0,
    };

    // Derived rates. Guard against div-by-zero. Return as decimals
    // (0-1) so the client can format however it wants.
    const rate = (num, den) => (den > 0 ? num / den : 0);
    const rates = {
      form_conversion: rate(totals.form_completions, totals.page_views),
      video_completion: rate(totals.video_completes, totals.video_plays),
      audio_unmute: rate(totals.audio_unmutes, totals.video_plays),
      // How many page_view sessions ended up clicking any Reset CTA
      reset_cta_ctr: rate(totals.reset_cta_clicks, totals.page_views),
      free_cta_ctr: rate(totals.free_cta_clicks, totals.page_views),
    };

    return res.status(200).json({
      ok: true,
      range,
      totals,
      by_doorway: byDoorway,
      reset_cta_by_position: resetCtaByPosRes.rows,
      free_cta_by_position: freeCtaByPosRes.rows,
      video_funnel: videoFunnel,
      rates,
      meta: { fetched_at: new Date().toISOString() },
    });
  } catch (err) {
    console.error("try_lp_metrics_failed", { message: err?.message, stack: err?.stack });
    return res.status(500).json({ ok: false, error: "internal_error", message: err?.message });
  }
}
