// api/admin/ghl-test.js
//
// Diagnostic endpoint. Tries three different GHL API calls with the
// configured PIT + location ID, and reports which ones succeed vs fail
// and why. Use this to pin down auth issues before wiring up bigger
// features. Delete after debugging is complete.

import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const GHL_API_BASE = "https://services.leadconnectorhq.com";

async function tryEndpoint({ url, method, body, apiKey, version, label }) {
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Version": version,
    "Accept": "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return {
      label,
      url,
      method,
      status: res.status,
      ok: res.ok,
      body_preview: text.slice(0, 400),
      parsed_error_message: parsed && parsed.message ? parsed.message : null,
      contact_count: parsed && parsed.contacts ? parsed.contacts.length : null,
    };
  } catch (e) {
    return { label, url, method, status: 0, ok: false, network_error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Auth
  const sessionToken = req.headers["x-session-token"];
  const user = await getUserBySessionToken(sessionToken);
  if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const apiKey = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!apiKey || !locationId) {
    return res.status(500).json({ error: "ghl_not_configured" });
  }

  // Mask token for the response so we can visually confirm it looks right
  const tokenPreview = apiKey.length > 12
    ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`
    : "TOO_SHORT";

  const tests = [];

  // Test 1: get the location (simplest possible auth check)
  tests.push(await tryEndpoint({
    label: "GET /locations/{id}",
    method: "GET",
    url: `${GHL_API_BASE}/locations/${locationId}`,
    apiKey,
    version: "2021-07-28",
  }));

  // Test 2: POST /contacts/search
  tests.push(await tryEndpoint({
    label: "POST /contacts/search",
    method: "POST",
    url: `${GHL_API_BASE}/contacts/search`,
    body: { locationId, pageLimit: 1 },
    apiKey,
    version: "2021-07-28",
  }));

  // Test 3: GET /contacts/ with query params
  tests.push(await tryEndpoint({
    label: "GET /contacts/",
    method: "GET",
    url: `${GHL_API_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}&limit=1`,
    apiKey,
    version: "2021-07-28",
  }));

  // Test 4: same as test 2 but with older Version header
  tests.push(await tryEndpoint({
    label: "POST /contacts/search (Version 2021-04-15)",
    method: "POST",
    url: `${GHL_API_BASE}/contacts/search`,
    body: { locationId, pageLimit: 1 },
    apiKey,
    version: "2021-04-15",
  }));

  return res.status(200).json({
    token_preview: tokenPreview,
    token_length: apiKey.length,
    location_id: locationId,
    tests,
    hint: "Look at which test succeeded (ok: true). That endpoint is what we should use. Send me the JSON of this whole response.",
  });
}
