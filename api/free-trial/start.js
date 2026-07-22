// api/free-trial/start.js
//
// Begins a "Free Preview of The Field" session. Captures the visitor's email +
// chosen scenario, checks for prior use (email / IP / cookie in the
// last 30 days), and returns a trial_id + the scenario's opening line
// from the Field.
//
// Dedup removed — this LP is lead capture, not gating. Any email is
// accepted, including repeats. is_staff_test still gets flagged on
// @shimritnativ.com and @masteryourpath.com submissions so we can
// filter them out of analytics + skip the Zapier webhook.
//
// POST /api/free-trial/start
// Body: { email, first_name, last_name, consent, scenario, cookie_id? }
// Returns: { trial_id, opening, exchanges_remaining, expires_at }

import { sql } from "@vercel/postgres";
import { FREE_TRIAL_SCENARIOS, FREE_TRIAL_MAX_EXCHANGES } from "../../lib/prompts/free-trial.js";

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
    // Dedup removed 2026-07-22 — the goal for this LP is lead capture,
    // not gating. Any email is accepted, including repeats. Every submit
    // still creates a fresh trial row + fires the Zapier webhook so
    // returning visitors don't miss the GHL nurture.
    //
    // The previous dedup query also had a @vercel/postgres syntax bug
    // (nested sql`` fragments were interpolating as parameters, causing
    // "syntax error at or near \"$2\"" on any submit). Removing the
    // query altogether resolves it.

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
    // Log the webhook decision so it's visible in Vercel Runtime Logs.
    // Lets Geo diagnose "why didn't Zapier fire?" without adding console
    // logs in a hurry every time.
    if (!process.env.ZAPIER_TRY_OPTIN_WEBHOOK) {
      console.log("zapier_skip_no_env_var", { email });
    } else if (staff) {
      console.log("zapier_skip_staff_email", { email });
    } else {
      console.log("zapier_firing", { email, first_name: firstName });
    }
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
      // AWAIT the fetch — critical on Vercel serverless. Fire-and-forget
      // fetch() often never actually goes out because Vercel freezes the
      // container the moment the function returns. Awaiting adds ~300ms
      // of latency to the chat start but guarantees the webhook is
      // actually delivered to Zapier. Wrapped in try/catch so a Zapier
      // 5xx doesn't break the chat.
      try {
        const zapRes = await fetch(process.env.ZAPIER_TRY_OPTIN_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        console.log("zapier_response", { status: zapRes.status, ok: zapRes.ok });
      } catch (err) {
        console.warn("zapier_try_optin_webhook_failed", { message: err?.message });
      }
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
