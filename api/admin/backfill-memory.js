// api/admin/backfill-memory.js
// One-time (or as-needed) backfill that runs the durable-fact extractor
// against every past user message and populates memory_summaries.
//
// Why: Phase 2 of the cross-process memory system extracts facts on each
// new chat turn going forward. But members who already had conversations
// before the feature shipped have facts buried in those past messages
// (their name, partner, work, recurring patterns) that the Field never
// captured. This endpoint walks the existing message history and pulls
// them out so the memory block is rich for everyone, not just new chats.
//
// Auth:
//   - Vercel-cron User-Agent (auto)
//   - ADMIN_TOKEN via x-admin-token header or ?token=
//   - x-session-token from a logged-in @shimritnativ.com member
//
// Usage:
//   curl -X POST "https://thefieldai.app/api/admin/backfill-memory?token=ADMIN_TOKEN"
//
// Optional query params:
//   ?dry_run=1          — count what WOULD be extracted, write nothing
//   ?user_id=<uuid>     — restrict to one user
//   ?email=<addr>       — restrict to one user by email (lowercased)
//   ?since=YYYY-MM-DD   — only process messages after this date
//   ?limit=N            — cap the total number of messages processed
//                         (handy for staged backfills — run 100 messages,
//                          inspect results, then run more)
//
// Cost: every heuristic-matched user message fires one Haiku call. The
// heuristic skips ~80% of messages, so a 1000-message history typically
// runs ~200 Haiku calls (~€0.20 total). Existing facts are skipped via
// LOWER(content) dedup in saveDurableFacts, so re-runs are cheap.
//
// Idempotent: safe to re-run. Already-saved facts are detected and
// skipped per-row.

import { sql } from "@vercel/postgres";
import {
  looksLikeFactSharing,
  extractDurableFacts,
  saveDurableFacts,
} from "../../lib/memory.js";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

export const config = {
  // Each Haiku call is ~1s. A few hundred messages can take 5+ minutes.
  // Cap at the Vercel maximum so we don't bail mid-backfill.
  maxDuration: 300,
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  // CORS so the admin dashboard can call this from the browser.
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-admin-token");

  // Same dual-auth pattern as backfill-completions: any of the three
  // paths is enough. We let cron in (User-Agent), an explicit admin
  // token (curl/scripts), or a logged-in @shimritnativ.com session
  // (dashboard button).
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
  if (!authorized) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const q = req.query || {};
  const dryRun = q.dry_run === "1" || q.dry_run === "true";
  const userIdFilter = (q.user_id || "").trim() || null;
  const emailFilter = (q.email || "").trim().toLowerCase() || null;
  const sinceFilter = (q.since || "").trim() || null;
  const limit = q.limit ? Math.max(1, Math.min(5000, Number(q.limit))) : null;

  try {
    // If filtering by email, resolve to user_id once up front so the
    // hot inner query stays a simple indexed lookup on messages.user_id.
    let effectiveUserId = userIdFilter;
    if (!effectiveUserId && emailFilter) {
      const { rows } = await sql`
        SELECT id FROM users WHERE email = ${emailFilter} LIMIT 1
      `;
      if (!rows[0]) {
        return res.status(404).json({ error: "user_not_found", email: emailFilter });
      }
      effectiveUserId = rows[0].id;
    }

    // Pull candidate user messages. We process oldest-first so when a
    // fact is mentioned multiple times across the history, the earliest
    // mention is the one that lands in memory_summaries (with the
    // earliest source_message_id). Later duplicates are detected by the
    // dedup check in saveDurableFacts and skipped silently.
    const conditions = ["m.role = 'user'", "m.content IS NOT NULL", "LENGTH(m.content) >= 12"];
    if (effectiveUserId) conditions.push(`m.user_id = '${effectiveUserId}'`);
    if (sinceFilter && /^\d{4}-\d{2}-\d{2}$/.test(sinceFilter)) {
      conditions.push(`m.created_at >= '${sinceFilter}'::date`);
    }
    const whereClause = conditions.join(" AND ");
    const limitClause = limit ? `LIMIT ${limit}` : "";

    const { rows: messages } = await sql.query(`
      SELECT m.id, m.user_id, m.content, m.created_at, u.email
      FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE ${whereClause}
      ORDER BY m.user_id, m.created_at ASC
      ${limitClause}
    `);

    const summary = {
      total_messages_scanned: messages.length,
      heuristic_hits: 0,
      extraction_calls: 0,
      facts_extracted: 0,
      facts_saved_new: 0,
      facts_skipped_duplicate: 0,
      errors: 0,
      users_touched: new Set(),
      dry_run: dryRun,
    };

    // Process sequentially to keep concurrent Haiku load reasonable and
    // to avoid hammering the API with parallel bursts. Total runtime is
    // bounded by Vercel's 300s ceiling — for very large histories use
    // ?limit= to stage the work across multiple runs.
    for (const m of messages) {
      try {
        if (!looksLikeFactSharing(m.content)) continue;
        summary.heuristic_hits++;
        summary.users_touched.add(m.user_id);

        if (dryRun) continue;

        summary.extraction_calls++;
        const facts = await extractDurableFacts(m.content);
        if (facts.length === 0) continue;
        summary.facts_extracted += facts.length;

        // Count duplicates vs new for visibility — saveDurableFacts
        // returns the count of NEW rows inserted, so the delta is the
        // number of duplicates it skipped.
        const savedNew = await saveDurableFacts({
          userId: m.user_id,
          messageId: m.id,
          facts,
        });
        summary.facts_saved_new += savedNew;
        summary.facts_skipped_duplicate += (facts.length - savedNew);
      } catch (err) {
        summary.errors++;
        console.warn("backfill_memory_message_error", {
          message_id: m.id,
          user_id: m.user_id,
          error: err?.message,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      ...summary,
      users_touched: summary.users_touched.size,
    });
  } catch (err) {
    console.error("backfill_memory_error", { message: err?.message });
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message,
    });
  }
}
