// api/webhooks/kajabi.js
// Inbound Kajabi offer webhook. Each Kajabi offer is configured with an
// Activation and a Deactivation webhook URL pointing here. The tier is carried
// in the query string so the handler never has to parse Kajabi's offer naming:
//
//   "The Freedom Intelligence Field - Unlimited"
//     Activation   -> .../api/webhooks/kajabi?secret=XXX&grant=full
//     Deactivation -> .../api/webhooks/kajabi?secret=XXX&revoke=1
//   "The 72-Hour Power Reset"
//     Activation   -> .../api/webhooks/kajabi?secret=XXX&grant=preview
//     Deactivation -> .../api/webhooks/kajabi?secret=XXX&revoke=1
//
// ?secret= must equal KAJABI_WEBHOOK_SECRET. Kajabi offer webhooks are not
// cryptographically signed, so the shared secret in the URL is the gate.

import {
  recordWebhookEvent,
  grantEntitlement,
  revokeEntitlementByEmail,
} from "../../lib/db.js";

// Kajabi's payload shape varies; pull the member email from the common places.
function extractEmail(body) {
  if (!body || typeof body !== "object") return null;
  const candidates = [
    body.email,
    body.member_email,
    body.member && body.member.email,
    body.contact && body.contact.email,
    body.customer && body.customer.email,
    body.data && body.data.email,
    body.payload && body.payload.email,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.trim())) {
      return c.trim().toLowerCase();
    }
  }
  return null;
}

function extractMemberId(body) {
  if (!body || typeof body !== "object") return null;
  const candidates = [
    body.member_id,
    body.member && body.member.id,
    body.contact && body.contact.id,
    body.data && body.data.member_id,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c).trim();
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Auth: shared secret in the query string.
  const secret = process.env.KAJABI_WEBHOOK_SECRET;
  const provided = (req.query && req.query.secret) || "";
  if (!secret || provided !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const body = req.body || {};
  const grant = (req.query && req.query.grant) || "";   // 'full' | 'preview'
  const revoke = !!(req.query && req.query.revoke);
  const email = extractEmail(body);
  const externalId = (body && (body.id || body.event_id)) || null;

  try {
    if (!email) {
      // Log the payload so the real Kajabi field shape can be inspected, then
      // return 200 so Kajabi does not retry a payload we cannot use.
      await recordWebhookEvent({
        source: "kajabi",
        eventType: revoke ? "deactivate" : "activate:" + grant,
        externalId: externalId,
        payload: body,
        signatureVerified: true,
        processingError: "no_email_in_payload",
      });
      return res.status(200).json({ ok: false, note: "no_email_found" });
    }

    let user = null;
    if (revoke) {
      user = await revokeEntitlementByEmail(email);
    } else if (grant === "full" || grant === "preview") {
      user = await grantEntitlement({
        email: email,
        tier: grant,
        kajabiMemberId: extractMemberId(body),
      });
    }

    await recordWebhookEvent({
      source: "kajabi",
      eventType: revoke ? "deactivate" : "activate:" + grant,
      externalId: externalId,
      payload: body,
      signatureVerified: true,
      userId: user ? user.id : null,
      processingError: user ? null : "no_action_taken",
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("kajabi_webhook_error", { message: err?.message });
    // 200 to avoid Kajabi retry storms; the error is in the server logs.
    return res.status(200).json({ ok: false });
  }
}
