// api/admin/manual-outreach-queue.js
//
// Live "Manual Outreach Queue" for Aira — pulls all GHL contacts with US
// (+1) or UK (+44) phone numbers, cross-references with our Neon users
// table to enrich with purchase date + Reset progress, and returns a
// ranked list of members who likely aren't getting the automated
// WhatsApp sequence (because GHL delivery is unreliable to those regions).
//
// Uses GHL's V1 API (rest.gohighlevel.com/v1) because our token is a V1
// Location API Key. If we later switch to a V2 PIT with contacts scope,
// we would swap the fetch URL + auth style.
//
// Auth (our side): same @shimritnativ.com session gate as every other
// admin endpoint.
//
// Env vars required (add via Vercel Settings → Environment Variables):
//   GHL_API_KEY        — V1 Location API Key (UUID format, no prefix)
//   GHL_LOCATION_ID    — GHL sub-account location ID
//
// Response:
//   { queue: [{ email, display_name, phone, country, days_since_purchase,
//               last_completed_day, tier, next_message }], count: N }

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const GHL_V1_BASE = "https://rest.gohighlevel.com/v1";

// Fetch contacts from GHL V1 with a query string. GHL's V1 /contacts/
// endpoint supports a general `query` param that searches across name,
// email, phone, and other fields. We pass a phone prefix as the query
// and post-filter for actual phone match. Paginates to catch up to 300
// results (3 pages of 100).
async function fetchGhlContactsMatchingPhone({ apiKey, phonePrefix }) {
  const collected = [];
  let startAfter = null;
  let startAfterId = null;
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({ limit: "100", query: phonePrefix });
    if (startAfter) params.set("startAfter", startAfter);
    if (startAfterId) params.set("startAfterId", startAfterId);
    const url = `${GHL_V1_BASE}/contacts/?${params.toString()}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ghl_v1_${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const contacts = data.contacts || [];
    collected.push(...contacts);
    if (contacts.length < 100) break;
    const last = contacts[contacts.length - 1];
    startAfter = last.dateAdded ? new Date(last.dateAdded).getTime() : null;
    startAfterId = last.id;
    if (!startAfter || !startAfterId) break;
  }
  return collected;
}

// Compute member status. Priority order:
//   wa_failed      — GHL sent a WhatsApp that FAILED to deliver in last 30d
//                    (highest priority — confirmed delivery problem)
//   never_started  — 0 messages sent to Field, purchased 2+ days ago
//   started_no_complete — messages sent, no day completed
//   behind         — some completions but well behind schedule
//   on_track       — engaging appropriately
function computeStatus({ days, userMessages, completions, waFailures }) {
  if (waFailures > 0) return "wa_failed";
  if (days < 2) return "too_recent";
  if (userMessages === 0) return "never_started";
  if (completions === 0) return "started_no_complete";
  if (days >= 5 && completions < 3) return "behind";
  if (days >= 3 && completions === 0) return "behind";
  return "on_track";
}

// Actionable next-step message based on Neon state.
function computeNextMessage({ days, userMessages, completions, waFailures }) {
  if (waFailures > 0) {
    return `WA MESSAGES FAILING (${waFailures} failed in 30d) — contact via alt channel (Email / IG DM)`;
  }
  if (userMessages === 0 && days >= 2) {
    return "RESTART CANDIDATE — never opened the Field, send restart code";
  }
  if (completions === 0 && userMessages > 0) {
    return `Sent ${userMessages} messages but didn't complete Day 1 — check in, help them finish`;
  }
  const nextDay = completions + 1;
  if (nextDay === 1) return "Send Day 1 · Welcome + reminder to open the Field";
  if (nextDay === 2) return "Send Day 2 · Decision & Action";
  if (nextDay === 3) return "Send Day 3 · Frequency + Unlimited";
  if (nextDay === 4) return "Send Day 4 · Bonus Integration";
  if (nextDay === 5) return "Send Day 5 · Aira YES/NO";
  if (days < 7) return "Between Day 5 and Day 7 — check in";
  if (days < 8) return "Send Day 7 · UNLIMITED50 code";
  if (days < 10) return "Send Day 9 · Orientation Call";
  if (days < 12) return "Send Day 11 · Focus check-in";
  if (days < 15) return "Send Day 14 · Final push";
  return "Post-sequence — offer Unlimited or personal check-in";
}

