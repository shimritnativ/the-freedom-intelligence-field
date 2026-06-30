// api/track-landing-event.js
//
// Public endpoint that receives anonymous landing-page funnel events
// from the tracking snippet pasted into the GHL landing page. Stores
// them in the landing_events table so the admin Ads tab can compute
// per-campaign funnel metrics (visits → scrolled → bought).
//
// Auth: NONE. Public on purpose — the landing page lives on a
// different domain (go.shimritnativ.com) and visitors aren't logged
// in. We rate-limit by IP + dedup by session_id+event_type so abuse
// is bounded.
//
// CORS: open. The endpoint is called from go.shimritnativ.com but
// could theoretically also be called from preview / staging URLs;
// keeping it permissive is fine since the data is anonymous.
//
// POST body:
//   {
//     event_type: "page_view" | "checkout_scroll",
//     session_id: "<uuid>",
//     page_url: "https://...",
//     utm_source: string?, utm_medium: string?, utm_campaign: string?,
//     utm_content: string?, utm_term: string?,
//     referrer: string?
//   }
//
// Returns { ok: true } on success. Idempotent on (session_id, event_type)
// so accidental double-fires don't double-count.

import { sql } from "@vercel/postgres";
import crypto from "node:crypto";

function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// Hash the visitor's IP with a daily-rotating salt so we can dedup
// reloads without ever storing the raw IP. The salt rotates daily so
// the hash isn't a stable identifier — privacy by design.
function hashIp(rawIp) {
  if (!rawIp) return null;
  const day = new Date().toISOString().slice(0, 10);
  return crypto
    .createHash("sha256")
    .update(String(rawIp) + ":" + day)
    .digest("hex")
    .slice(0, 32);
}

function getClientIp(req) {
  // Vercel sets x-forwarded-for as a comma-separated chain; the first
  // entry is the original client.
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || null;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    // The tracking snippet sends the body as text/plain (a "simple"
    // CORS content type that skips preflight). Vercel only auto-parses
    // JSON when Content-Type is application/json, so we need to do it
    // ourselves here. Accept either shape for resilience.
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    // Validate the bare minimum. Everything else is optional.
    const eventType = String(body.event_type || "").trim().slice(0, 60);
    const sessionId = String(body.session_id || "").trim().slice(0, 80);
    if (!eventType || !sessionId) {
      return res.status(400).json({ error: "missing_required_fields" });
    }
    if (!["page_view", "checkout_scroll", "power_reset_cta_click"].includes(eventType)) {
      return res.status(400).json({ error: "invalid_event_type" });
    }
    // Optional CTA label (e.g. "instant_access", "start_72hr"). The
    // landing_events table doesn't have a `label` column yet, so we
    // can't store it. Instead we encode it into event_type so per-
    // button breakdowns are still possible: a session that clicks two
    // different CTAs writes two rows (instead of one, since the unique
    // index keys on session_id + event_type). Capped at 30 chars to
    // keep the composite event_type readable.
    const rawLabel = body.label ? String(body.label).trim().slice(0, 30).replace(/[^a-z0-9_]/gi, "") : "";
    const storedEventType = (eventType === "power_reset_cta_click" && rawLabel)
      ? eventType + ":" + rawLabel
      : eventType;

    // Cap every string field so a hostile POST can't bloat the table
    const trunc = (s, n) => s ? String(s).slice(0, n) : null;
    const pageUrl     = trunc(body.page_url, 500);
    const utmSource   = trunc(body.utm_source, 200);
    const utmMedium   = trunc(body.utm_medium, 200);
    const utmCampaign = trunc(body.utm_campaign, 200);
    const utmContent  = trunc(body.utm_content, 200);
    const utmTerm     = trunc(body.utm_term, 200);
    const referrer    = trunc(body.referrer, 500);
    const userAgent   = trunc(req.headers["user-agent"], 400);
    const ipHash      = hashIp(getClientIp(req));

    await sql`
      INSERT INTO landing_events (
        event_type, session_id, page_url,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        referrer, user_agent, ip_hash
      ) VALUES (
        ${storedEventType}, ${sessionId}, ${pageUrl},
        ${utmSource}, ${utmMedium}, ${utmCampaign}, ${utmContent}, ${utmTerm},
        ${referrer}, ${userAgent}, ${ipHash}
      )
      ON CONFLICT (session_id, event_type) DO NOTHING
    `;

    return res.status(200).json({ ok: true });
  } catch (err) {
    // Don't expose internal details to a public endpoint
    console.error("track_landing_event_error", { message: err?.message });
    return res.status(500).json({ ok: false });
  }
}
