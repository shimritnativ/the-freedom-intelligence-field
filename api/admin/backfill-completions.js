// api/admin/backfill-completions.js
// One-time backfill: re-runs the Day-completion extraction against past
// assistant messages so members who finished before the auto-extraction
// was wired up (Maria et al.) get their day_completions rows retroactively.
//
// Auth: ADMIN_TOKEN env var. Same gate as /api/admin/grant.
//
// Usage:
//   curl -X POST "https://thefieldai.app/api/admin/backfill-completions?token=ADMIN_TOKEN"
//
// Or via browser:
//   https://thefieldai.app/api/admin/backfill-completions?token=ADMIN_TOKEN
//
// Optional query params:
//   ?dry_run=1  — log what WOULD happen without inserting anything
//   ?user_id=<uuid>  — limit to a single user (useful for testing one person)
//   ?day=1  — limit to one day (1, 2, or 3)
//   ?since=YYYY-MM-DD  — only check messages after this date
//
// What it does:
//   1. Pulls all assistant messages where day_at_send IN (1,2,3) for the
//      target user(s) ordered by created_at ASC.
//   2. For each, runs the heuristic. If it hits, fires Haiku extraction.
//   3. If extraction returns a valid completion, inserts into day_completions
//      (ON CONFLICT DO NOTHING — safe to re-run anytime).
//   4. Returns a JSON summary of what was processed.
//
// Idempotency: the underlying recordDayCompletion uses ON CONFLICT
// (user_id, day) DO NOTHING — so members who already have a completion
// row don't get duplicates. Safe to run repeatedly.

import { sql } from "@vercel/postgres";
import { maybeRecordDayCompletion } from "../../lib/dayExtraction.js";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

export const config = {
  // This can run for a while — each Haiku call is ~1-2s. Default 60s isn't
  // enough for backfilling dozens of messages. Cap at 5 minutes.
  maxDuration: 300,
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  // CORS so the admin dashboard can call this from the browser.
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-admin-token");

  // Dual auth path:
  //   1. ADMIN_TOKEN via header or query string (scripts/curl)
  //   2. x-session-token from a logged-in @shimritnativ.com member (dashboard
  //      button, no token to manage)
  // Either passes through. This way you can lose the admin token and still
  // run the backfill from the dashboard.
  const adminToken = process.env.ADMIN_TOKEN;
  const providedAdminToken =
    (req.headers && req.headers["x-admin-token"]) ||
    (req.query && req.query.token) ||
    "";
  const sessionToken = req.headers["x-session-token"];
  let authorized = false;

  // Vercel Cron Jobs hit this endpoint as a GET with the User-Agent
  // "vercel-cron/1.0" — that's how we recognize the scheduled run vs an
  // unauthenticated drive-by. The cron is fired daily by the schedule in
  // vercel.json, no token required.
  const userAgent = String(req.headers["user-agent"] || "");
  const isVercelCron = userAgent.includes("vercel-cron");
  if (isVercelCron) authorized = true;

  if (!authorized && adminToken && providedAdminToken === adminToken) {
    authorized = true;
  } else if (!authorized && sessionToken) {
    const user = await getUserBySessionToken(sessionToken);
    if (user && (user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
      authorized = true;
    }
  }
  if (!authorized) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const q = req.query || {};
  const dryRun = q.dry_run === "1" || q.dry_run === "true";
  const userIdFilter = (q.user_id || "").trim() || null;
  const dayFilter = q.day ? Number(q.day) : null;
  const since = (q.since || "").trim() || null;

  try {
    // Pull candidate assistant messages. Filter by day_at_send so we know
    // which Day schema to extract against. Order by user → date so we
    // process each member's messages in chronological order (relevant if
    // multiple completions exist for the same day in edge cases).
    const conditions = ["m.role = 'assistant'", "m.day_at_send IN (1, 2, 3)"];
    if (userIdFilter) conditions.push(`m.user_id = '${userIdFilter}'`);
    if (dayFilter && [1, 2, 3].includes(dayFilter)) {
      conditions.push(`m.day_at_send = ${dayFilter}`);
    }
    if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) {
      conditions.push(`m.created_at >= '${since}'::date`);
    }

    // Skip messages that already produced a completion. The unique constraint
    // would catch dupes anyway, but skipping early saves the Haiku call cost.
    const whereClause = conditions.join(" AND ");
    const { rows: messages } = await sql.query(`
      SELECT m.id, m.user_id, m.session_id, m.day_at_send, m.content, m.created_at
      FROM messages m
      WHERE ${whereClause}
        AND NOT EXISTS (
          SELECT 1 FROM day_completions dc
          WHERE dc.user_id = m.user_id AND dc.day = m.day_at_send
        )
      ORDER BY m.user_id, m.created_at ASC
    `);

    const summary = {
      candidates: messages.length,
      heuristic_hits: 0,
      extracted: 0,
      recorded: 0,
      skipped_strict: 0,
      errors: 0,
      dry_run: dryRun,
      details: [],
    };

    for (const m of messages) {
      try {
        if (dryRun) {
          // In dry-run, just log which messages would be candidates.
          summary.details.push({
            user_id: m.user_id,
            day: m.day_at_send,
            message_id: m.id,
            created_at: m.created_at,
            preview: (m.content || "").slice(0, 140),
          });
          continue;
        }

        const result = await maybeRecordDayCompletion({
          assistantMessage: m.content,
          day: m.day_at_send,
          userId: m.user_id,
          sessionId: m.session_id,
          messageId: m.id,
        });

        if (result) {
          summary.recorded++;
          summary.details.push({
            user_id: m.user_id,
            day: m.day_at_send,
            message_id: m.id,
            outcome: "recorded",
          });
        } else {
          summary.skipped_strict++;
        }
      } catch (err) {
        summary.errors++;
        summary.details.push({
          user_id: m.user_id,
          day: m.day_at_send,
          message_id: m.id,
          outcome: "error",
          error: err?.message,
        });
      }
    }

    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error("backfill_completions_error", { message: err?.message });
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message });
  }
}