function needsManualOutreach(status) {
  return status === "wa_failed" ||
         status === "never_started" ||
         status === "started_no_complete" ||
         status === "behind";
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const sessionToken = req.headers["x-session-token"];
    const user = await getUserBySessionToken(sessionToken);
    if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const apiKey = process.env.GHL_API_KEY;
    const locationId = process.env.GHL_LOCATION_ID;
    if (!apiKey || !locationId) {
      return res.status(500).json({
        error: "ghl_not_configured",
        message: "GHL_API_KEY and GHL_LOCATION_ID env vars must be set in Vercel.",
      });
    }

    // Fetch US/CAN and UK contacts in parallel via V1 search.
    // GHL's V1 fuzzy query sometimes strips "+" so we search WITHOUT the
    // plus and rely on the post-filter (phone.startsWith) to make sure
    // we only keep real matches. Multiple queries widen the net.
    const [usContacts, ukContacts, ukContactsAlt] = await Promise.all([
      fetchGhlContactsMatchingPhone({ apiKey, phonePrefix: "1" }),
      fetchGhlContactsMatchingPhone({ apiKey, phonePrefix: "44" }),
      fetchGhlContactsMatchingPhone({ apiKey, phonePrefix: "+44" }),
    ]);
    // Merge the two UK queries for downstream logging.
    const ukContactsMerged = [...ukContacts, ...ukContactsAlt];

    // Merge + dedupe by email, post-filter for actual phone prefix match.
    // GHL sometimes stores phones with "+" and sometimes without. Normalize
    // to digits-only for matching so both "+441234..." and "441234..." count.
    const seen = new Set();
    const contacts = [];
    for (const c of [...usContacts, ...ukContactsMerged]) {
      const email = String(c.email || "").toLowerCase().trim();
      const phone = String(c.phone || "").trim();
      if (!email || !phone) continue;
      if (seen.has(email)) continue;
      const digits = phone.replace(/[^0-9]/g, "");
      // UK: starts with 44 and total 11-13 digits (44 + 9-11 digits of number)
      const isUK = digits.startsWith("44") && digits.length >= 11 && digits.length <= 13;
      // US/CAN: 11 digits starting with 1 (country code + 10-digit NANP)
      const isUS = !isUK && digits.startsWith("1") && digits.length === 11;
      if (!isUS && !isUK) continue;
      seen.add(email);
      contacts.push({
        email,
        first_name: c.firstName || c.contactName || "",
        last_name: c.lastName || "",
        phone,
        country: isUK ? "UK" : "USA/CAN",
      });
    }

    if (contacts.length === 0) {
      return res.status(200).json({
        queue: [], count: 0,
        meta: {
          us_can_ghl_contacts: usContacts.length,
          uk_ghl_contacts: ukContactsMerged.length,
          matched_members: 0,
          fetched_at: new Date().toISOString(),
        },
      });
    }

    // Cross-reference with Neon users AND pull Field engagement metrics.
    // We need: total user messages sent to the Field, day completions
    // actually done inside the Field, and last message timestamp. These
    // are the TRUE engagement signals — GHL tags are misleading because
    // they fire on Kajabi lesson-clicks, not Field usage.
    const emails = contacts.map(c => c.email);
    const { rows: users } = await sql`
      SELECT
        LOWER(u.email) AS email,
        u.display_name,
        u.created_at,
        u.tier::text AS tier,
        u.kajabi_entitled,
        GREATEST(EXTRACT(DAY FROM (NOW() - u.created_at))::int, 0) AS days_since_purchase,
        (SELECT COUNT(*)::int FROM messages m
           WHERE m.user_id = u.id AND m.role = 'user') AS user_messages,
        (SELECT COUNT(*)::int FROM messages m
           WHERE m.user_id = u.id) AS total_messages,
        (SELECT MAX(m.created_at) FROM messages m
           WHERE m.user_id = u.id) AS last_message_at,
        (SELECT COUNT(*)::int FROM day_completions dc
           WHERE dc.user_id = u.id) AS completions,
        -- WhatsApp delivery failures in last 30 days (from GHL Workflow
        -- webhook posts to /api/webhooks/ghl-message-status). NULL-safe:
        -- if the table doesn't exist yet or no events recorded, returns 0.
        COALESCE((
          SELECT COUNT(*)::int FROM whatsapp_message_events wme
          WHERE LOWER(wme.contact_email) = LOWER(u.email)
            AND wme.status IN ('failed', 'undelivered', 'error')
            AND wme.event_at > NOW() - INTERVAL '30 days'
        ), 0) AS wa_failures_30d,
        (SELECT wme.event_at FROM whatsapp_message_events wme
          WHERE LOWER(wme.contact_email) = LOWER(u.email)
            AND wme.status IN ('failed', 'undelivered', 'error')
          ORDER BY wme.event_at DESC LIMIT 1) AS last_wa_failure_at,
        (SELECT wme.message_number FROM whatsapp_message_events wme
          WHERE LOWER(wme.contact_email) = LOWER(u.email)
            AND wme.status IN ('failed', 'undelivered', 'error')
          ORDER BY wme.event_at DESC LIMIT 1) AS last_failed_message_num
      FROM users u
      WHERE LOWER(u.email) = ANY(${emails})
        AND u.email NOT LIKE '%@shimritnativ.com'
        AND u.email NOT LIKE '%@masteryourpath.%'
    `;

    const userMap = new Map();
    for (const u of users) userMap.set(u.email, u);

    // Build the queue: only include members who NEED manual outreach based
    // on real Neon activity. On-track members are filtered out.
    const queue = contacts
      .filter(c => userMap.has(c.email))
      .map(c => {
        const u = userMap.get(c.email);
        const params = {
          days: u.days_since_purchase,
          userMessages: u.user_messages,
          completions: u.completions,
          waFailures: u.wa_failures_30d,
        };
        const status = computeStatus(params);
        return {
          email: c.email,
          display_name: u.display_name || `${c.first_name} ${c.last_name}`.trim() || c.email,
          first_name: c.first_name,
          last_name: c.last_name,
          phone: c.phone,
          country: c.country,
          purchased_on: u.created_at,
          days_since_purchase: u.days_since_purchase,
          user_messages: u.user_messages,
          total_messages: u.total_messages,
          last_message_at: u.last_message_at,
          completions: u.completions,
          wa_failures_30d: u.wa_failures_30d,
          last_wa_failure_at: u.last_wa_failure_at,
          last_failed_message_num: u.last_failed_message_num,
          tier: u.tier,
          status,
          next_message: computeNextMessage(params),
        };
      })
      .filter(q => needsManualOutreach(q.status))
      .sort((a, b) => {
        // Sort: wa_failed (confirmed delivery problem) first, then
        // never_started, then everything else by days-since-purchase.
        const priority = { wa_failed: 0, never_started: 1, started_no_complete: 2, behind: 3 };
        const p = (priority[a.status] ?? 9) - (priority[b.status] ?? 9);
        if (p !== 0) return p;
        return b.days_since_purchase - a.days_since_purchase;
      });

    const response = {
      queue,
      count: queue.length,
      meta: {
        us_can_ghl_contacts: usContacts.length,
        uk_ghl_contacts: ukContactsMerged.length,
        contacts_after_filter: contacts.length,
        matched_members: queue.length,
        fetched_at: new Date().toISOString(),
      },
    };

    // ?debug=1 → include raw diagnostic info so we can see why the queue is
    // smaller than expected (phone format mismatch, missing Neon rows, etc.)
    if (req.query && req.query.debug === "1") {
      response.debug = {
        us_ghl_phone_samples: usContacts.slice(0, 8).map(c => ({
          email: c.email, phone: c.phone, firstName: c.firstName || c.contactName,
        })),
        uk_ghl_phone_samples_44: ukContacts.slice(0, 8).map(c => ({
          email: c.email, phone: c.phone, firstName: c.firstName || c.contactName,
        })),
        uk_ghl_phone_samples_plus44: ukContactsAlt.slice(0, 8).map(c => ({
          email: c.email, phone: c.phone, firstName: c.firstName || c.contactName,
        })),
        matched_us_phones: contacts.filter(c => c.country === "USA/CAN").map(c => ({ email: c.email, phone: c.phone })),
        matched_uk_phones: contacts.filter(c => c.country === "UK").map(c => ({ email: c.email, phone: c.phone })),
        all_matched_ghl_emails_count: contacts.length,
        neon_matched_emails_count: users.length,
        us_uk_ghl_emails_missing_from_neon: contacts
          .filter(c => !userMap.has(c.email))
          .slice(0, 30)
          .map(c => ({ email: c.email, phone: c.phone, country: c.country })),
      };
    }

    return res.status(200).json(response);
  } catch (e) {
    console.error("manual_outreach_queue_failed", e);
    return res.status(500).json({
      error: "internal_error",
      message: e && e.message ? e.message : "unknown",
    });
  }
}
