// api/admin/ghl-tags-sync.js
//
// Pulls each member's GHL tags via the V1 API and caches them in Neon so
// Carmen's page can show tag-derived columns (Newly engaged? Client?)
// without making one API call per row on every page load.
//
// How it works:
//   1. SELECT every active member who has a ghl_contact_id (from the
//      earlier CSV import + manual backfills).
//   2. For each contact, GET https://rest.gohighlevel.com/v1/contacts/{id}
//      and read the `tags` array from the response.
//   3. UPSERT into member_ghl_tags (email PK, tags JSONB, updated_at).
//
// Batched with modest concurrency so 55+ members finish in ~10s without
// hammering GHL. Errors on individual contacts are collected and
// returned rather than failing the whole run.
//
// Trigger this manually from the admin browser console after every push
// of new tag assignments in GHL. If we later want a cron, add it to
// vercel.json — the endpoint is idempotent so re-running is safe.
//
// Auth: @shimritnativ.com session, same as every admin endpoint.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const V1_BASE = "https://rest.gohighlevel.com/v1";
const CONCURRENCY = 5;    // parallel GHL requests
const REQUEST_TIMEOUT_MS = 8000;

async function fetchContactTags(ghlContactId, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${V1_BASE}/contacts/${encodeURIComponent(ghlContactId)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    const data = await res.json();
    const contact = data && data.contact ? data.contact : data;
    const tags = Array.isArray(contact?.tags) ? contact.tags : [];
    return { ok: true, tags, source: contact?.source || null };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

async function runWithConcurrency(items, worker, limit) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { error: e.message };
      }
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(next());
  await Promise.all(runners);
  return results;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sessionToken = req.headers["x-session-token"];
  const user = await getUserBySessionToken(sessionToken);
  if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const apiKey = process.env.GHL_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ghl_api_key_missing" });

  const startedAt = Date.now();

  // Fetch the roster: every active member who has a GHL contact ID we
  // can look up. The LATERAL matches the pattern carmen-list uses, so we
  // sync exactly the set of contacts Carmen sees.
  const { rows: members } = await sql`
    SELECT DISTINCT ON (LOWER(u.email))
      LOWER(u.email) AS email,
      wa.ghl_contact_id
    FROM users u
    LEFT JOIN LATERAL (
      SELECT ghl_contact_id
      FROM whatsapp_message_events
      WHERE LOWER(contact_email) = LOWER(u.email)
        AND ghl_contact_id IS NOT NULL AND ghl_contact_id <> ''
      ORDER BY event_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    ) wa ON true
    WHERE u.kajabi_entitled = true
      AND wa.ghl_contact_id IS NOT NULL
    ORDER BY LOWER(u.email)
  `;

  if (members.length === 0) {
    return res.status(200).json({
      ok: true,
      synced: 0,
      note: "No members with a ghl_contact_id found. Run the CSV import + manual backfill first.",
      elapsed_ms: Date.now() - startedAt,
    });
  }

  // Fan out with modest concurrency.
  const results = await runWithConcurrency(
    members,
    async (m) => {
      const r = await fetchContactTags(m.ghl_contact_id, apiKey);
      if (!r.ok) return { email: m.email, ok: false, status: r.status, error: r.error };
      // Upsert the tags into Neon.
      try {
        await sql`
          INSERT INTO member_ghl_tags (email, tags, source, updated_at)
          VALUES (${m.email}, ${JSON.stringify(r.tags)}::jsonb, ${r.source}, NOW())
          ON CONFLICT (email) DO UPDATE SET
            tags       = EXCLUDED.tags,
            source     = EXCLUDED.source,
            updated_at = NOW()
        `;
        return { email: m.email, ok: true, tag_count: r.tags.length };
      } catch (e) {
        return { email: m.email, ok: false, error: "db_write_failed: " + e.message };
      }
    },
    CONCURRENCY
  );

  const synced = results.filter((r) => r && r.ok).length;
  const failed = results.filter((r) => r && !r.ok);

  return res.status(200).json({
    ok: true,
    total_candidates: members.length,
    synced,
    failed_count: failed.length,
    failed: failed.slice(0, 20), // cap for readability
    elapsed_ms: Date.now() - startedAt,
  });
}

/*
==============================================================================
ONE-TIME SQL MIGRATION — run in Neon SQL editor before hitting this endpoint.
Idempotent — safe to re-run.
==============================================================================

CREATE TABLE IF NOT EXISTS member_ghl_tags (
  email      TEXT PRIMARY KEY,
  tags       JSONB NOT NULL DEFAULT '[]'::jsonb,
  source     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_member_ghl_tags_updated
  ON member_ghl_tags (updated_at DESC);

-- GIN index so tag membership checks (tags @> '["foo"]') are fast.
CREATE INDEX IF NOT EXISTS idx_member_ghl_tags_gin
  ON member_ghl_tags USING GIN (tags);
*/
