// api/admin/manual-outreach-queue.js
//
// Live "Manual Outreach Queue" for Aira — pulls all GHL contacts with US
// (+1) or UK (+44) phone numbers, cross-references with our Neon users
// table to enrich with purchase date + Reset progress, and returns a
// ranked list of members who likely aren't getting the automated
// WhatsApp sequence (because GHL delivery is unreliable to those regions).
//
// Auth: same @shimritnativ.com session gate as every other admin endpoint.
//
// Env vars required (add via Vercel Settings → Environment Variables):
//   GHL_API_KEY        — Private Integration Token (starts with "pit-")
//   GHL_LOCATION_ID    — GHL sub-account location ID
//
// Response:
//   { queue: [{ email, display_name, phone, country, days_since_purchase,
//               last_completed_day, tier, next_message }], count: N }

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

// Fetch GHL contacts whose phone contains the given prefix. Tries two
// endpoint shapes — POST /contacts/search (modern V2) and GET /contacts/
// (also modern V2 but different query pattern). Some PITs work with one
// and not the other depending on scopes/version. Falls through with the
// detailed error on both failures.
async function searchGhlContactsByPhone({ apiKey, locationId, phonePrefix }) {
  const authHeaders = {
    "Authorization": `Bearer ${apiKey}`,
    "Version": GHL_API_VERSION,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  // Attempt 1: POST /contacts/search
  try {
    const url = `${GHL_API_BASE}/contacts/search`;
    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        locationId,
        pageLimit: 100,
        filters: [
          { field: "phone", operator: "contains", value: phonePrefix }
        ],
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.contacts || [];
    }
    // Save the error for reporting if attempt 2 also fails
    const body1 = await res.text().catch(() => "");
    if (res.status !== 401 && res.status !== 404) {
      throw new Error(`ghl_${res.status} (POST /contacts/search): ${body1.slice(0, 300)}`);
    }
    // Fall through to attempt 2 on 401 or 404
    var errorAttempt1 = `POST /contacts/search → ${res.status}: ${body1.slice(0, 200)}`;
  } catch (e) {
    if (e.message && e.message.startsWith("ghl_")) throw e;
    var errorAttempt1 = `POST /contacts/search → threw: ${e.message}`;
  }

  // Attempt 2: GET /contacts/ with query params
  try {
    const params = new URLSearchParams({
      locationId,
      limit: "100",
      query: phonePrefix,
    });
    const url = `${GHL_API_BASE}/contacts/?${params.toString()}`;
    const res = await fetch(url, {
      method: "GET",
      headers: authHeaders,
    });
    if (res.ok) {
      const data = await res.json();
      return data.contacts || [];
    }
    const body2 = await res.text().catch(() => "");
    throw new Error(
      `ghl_${res.status}: both endpoints failed. ` +
      `Attempt 1: ${errorAttempt1} · ` +
      `Attempt 2 (GET /contacts/): ${body2.slice(0, 200)}`
    );
  } catch (e) {
    if (e.message && e.message.startsWith("ghl_")) throw e;
    throw new Error(`ghl_network: ${e.message}. Attempt 1: ${errorAttempt1}`);
  }
}

// Compute which message a member SHOULD have received by now, based on
// days-since-purchase + whether they ever started (last_completed_day).
// If they bought > 4 days ago and never started, they need the RESTART
// sequence, not the regular next message.
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
    // Auth — same session gate as every other admin endpoint.
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

    // Fetch US/CAN and UK contacts in parallel.
    const [usContacts, ukContacts] = await Promise.all([
      searchGhlContactsByPhone({ apiKey, locationId, phonePrefix: "+1" }),
      searchGhlContactsByPhone({ apiKey, locationId, phonePrefix: "+44" }),
    ]);

    // Merge + dedupe by email (GHL returns duplicates when phone appears
    // in multiple fields). Also post-filter to ensure phone STARTS with
    // the prefix (search uses "contains" which can catch false positives).
    const seen = new Set();
    const contacts = [];
    for (const c of [...usContacts, ...ukContacts]) {
      const email = String(c.email || "").toLowerCase();
      const phone = String(c.phone || "").trim();
      if (!email || !phone) continue;
      if (seen.has(email)) continue;
      // Post-filter for prefix match
      const isUS = phone.startsWith("+1");
      const isUK = phone.startsWith("+44");
      if (!isUS && !isUK) continue;
      seen.add(email);
      contacts.push({
        email,
        first_name: c.firstName || "",
        last_name: c.lastName || "",
        phone,
        country: isUK ? "UK" : "USA/CAN",
      });
    }

    if (contacts.length === 0) {
      return res.status(200).json({ queue: [], count: 0 });
    }

    // Cross-reference with our Neon users table. Only include entitled
    // members who bought in the last 30 days and aren't already Unlimited.
    const emails = contacts.map(c => c.email);
    const { rows: users } = await sql`
      SELECT
        LOWER(u.email) AS email,
        u.display_name,
        u.created_at,
        u.tier::text AS tier,
        u.kajabi_entitled,
        COALESCE(u.last_completed_day, 0)::int AS last_completed_day,
        EXTRACT(DAY FROM (NOW() - u.created_at))::int AS days_since_purchase
      FROM users u
      WHERE LOWER(u.email) = ANY(${emails})
        AND u.kajabi_entitled = true
        AND u.email NOT LIKE '%@shimritnativ.com'
        AND u.email NOT LIKE '%@masteryourpath.%'
        AND (u.tier IS NULL OR u.tier::text != 'full')
        AND u.created_at > NOW() - INTERVAL '30 days'
    `;

    // Build a map for quick lookup, then enrich the GHL contact list.
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

    return res.status(200).json({
      queue,
      count: queue.length,
      meta: {
        us_can_ghl_contacts: usContacts.length,
        uk_ghl_contacts: ukContacts.length,
        matched_members: queue.length,
        fetched_at: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error("manual_outreach_queue_failed", e);
    return res.status(500).json({
      error: "internal_error",
      message: e && e.message ? e.message : "unknown",
    });
  }
}
