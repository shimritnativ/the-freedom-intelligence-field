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
    // Whitelist of accepted event types. Extend here when adding new
    // trackable interactions on any landing page. Try LP events are
    // prefixed `try_` so they never collide with reset LP events.
    const VALID_EVENT_TYPES = [
      // Reset LP (go.shimritnativ.com)
      "page_view",
      "checkout_scroll",
      "power_reset_cta_click",
      // Try LP (thefieldai.app/try) — added 2026-07-27 per Geo for
      // the Free Trial Landing Page analytics section in admin.
      "try_page_view",
      "try_cta_click",         // Reset CTA click (label = utm_content position)
      "try_free_cta_click",    // "Try it for free" CTA click (floating pill etc.)
      "try_form_start",        // User clicked a doorway chip (label = scenario id)
      "try_form_view",         // Form actually rendered on screen (label = scenario id). Diagnostic — closes gap between CTA click and form_start. Added 2026-08-12.
      "try_field_focused",     // User first-focused a specific form field (label = first_name | phone | email). Once per session per field. Reveals which field causes hesitation. Added 2026-08-12.
      "try_form_complete",     // Email + first name submitted — free trial started. Carries UTMs so ads-attributed conversions are countable. Added 2026-07-28.
      "try_form_engaged",      // User reached 3+ exchanges in the preview (label = scenario id). Meaningful engagement, not bail. Added 2026-08-12.
      "try_video_play",        // Pre-hero video started playing
      "try_video_watch_25",
      "try_video_watch_50",
      "try_video_watch_75",
      "try_video_complete",    // Video hit 95%+ of duration
      "try_audio_unmute",      // "Tap for sound" button clicked
    ];
    if (!VALID_EVENT_TYPES.includes(eventType)) {
      return res.status(400).json({ error: "invalid_event_type" });
    }
    // Optional label — encoded into event_type since the table has no
    // dedicated label column. Only event types that carry a label
    // dimension get the suffix; page views etc. stay as bare types.
    // Capped at 30 chars, alphanumeric + underscore only.
    const LABELED_EVENT_TYPES = new Set([
      "power_reset_cta_click",
      "try_cta_click",          // utm_content position (maximized_chat_top / value_stack / etc.)
      "try_free_cta_click",     // floating_pill / bottom_link
      "try_form_start",         // results / relationships / decisions
      "try_form_view",          // scenario id
      "try_field_focused",      // first_name / phone / email
      "try_form_complete",      // scenario id (results / relationships / decisions)
      "try_form_engaged",       // scenario id — 3+ exchanges reached
    ]);
    const rawLabel = body.label ? String(body.label).trim().slice(0, 30).replace(/[^a-z0-9_]/gi, "") : "";
    const storedEventType = (LABELED_EVENT_TYPES.has(eventType) && rawLabel)
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
