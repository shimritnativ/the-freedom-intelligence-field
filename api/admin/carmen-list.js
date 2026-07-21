// api/admin/carmen-list.js
//
// The full member roster for Carmen's outreach dashboard. Carmen does
// warm phone calls to Reset buyers who haven't taken action — the goal is
// to qualify them and route the hottest ones to Shimrit for high-ticket
// sales.
//
// Returns everything Carmen needs in one shot:
//   - name / email / tier / joined / first_login / last_completed_day
//   - phone (most recent contact_phone from whatsapp_message_events)
//   - last_message_at (last time they wrote to the Field)
//   - contacted flag (from carmen_contacted, with 30-day TTL)
//   - has_cheat_sheet (whether Aira has written notes for this member)
//
// Filters applied server-side:
//   - kajabi_entitled = true   → excludes refunded / revoked members
//   - not a @shimritnativ.com / @masteryourpath.* email → excludes staff
//
// Auth: @shimritnativ.com session token, same as every other admin endpoint.
// When Carmen has her own carmen@shimritnativ.com email + session she'll
// authenticate through the same flow.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const CONTACTED_TTL_DAYS = 30;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  // Auth
  const sessionToken = req.headers["x-session-token"];
  const user = await getUserBySessionToken(sessionToken);
  if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const { rows } = await sql`
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.tier,
        u.subscription_plan,
        u.created_at,
        u.first_login_at,
        u.preview_ends_at,
        u.last_completed_day,
        wa.contact_phone   AS phone,
        wa.contact_name    AS wa_name,
        wa.ghl_contact_id  AS ghl_contact_id,
        msg.last_user_message_at,
        cc.contacted_at    AS contacted_at,
        cc.contacted_by    AS contacted_by,
        cc.outcome         AS call_outcome,
        -- GHL tag flags. We match case-insensitively against the JSONB
        -- tags array. Uses EXISTS + jsonb_array_elements_text so a tag
        -- like "Newly Engaged Reset" matches whether Aira typed it in
        -- caps, mixed case, or lower.
        -- "Newly engaged" flag catches any variant: "newly engaged",
        -- "reset newly engaged", "newly engaged reset", "reset - newly
        -- engaged", etc. A single '%newly engaged%' match covers them all.
        EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(mgt.tags, '[]'::jsonb)) t(tag)
          WHERE LOWER(t.tag) LIKE '%newly engaged%'
        ) AS is_newly_engaged,
        -- Rise program — split into CURRENT vs PAST.
        --   Current tags:  "rise client", "rise paused", bare "rise"
        --   Past tags:     "rise past client", "past rise client", "rise graduate"
        -- OR'd with the manual override table so Geo can flag members whose
        -- GHL tags don't reflect reality yet.
        (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(mgt.tags, '[]'::jsonb)) t(tag)
            WHERE LOWER(t.tag) IN ('rise client', 'rise paused', 'rise')
          )
          OR COALESCE(mpo.is_rise_current, false)
        ) AS is_rise_current,
        (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(mgt.tags, '[]'::jsonb)) t(tag)
            WHERE LOWER(t.tag) LIKE '%past rise client%'
               OR LOWER(t.tag) LIKE 'rise past%'
               OR LOWER(t.tag) LIKE '%rise graduate%'
          )
          OR COALESCE(mpo.is_rise_past, false)
        ) AS is_rise_past,
        -- MYP Certification program — tag OR manual override.
        (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(mgt.tags, '[]'::jsonb)) t(tag)
            WHERE LOWER(t.tag) LIKE '%myp certificate%'
               OR LOWER(t.tag) LIKE '%myp cert%'
               OR LOWER(t.tag) LIKE '%coaching certification%'
          )
          OR COALESCE(mpo.is_certification, false)
        ) AS is_certification,
        mgt.updated_at AS tags_synced_at,
        -- Last DM date pulled from the GHL custom field named "last dm date"
        -- (case-insensitive). If Shimrit renames it we broaden the match here.
        (
          SELECT value
          FROM jsonb_each_text(COALESCE(mgt.custom_fields, '{}'::jsonb))
          WHERE LOWER(key) LIKE '%last dm%'
             OR LOWER(key) LIKE '%last%direct message%'
          LIMIT 1
        ) AS last_dm_date_raw,
        -- Cheat sheet flags. has_cheat_sheet=true iff EITHER the auto-
        -- generated tag_summary or Aira's manual notes have content.
        (cs.tag_summary IS NOT NULL AND LENGTH(TRIM(cs.tag_summary)) > 0) AS has_tag_summary,
        (cs.notes       IS NOT NULL AND LENGTH(TRIM(cs.notes))       > 0) AS has_notes
      FROM users u
      LEFT JOIN LATERAL (
        SELECT contact_phone, contact_name, ghl_contact_id
        FROM whatsapp_message_events
        WHERE LOWER(contact_email) = LOWER(u.email)
          AND contact_phone IS NOT NULL
          AND contact_phone <> ''
        ORDER BY event_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      ) wa ON true
      LEFT JOIN LATERAL (
        SELECT MAX(created_at) AS last_user_message_at
        FROM messages
        WHERE user_id = u.id AND role = 'user'
      ) msg ON true
      LEFT JOIN carmen_contacted cc
        ON LOWER(cc.email) = LOWER(u.email)
       AND cc.contacted_at > NOW() - (${CONTACTED_TTL_DAYS}::text || ' days')::interval
      LEFT JOIN member_ghl_tags mgt
        ON LOWER(mgt.email) = LOWER(u.email)
      LEFT JOIN member_program_overrides mpo
        ON LOWER(mpo.email) = LOWER(u.email)
      LEFT JOIN member_cheat_sheets cs
        ON LOWER(cs.email) = LOWER(u.email)
      WHERE u.kajabi_entitled = true
        -- Staff / test accounts — never surface to Carmen. Emails collected
        -- explicitly rather than by domain because most staff use gmail.
        AND u.email NOT ILIKE '%@shimritnativ.com'
        AND u.email NOT ILIKE '%@masteryourpath.%'
        AND u.email NOT ILIKE '%ge.amaral%'         -- Geo
        AND u.email NOT ILIKE '%geoamaral%'         -- Geo (alt spelling)
        AND u.email NOT ILIKE 'airabueno.va@%'      -- Aira
        AND u.email NOT ILIKE 'rejikaa@%'           -- Rejane
        AND u.email NOT ILIKE 'tomer32i@%'          -- Tomer
        AND u.email NOT ILIKE 'ido@%'               -- Ido (bare handle)
        AND u.email NOT ILIKE 'ido.%'               -- Ido (firstname.lastname)
        AND u.email NOT ILIKE 'idobukelman@%'       -- Ido (his real gmail)
        AND u.email NOT ILIKE 'shimrit.nativ@%'     -- Shimrit (personal gmail)
        AND u.email NOT ILIKE 'rachelnativ@%'       -- Rachel Nativ (family)
        AND u.email NOT ILIKE 'brunadudas777@%'     -- Bruna (per Geo's request 2026-07-20)
        AND u.email NOT ILIKE 'jerome.feinberg@%'   -- Jerome (per Geo's request 2026-07-20)
        AND u.email NOT ILIKE 'giorgia.goldberg@%'  -- Giorgia — refunded ("didn't like it")
        AND u.email NOT ILIKE 'carmen.faunback@%'   -- Carmen herself
        AND u.email NOT ILIKE 'nobody@%'            -- test placeholder
        AND u.email NOT ILIKE '%+test%'             -- plus-addressed test emails
        AND u.email NOT ILIKE '%+tctest%'
        AND u.email NOT ILIKE '%+power50test%'
      ORDER BY u.created_at DESC
    `;

    const members = rows.map((r) => ({
      email: r.email,
      display_name: r.display_name || r.wa_name || null,
      tier: r.tier,
      subscription_plan: r.subscription_plan,
      created_at: r.created_at,
      first_login_at: r.first_login_at,
      preview_ends_at: r.preview_ends_at,
      last_completed_day: r.last_completed_day || 0,
      phone: r.phone || null,
      ghl_contact_id: r.ghl_contact_id || null,
      last_user_message_at: r.last_user_message_at || null,
      contacted: !!r.contacted_at,
      contacted_at: r.contacted_at || null,
      contacted_by: r.contacted_by || null,
      call_outcome: r.call_outcome || null,
      is_newly_engaged: !!r.is_newly_engaged,
      is_rise_current: !!r.is_rise_current,
      is_rise_past: !!r.is_rise_past,
      is_certification: !!r.is_certification,
      tags_synced_at: r.tags_synced_at || null,
      has_tag_summary: !!r.has_tag_summary,
      has_notes: !!r.has_notes,
      has_cheat_sheet: !!r.has_tag_summary || !!r.has_notes,
      last_dm_date: r.last_dm_date_raw || null,
    }));

    return res.status(200).json({
      ok: true,
      count: members.length,
      members,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("carmen_list_failed", e);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
}
