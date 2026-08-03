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

// Fetches all custom-field definitions for the location so we can map
// the opaque field IDs returned per contact to human-readable names.
// Called ONCE per sync run and cached in memory for the duration.
async function fetchCustomFieldMap(apiKey) {
  try {
    const res = await fetch(`${V1_BASE}/custom-fields/`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) return {};
    const data = await res.json();
    const list = data && data.customFields ? data.customFields : (Array.isArray(data) ? data : []);
    const map = {};
    for (const f of list) {
      if (f && f.id) map[f.id] = f.name || f.fieldKey || f.id;
    }
    return map;
  } catch {
    return {};
  }
}

async function fetchContactTags(ghlContactId, apiKey, fieldNameById) {
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

    // Custom fields come back as an array of {id, value} pairs. We keyed
    // the map by ID at start of run — convert to {name: value} here so
    // downstream code can just look up by human-readable name.
    const cfByName = {};
    const rawFields = contact?.customField || contact?.customFields || [];
    if (Array.isArray(rawFields)) {
      for (const f of rawFields) {
        if (!f) continue;
        const name = (fieldNameById && fieldNameById[f.id]) || f.id;
        if (name && f.value !== undefined) cfByName[name] = f.value;
      }
    } else if (rawFields && typeof rawFields === "object") {
      // Some GHL responses return an object keyed by field id.
      for (const [id, value] of Object.entries(rawFields)) {
        const name = (fieldNameById && fieldNameById[id]) || id;
        cfByName[name] = value;
      }
    }

    // Standard fields we want alongside tags. phone is the big one —
    // Carmen's dashboard uses it to open WhatsApp Web directly.
    // GHL exposes phone with country code (e.g. "+351914308424").
    const phone = contact?.phone || null;
    const contactId = contact?.id || ghlContactId;

    return { ok: true, tags, source: contact?.source || null, customFields: cfByName, phone, contactId };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

// Look up a GHL contact by email. Returns { ok, contactId } on success.
// Used to find contacts for members who have never messaged via WhatsApp
// (so we don't have their ghl_contact_id in whatsapp_message_events yet).
async function lookupContactByEmail(email, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${V1_BASE}/contacts/lookup?email=${encodeURIComponent(email)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    const list = Array.isArray(data?.contacts) ? data.contacts : (data?.contact ? [data.contact] : []);
    const match = list[0];
    if (!match || !match.id) return { ok: false, status: 404 };
    return { ok: true, contactId: match.id };
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

  // Fetch the custom-field ID→name map once at the start. Every contact
  // fetch reuses this to convert opaque IDs into names like "Last DM Date".
  const fieldNameById = await fetchCustomFieldMap(apiKey);

  // Fetch the roster: every active member. If we have their
  // ghl_contact_id (from wa_message_events or a previous sync), use
  // it directly. Otherwise the worker below looks them up by email.
  // Extended 2026-07-28 so members who never messaged WhatsApp also
  // get their phone + tags synced from GHL.
  const { rows: members } = await sql`
    SELECT DISTINCT ON (LOWER(u.email))
      LOWER(u.email) AS email,
      COALESCE(wa.ghl_contact_id, mgt_existing.ghl_contact_id) AS ghl_contact_id
    FROM users u
    LEFT JOIN LATERAL (
      SELECT ghl_contact_id
      FROM whatsapp_message_events
      WHERE LOWER(contact_email) = LOWER(u.email)
        AND ghl_contact_id IS NOT NULL AND ghl_contact_id <> ''
      ORDER BY event_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    ) wa ON true
    LEFT JOIN member_ghl_tags mgt_existing
      ON LOWER(mgt_existing.email) = LOWER(u.email)
    WHERE u.kajabi_entitled = true
      AND u.email NOT ILIKE '%@shimritnativ.com'
      AND u.email NOT ILIKE '%@masteryourpath.%'
    ORDER BY LOWER(u.email)
  `;

  if (members.length === 0) {
    return res.status(200).json({
      ok: true,
      synced: 0,
      note: "No active Kajabi-entitled members found.",
      elapsed_ms: Date.now() - startedAt,
    });
  }

  // Fan out with modest concurrency.
  const results = await runWithConcurrency(
    members,
    async (m) => {
      // Resolve GHL contact ID. If we don't have one stored, look up
      // the member by email in GHL (new since 2026-07-28 so members
      // who never messaged WhatsApp also get their phone synced).
      let ghlContactId = m.ghl_contact_id;
      if (!ghlContactId) {
        const lookup = await lookupContactByEmail(m.email, apiKey);
        if (!lookup.ok) {
          return { email: m.email, ok: false, status: lookup.status, error: "email_lookup_failed" };
        }
        ghlContactId = lookup.contactId;
      }

      const r = await fetchContactTags(ghlContactId, apiKey, fieldNameById);
      if (!r.ok) return { email: m.email, ok: false, status: r.status, error: r.error };
      // Upsert the tags + custom fields + phone + contact_id into Neon.
      try {
        await sql`
          INSERT INTO member_ghl_tags (email, tags, source, custom_fields, phone, ghl_contact_id, updated_at)
          VALUES (
            ${m.email},
            ${JSON.stringify(r.tags)}::jsonb,
            ${r.source},
            ${JSON.stringify(r.customFields || {})}::jsonb,
            ${r.phone},
            ${r.contactId || ghlContactId},
            NOW()
          )
          ON CONFLICT (email) DO UPDATE SET
            tags           = EXCLUDED.tags,
            source         = EXCLUDED.source,
            custom_fields  = EXCLUDED.custom_fields,
            phone          = COALESCE(EXCLUDED.phone, member_ghl_tags.phone),
            ghl_contact_id = COALESCE(EXCLUDED.ghl_contact_id, member_ghl_tags.ghl_contact_id),
            updated_at     = NOW()
        `;
        return {
          email: m.email,
          ok: true,
          tag_count: r.tags.length,
          custom_field_count: Object.keys(r.customFields || {}).length,
          phone_synced: !!r.phone,
          via_email_lookup: !m.ghl_contact_id,
        };
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
    custom_fields_discovered: Object.keys(fieldNameById).length,
    custom_field_names: Object.values(fieldNameById).slice(0, 40), // helpful for debugging
    elapsed_ms: Date.now() - startedAt,
  });
}

/*
==============================================================================
ONE-TIME SQL MIGRATION — run in Neon SQL editor before hitting this endpoint.
Idempotent — safe to re-run.
==============================================================================

CREATE TABLE IF NOT EXISTS member_ghl_tags (
  email         TEXT PRIMARY KEY,
  tags          JSONB NOT NULL DEFAULT '[]'::jsonb,
  source        TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- If the table already exists from an earlier sync, add the custom_fields
-- column non-destructively:
ALTER TABLE member_ghl_tags
  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Added 2026-07-28: phone (from GHL contact.phone) + ghl_contact_id
-- (captured via email lookup if not from wa_events). Used by
-- carmen-list.js to show WhatsApp icon for members who have never
-- messaged the business number.
ALTER TABLE member_ghl_tags
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS ghl_contact_id TEXT;

CREATE INDEX IF NOT EXISTS idx_member_ghl_tags_updated
  ON member_ghl_tags (updated_at DESC);

-- GIN index so tag membership checks (tags @> '["foo"]') are fast.
CREATE INDEX IF NOT EXISTS idx_member_ghl_tags_gin
  ON member_ghl_tags USING GIN (tags);
*/
