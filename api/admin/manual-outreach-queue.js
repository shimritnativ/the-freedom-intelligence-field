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

// Compute which message a member SHOULD have received by now.
function computeNextMessage(days, lastCompleted) {
  if (lastCompleted === 0 && days > 4) {
    return "RESTART CANDIDATE — never started, send restart code";
  }
  if (days < 1) return "Message 1 — Day 1 Welcome";
  if (days < 2) return "Message 2 — Day 2 Decision & Action";
  if (days < 3) return "Message 3 — Day 3 Frequency + Unlimited";
  if (days < 4) return "Message 4 — Day 4 Bonus Integration";
  if (days < 5) return "Message 5 — Day 5 Aira YES/NO";
  if (days < 7) return "Between Messages 5 and 6";
  if (days < 8) return "Message 6 — Day 7 UNLIMITED50 code";
  if (days < 9) return "Between Messages 6 and 7";
  if (days < 10) return "Message 7 — Day 9 Orientation Call";
  if (days < 11) return "Between Messages 7 and 8";
  if (days < 12) return "Message 8 — Day 11 Focus check-in";
  if (days < 14) return "Between Messages 8 and 9";
  if (days < 15) return "Message 9 — Day 14 Final push";
  return "Post-sequence — offer Unlimited or restart";
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

    // Cross-reference with Neon users.
    // Show ALL matching members — do NOT filter by tier or recency. Geo
    // wants to see every +1 / +44 member so she can decide who to reach.
    // Only exclude team accounts.
    const emails = contacts.map(c => c.email);
    const { rows: users } = await sql`
      SELECT
        LOWER(u.email) AS email,
        u.display_name,
        u.created_at,
        u.tier::text AS tier,
        u.kajabi_entitled,
        COALESCE(u.last_completed_day, 0)::int AS last_completed_day,
        GREATEST(EXTRACT(DAY FROM (NOW() - u.created_at))::int, 0) AS days_since_purchase
      FROM users u
      WHERE LOWER(u.email) = ANY(${emails})
        AND u.email NOT LIKE '%@shimritnativ.com'
        AND u.email NOT LIKE '%@masteryourpath.%'
    `;

    const userMap = new Map();
    for (const u of users) userMap.set(u.email, u);

    const queue = contacts
      .filter(c => userMap.has(c.email))
      .map(c => {
        const u = userMap.get(c.email);
        return {
          email: c.email,
          display_name: u.display_name || `${c.first_name} ${c.last_name}`.trim() || c.email,
          first_name: c.first_name,
          last_name: c.last_name,
          phone: c.phone,
          country: c.country,
          purchased_on: u.created_at,
          days_since_purchase: u.days_since_purchase,
          last_completed_day: u.last_completed_day,
          tier: u.tier,
          next_message: computeNextMessage(u.days_since_purchase, u.last_completed_day),
        };
      })
      .sort((a, b) => a.days_since_purchase - b.days_since_purchase);

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
