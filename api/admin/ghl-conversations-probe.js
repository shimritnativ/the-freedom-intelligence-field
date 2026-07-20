// api/admin/ghl-conversations-probe.js
//
// Test whether we can pull a contact's full conversation history from
// GHL. Tries both the V1 and V2 API surfaces because they have different
// endpoints and different auth. This runs against ONE contact ID (passed
// in the query string) so we can see live results before writing a bulk
// exporter.
//
// Usage:
//   GET /api/admin/ghl-conversations-probe?contact_id=iD2LW7YnJCQbwP8vB2Zz
//
// Returns a JSON report with:
//   - which endpoints returned 200 vs 401/404
//   - a preview of each response body
//   - if messages came back: how many, plus a sample
//
// Auth: @shimritnativ.com session, same as every admin endpoint.
//
// After we know which endpoint works, we can decide whether to build a
// bulk exporter that loops over every Field member.

import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const V1_BASE = "https://rest.gohighlevel.com/v1";
const V2_BASE = "https://services.leadconnectorhq.com";

async function tryEndpoint({ label, url, headers }) {
  try {
    const res = await fetch(url, { method: "GET", headers });
    const text = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const preview = text.slice(0, 1500);

    // If parsed and has an array field, count it so we can see if this
    // actually returned messages / conversations.
    let arrayCounts = null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      arrayCounts = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) arrayCounts[k] = v.length;
      }
    }

    return {
      label,
      url,
      status: res.status,
      ok: res.ok,
      response_keys: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : null,
      array_counts: arrayCounts,
      body_preview: preview,
    };
  } catch (e) {
    return { label, url, status: 0, ok: false, error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Auth.
  const sessionToken = req.headers["x-session-token"];
  const user = await getUserBySessionToken(sessionToken);
  if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const contactId = String(req.query.contact_id || "").trim();
  if (!contactId) {
    return res.status(400).json({ error: "contact_id_required" });
  }

  // Credentials — V1 API key is the one already set up. V2 Private
  // Integration Token is a separate env var Geo would add IF V1 doesn't
  // work for conversations. We test both paths and report which succeeds.
  const v1Key = process.env.GHL_API_KEY;
  const v2Token = process.env.GHL_V2_TOKEN; // may be undefined
  const locationId = process.env.GHL_LOCATION_ID || "eo4N6ugBtPJTQE4clj7A";

  const v1Headers = v1Key
    ? { Authorization: `Bearer ${v1Key}`, Accept: "application/json" }
    : null;
  // GHL now uses "v3" as the Version header for the current API surface
  // (previously they used date strings like 2021-07-28 and 2021-04-15,
  // both retired). Scopes are namespaced by version, so sending the wrong
  // Version can mask a token that IS authorized as "The token is not
  // authorized for this scope" — that's what we saw on the first attempts.
  const v2Headers = v2Token
    ? {
        Authorization: `Bearer ${v2Token}`,
        Version: "v3",
        Accept: "application/json",
      }
    : null;

  const tests = [];

  // ── V1 attempts ────────────────────────────────────────────────────
  if (v1Headers) {
    tests.push(
      tryEndpoint({
        label: "V1 · GET /contacts/{id}",
        url: `${V1_BASE}/contacts/${encodeURIComponent(contactId)}`,
        headers: v1Headers,
      }),
      tryEndpoint({
        label: "V1 · GET /contacts/{id}/conversations",
        url: `${V1_BASE}/contacts/${encodeURIComponent(contactId)}/conversations`,
        headers: v1Headers,
      }),
      tryEndpoint({
        label: "V1 · GET /conversations/?contactId=",
        url: `${V1_BASE}/conversations/?contactId=${encodeURIComponent(contactId)}`,
        headers: v1Headers,
      }),
      tryEndpoint({
        label: "V1 · GET /contacts/{id}/messages",
        url: `${V1_BASE}/contacts/${encodeURIComponent(contactId)}/messages`,
        headers: v1Headers,
      }),
    );
  } else {
    tests.push({ label: "V1", status: 0, ok: false, error: "GHL_API_KEY not set" });
  }

  // ── V2 attempts ────────────────────────────────────────────────────
  if (v2Headers) {
    tests.push(
      // Basic sanity: does the token authenticate at all? This endpoint
      // should work with almost any scope granted. If it 401s, the
      // problem is the token itself, not the scopes on individual
      // resources.
      tryEndpoint({
        label: "V2 · GET /locations/{locationId}",
        url: `${V2_BASE}/locations/${encodeURIComponent(locationId)}`,
        headers: v2Headers,
      }),
      tryEndpoint({
        label: "V2 · GET /conversations/search",
        url: `${V2_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}`,
        headers: v2Headers,
      }),
      tryEndpoint({
        label: "V2 · GET /contacts/{id}",
        url: `${V2_BASE}/contacts/${encodeURIComponent(contactId)}`,
        headers: v2Headers,
      }),
    );
  } else {
    tests.push({
      label: "V2",
      status: 0,
      ok: false,
      error: "GHL_V2_TOKEN not set — add a Private Integration Token as GHL_V2_TOKEN env var in Vercel to test V2",
    });
  }

  const results = await Promise.all(
    tests.map((t) => (t && typeof t.then === "function" ? t : Promise.resolve(t)))
  );

  // If any V2 conversation search succeeded, try fetching messages for
  // the first conversation to see the actual message payload shape.
  let firstConvSample = null;
  const conversationSearch = results.find(
    (r) => r && r.label === "V2 · GET /conversations/search" && r.ok
  );
  if (conversationSearch && v2Headers) {
    try {
      const raw = conversationSearch.body_preview;
      // Try to parse the preview to extract the first conversation id.
      let firstConvId = null;
      try {
        const parsed = JSON.parse(raw);
        const list = parsed.conversations || parsed.data || parsed.items || [];
        if (list.length > 0) firstConvId = list[0].id || list[0].conversationId;
      } catch {}
      if (firstConvId) {
        firstConvSample = await tryEndpoint({
          label: "V2 · GET /conversations/{id}/messages",
          url: `${V2_BASE}/conversations/${encodeURIComponent(firstConvId)}/messages`,
          headers: v2Headers,
        });
      }
    } catch (e) {
      firstConvSample = { error: e.message };
    }
  }

  return res.status(200).json({
    contact_id: contactId,
    location_id: locationId,
    creds: {
      v1_key_present: !!v1Key,
      v2_token_present: !!v2Token,
    },
    tests: results,
    first_conversation_messages: firstConvSample,
    next_step:
      "Look for an endpoint with ok:true whose body_preview contains actual message text. If V2 endpoints all show 'GHL_V2_TOKEN not set', add a Private Integration Token from GHL Settings → API Keys as GHL_V2_TOKEN in Vercel and re-run.",
  });
}
