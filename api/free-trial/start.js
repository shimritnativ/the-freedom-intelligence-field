// api/free-trial/start.js
//
// Begins a "5-Minute Preview" session. Captures the visitor's email +
// chosen scenario, checks for prior use (email / IP / cookie in the
// last 30 days), and returns a trial_id + the scenario's opening line
// from the Field.
//
// Dedup rules — one free trial per person per 30 days:
//   - Email match (case-insensitive, exact after normalisation)
//   - IP match (best-effort — behind Cloudflare/Vercel edge this is the
//     origin IP, not perfect for shared networks but good enough)
//   - Cookie ID match (client-supplied; primary signal on the same device)
//
// Test-mode bypass: any @shimritnativ.com or @masteryourpath.com email
// skips dedup so Shimrit can test the flow repeatedly.
//
// POST /api/free-trial/start
// Body: { email, scenario, cookie_id? }
// Returns: { trial_id, opening, exchanges_remaining, expires_at }

import { sql } from "@vercel/postgres";
import { FREE_TRIAL_SCENARIOS, FREE_TRIAL_MAX_EXCHANGES } from "../../lib/prompts/free-trial.js";

const DEDUP_WINDOW_DAYS = 30;
const SESSION_MINUTES = 15;
const STAFF_DOMAINS = ["@shimritnativ.com", "@masteryourpath.com"];

function getClientIp(req) {
  // Vercel-provided headers
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || null;
}

function isStaffEmail(email) {
  const lc = String(email || "").toLowerCase();
  return STAFF_DOMAINS.some((d) => lc.endsWith(d));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const emailRaw = String(body.email || "").trim();
  const email = emailRaw.toLowerCase();
  const firstName = String(body.first_name || "").trim().slice(0, 80);
  const lastName = String(body.last_name || "").trim().slice(0, 80);
  const consent = body.consent === true || body.consent === "true";
  const scenarioId = String(body.scenario || "").trim().toLowerCase();
  const cookieId = String(body.cookie_id || "").trim().slice(0, 128) || null;

  if (!email || !email.includes("@") || email.length > 320) {
    return res.status(400).json({ error: "invalid_email" });
  }
  if (!firstName) {
    return res.status(400).json({ error: "first_name_required" });
  }
  if (!consent) {
    return res.status(400).json({ error: "consent_required" });
  }
  const scenario = FREE_TRIAL_SCENARIOS[scenarioId];
  if (!scenario) {
    return res.status(400).json({ error: "invalid_scenario", valid: Object.keys(FREE_TRIAL_SCENARIOS) });
  }

  const staff = isStaffEmail(email);
  const ip = getClientIp(req);

  try {
    // Dedup check (skipped for staff emails so Shimrit can test).
    if (!staff) {
      const { rows: existing } = await sql`
        SELECT id, scenario, started_at
        FROM free_trials
        WHERE (
              LOWER(email) = ${email}
              ${cookieId ? sql`OR cookie_id = ${cookieId}` : sql``}
              ${ip ? sql`OR ip = ${ip}` : sql``}
            )
          AND started_at > NOW() - (${DEDUP_WINDOW_DAYS}::text || ' days')::interval
        ORDER BY started_at DESC
        LIMIT 1
      `;
      if (existing.length > 0) {
        return res.status(200).json({
          ok: false,
          reason: "already_used",
          message: "You've already taken the 5-Minute Preview. The next step is the full 72-Hour Reset — that's where the real work begins.",
          reset_link: "https://masteryourpath.thrivecart.com/power-reset-ads",
        });
      }
    }

    // Create the trial. exchange_count starts at 0 (the opening from the
    // Field isn't counted as one of the 6 — the first exchange is the
    // person's FIRST reply after seeing the opening).
    const expiresAt = new Date(Date.now() + SESSION_MINUTES * 60 * 1000).toISOString();
    const { rows: created } = await sql`
      INSERT INTO free_trials (
        email, ip, cookie_id, scenario,
        exchange_count, max_exchanges, expires_at,
        is_staff_test
      ) VALUES (
        ${email}, ${ip}, ${cookieId}, ${scenarioId},
        0, ${FREE_TRIAL_MAX_EXCHANGES}, ${expiresAt}::timestamptz,
        ${staff}
      )
      RETURNING id, expires_at
    `;
    const trial = created[0];

    // Log the opening as an assistant message so the transcript is complete.
    await sql`
      INSERT INTO free_trial_messages (trial_id, role, content, exchange_number)
      VALUES (${trial.id}, 'assistant', ${scenario.opening}, 0)
    `;

    // Fire the Zapier webhook so this opt-in becomes a GHL contact with
    // the "try-preview" tag. Fire-and-forget: we don't await the
    // response, so even if Zapier is slow or the webhook 5xxs, the
    // chat still starts instantly. Zapier URL comes from env so it can
    // be rotated without a redeploy.
    if (process.env.ZAPIER_TRY_OPTIN_WEBHOOK && !staff) {
      const payload = {
        email,
        first_name: firstName,
        last_name: lastName || null,
        scenario: scenario.id,
        scenario_label: scenario.label,
        consent_given_at: new Date().toISOString(),
        source: "try_preview_lp",
        ip,
      };
      fetch(process.env.ZAPIER_TRY_OPTIN_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch((err) => {
        console.warn("zapier_try_optin_webhook_failed", { message: err?.message });
      });
    }

    return res.status(200).json({
      ok: true,
      trial_id: trial.id,
      scenario: scenario.id,
      scenario_label: scenario.label,
      opening: scenario.opening,
      exchanges_remaining: FREE_TRIAL_MAX_EXCHANGES,
      expires_at: trial.expires_at,
      is_staff_test: staff,
    });
  } catch (e) {
    console.error("free_trial_start_failed", e);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
}
