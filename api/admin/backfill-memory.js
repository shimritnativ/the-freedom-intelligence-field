// api/admin/backfill-memory.js
// Resumable, parallelised backfill that extracts durable facts from
// past user messages into memory_summaries.
//
// Why resumable: Vercel functions cap at 5 minutes. A history of a few
// thousand messages × ~1s per Haiku call easily blows that budget. The
// `messages.memory_extracted_at` column (migration 009) marks each
// message after the extractor runs against it — including misses, so
// they aren't re-tried. Each call grabs the next chunk of NULL-marked
// messages, processes them in parallel, returns a `remaining` count.
// The admin UI loops until remaining is 0.
//
// Auth:
//   - Vercel-cron User-Agent (auto)
//   - ADMIN_TOKEN via x-admin-token header or ?token=
//   - x-session-token from a logged-in @shimritnativ.com member
//
// Usage:
//   POST /api/admin/backfill-memory                — process the next chunk
//   POST /api/admin/backfill-memory?dry_run=1     — count what would happen, write nothing
//   POST /api/admin/backfill-memory?user_id=<uuid> — restrict to one user
//   POST /api/admin/backfill-memory?email=<addr>   — restrict to one user by email
//   POST /api/admin/backfill-memory?since=YYYY-MM-DD — only messages after this date
//   POST /api/admin/backfill-memory?chunk=200      — chunk size (default 300, max 1000)
//   POST /api/admin/backfill-memory?reset=1        — clear memory_extracted_at first (forces full re-run)
//
// Cost: ~80% of messages skip Haiku (heuristic), the 20% that hit cost
// ~€0.001 each. A 4,000-message history is roughly €0.80 total.

import { sql } from "@vercel/postgres";
import {
  looksLikeFactSharing,
  extractDurableFacts,
  saveDurableFacts,
} from "../../lib/memory.js";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

// How many extractions to fire in parallel. Higher = faster but heavier
// on the Anthropic side. 8 is a sweet spot — finishes a chunk of 300
// in roughly 40-60s, well inside Vercel's 300s ceiling, and well below
// any reasonable rate limit.
const PARALLELISM = 8;

export const config = {
  maxDuration: 300,
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-admin-token");

  // Same dual-auth pattern as backfill-completions: cron User-Agent OR
  // admin token OR @shimritnativ.com session.
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
  const chunkSize = q.chunk
    ? Math.max(1, Math.min(1000, Number(q.chunk)))
    : 300;
  const reset = q.reset === "1" || q.reset === "true";

  try {
    // Resolve email → user_id once so the inner query stays an indexed
    // lookup on messages.user_id.
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

    // Reset mode: clear the memory_extracted_at marker so this run
    // re-processes everything. Useful if the extraction prompt or
    // heuristic changes and you want fresh results from old messages.
    // Existing facts in memory_summaries are NOT deleted — they stay
    // and the dedup at fact level handles duplicates on re-runs.
    if (reset && !dryRun) {
      if (effectiveUserId) {
        await sql`
          UPDATE messages
          SET memory_extracted_at = NULL
          WHERE user_id = ${effectiveUserId}
            AND role = 'user'
        `;
      } else {
        await sql`
          UPDATE messages
          SET memory_extracted_at = NULL
          WHERE role = 'user'
        `;
      }
    }

    // Build the WHERE clause for both the scan query and the remaining
    // count. Keeping the conditions in a single string lets us use
    // sql.query (raw) instead of fighting tagged-template composition.
    const conditions = [
      "m.role = 'user'",
      "m.content IS NOT NULL",
      "LENGTH(m.content) >= 12",
      "m.memory_extracted_at IS NULL",
    ];
    if (effectiveUserId) {
      // Cast as uuid so the comparison is well-typed.
      conditions.push(`m.user_id = '${effectiveUserId}'::uuid`);
    }
    if (sinceFilter && /^\d{4}-\d{2}-\d{2}$/.test(sinceFilter)) {
      conditions.push(`m.created_at >= '${sinceFilter}'::date`);
    }
    const whereClause = conditions.join(" AND ");

    // How much work remains BEFORE this batch — so we can report
    // accurate progress in the response. Cheap because of the partial
    // index from migration 009.
    const { rows: remainingRows } = await sql.query(`
      SELECT COUNT(*)::int AS remaining
      FROM messages m
      WHERE ${whereClause}
    `);
    const remainingBefore = remainingRows[0]?.remaining || 0;

    // Pull the next chunk of unprocessed user messages. Oldest first so
    // earlier mentions of a fact land in memory_summaries with the
    // earliest source_message_id.
    const { rows: messages } = await sql.query(`
      SELECT m.id, m.user_id, m.content
      FROM messages m
      WHERE ${whereClause}
      ORDER BY m.created_at ASC
      LIMIT ${chunkSize}
    `);

    const summary = {
      chunk_size: chunkSize,
      messages_in_this_chunk: messages.length,
      heuristic_hits: 0,
      extraction_calls: 0,
      facts_extracted: 0,
      facts_saved_new: 0,
      facts_skipped_duplicate: 0,
      errors: 0,
      users_touched: new Set(),
      remaining_before: remainingBefore,
      remaining_after: 0,
      complete: false,
      dry_run: dryRun,
    };

    // Dry run: count heuristic hits without firing Haiku and without
    // marking anything processed. Doesn't advance the cursor — useful
    // to estimate scale before committing.
    if (dryRun) {
      for (const m of messages) {
        if (looksLikeFactSharing(m.content)) {
          summary.heuristic_hits++;
          summary.users_touched.add(m.user_id);
        }
      }
      summary.remaining_after = remainingBefore;
      summary.complete = false;
      return res.status(200).json({
        ok: true,
        ...summary,
        users_touched: summary.users_touched.size,
      });
    }

    // Process the chunk in parallel batches. Each task: run heuristic,
    // run extraction if hit, save facts, mark the message processed.
    // We pool with PARALLELISM concurrent in-flight Haiku calls — going
    // higher invites rate-limit pushback, lower wastes time.
    let cursor = 0;
    async function worker() {
      while (cursor < messages.length) {
        const idx = cursor++;
        const m = messages[idx];
        if (!m) return;
        try {
          summary.users_touched.add(m.user_id);
          const hit = looksLikeFactSharing(m.content);
          if (hit) {
            summary.heuristic_hits++;
            summary.extraction_calls++;
            const facts = await extractDurableFacts(m.content);
            summary.facts_extracted += facts.length;
            if (facts.length > 0) {
              const savedNew = await saveDurableFacts({
                userId: m.user_id,
                messageId: m.id,
                facts,
              });
              summary.facts_saved_new += savedNew;
              summary.facts_skipped_duplicate += (facts.length - savedNew);
            }
          }
          // Mark as processed regardless of hit or miss. Miss = "we
          // tried, nothing to extract". Stops future runs from re-trying.
          await sql`
            UPDATE messages
            SET memory_extracted_at = NOW()
            WHERE id = ${m.id}
          `;
        } catch (err) {
          summary.errors++;
          console.warn("backfill_memory_message_error", {
            message_id: m.id,
            user_id: m.user_id,
            error: err?.message,
          });
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(PARALLELISM, messages.length) }, worker)
    );

    // Re-count remaining after this chunk so the UI knows whether to
    // call us again or stop.
    const { rows: remainingAfterRows } = await sql.query(`
      SELECT COUNT(*)::int AS remaining
      FROM messages m
      WHERE ${whereClause}
    `);
    summary.remaining_after = remainingAfterRows[0]?.remaining || 0;
    summary.complete = summary.remaining_after === 0;

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
