// api/admin/ghl-messages-probe.js
//
// Diagnostic: figure out which GHL V1 endpoints expose per-contact
// conversations + messages + delivery status. We test several endpoint
// shapes on ONE known contact (Bernie, +15142923156) so we can see:
//   - Does GHL expose the contact's conversations?
//   - Do messages include a `status` field (delivered/failed)?
//   - What's the exact response shape so we can build the real filter?
//
// Delete this file once we know which endpoint pattern works.

import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";
const GHL_V1_BASE = "https://rest.gohighlevel.com/v1";

async function tryEndpoint({ label, url, apiKey }) {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
    });
    const text = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return {
      label,
      url,
      status: res.status,
      ok: res.ok,
      body_preview: text.slice(0, 1200),
      keys: parsed && typeof parsed === "object" ? Object.keys(parsed) : null,
    };
  } catch (e) {
    return { label, url, status: 0, ok: false, error: e.message };
  }
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
  const locationId = process.env.GHL_LOCATION_ID;
  if (!apiKey) return res.status(500).json({ error: "ghl_not_configured" });

  // Step 1: find Bernie's contactId by phone query
  const findRes = await fetch(`${GHL_V1_BASE}/contacts/?query=15142923156&limit=5`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  const findData = await findRes.json();
  const bernie = (findData.contacts || []).find(c =>
    (c.phone || "").replace(/[^0-9]/g, "").endsWith("5142923156")
  );

  if (!bernie) {
    return res.status(200).json({
      error: "bernie_not_found",
      find_response_keys: Object.keys(findData || {}),
      find_response_sample: JSON.stringify(findData).slice(0, 800),
    });
  }

  const contactId = bernie.id;

  // Step 2: probe multiple message/conversation endpoints
  const tests = await Promise.all([
    tryEndpoint({ label: "GET /v1/contacts/{id}", url: `${GHL_V1_BASE}/contacts/${contactId}`, apiKey }),
    tryEndpoint({ label: "GET /v1/contacts/{id}/conversations", url: `${GHL_V1_BASE}/contacts/${contactId}/conversations`, apiKey }),
    tryEndpoint({ label: "GET /v1/conversations/?contactId={id}", url: `${GHL_V1_BASE}/conversations/?contactId=${contactId}`, apiKey }),
    tryEndpoint({ label: "GET /v1/conversations/?locationId={loc}", url: `${GHL_V1_BASE}/conversations/?locationId=${locationId}&limit=5`, apiKey }),
    tryEndpoint({ label: "GET /v1/contacts/{id}/messages", url: `${GHL_V1_BASE}/contacts/${contactId}/messages`, apiKey }),
    tryEndpoint({ label: "GET /v1/conversations/messages/?contactId={id}", url: `${GHL_V1_BASE}/conversations/messages/?contactId=${contactId}`, apiKey }),
  ]);

  return res.status(200).json({
    contactId,
    contact_summary: {
      email: bernie.email,
      phone: bernie.phone,
      firstName: bernie.firstName,
      lastName: bernie.lastName,
    },
    tests,
    hint: "Find the test with ok:true that returns messages with a `status` field. That endpoint is what we use to detect failed messages. Send me this whole JSON response.",
  });
}
