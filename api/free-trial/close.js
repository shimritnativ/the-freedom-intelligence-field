// api/free-trial/close.js
//
// Optional explicit close for a trial — used when the visitor clicks the
// Reset upsell CTA so we can record the outcome as "clicked_upgrade"
// rather than just letting the trial expire silently.
//
// POST /api/free-trial/close
// Body: { trial_id, outcome? }
//   outcome ∈ { "completed", "clicked_upgrade", "dismissed", "expired" }
// Returns: { ok }

import { sql } from "@vercel/postgres";

const VALID_OUTCOMES = new Set(["completed", "clicked_upgrade", "dismissed", "expired"]);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const trialId = String(body.trial_id || "").trim();
  const outcomeRaw = String(body.outcome || "").trim().toLowerCase();
  const outcome = VALID_OUTCOMES.has(outcomeRaw) ? outcomeRaw : "dismissed";

  if (!trialId) return res.status(400).json({ error: "trial_id_required" });

  try {
    await sql`
      UPDATE free_trials
      SET ended_at = COALESCE(ended_at, NOW()),
          outcome  = COALESCE(outcome, ${outcome})
      WHERE id = ${trialId}::uuid
    `;
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("free_trial_close_failed", e);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
}

/*
==============================================================================
ONE-TIME SQL MIGRATION — run in Neon before hitting any free-trial endpoint.
Idempotent — safe to re-run.
==============================================================================

CREATE TABLE IF NOT EXISTS free_trials (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 TEXT NOT NULL,
  ip                    TEXT,
  cookie_id             TEXT,
  scenario              TEXT NOT NULL,
  exchange_count        INT  NOT NULL DEFAULT 0,
  max_exchanges         INT  NOT NULL DEFAULT 6,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  outcome               TEXT,             -- completed | clicked_upgrade | dismissed | expired
  is_staff_test         BOOLEAN NOT NULL DEFAULT FALSE,
  upgrade_purchased_at  TIMESTAMPTZ       -- set later when a matching purchase lands
);

CREATE INDEX IF NOT EXISTS idx_free_trials_email    ON free_trials (LOWER(email), started_at DESC);
CREATE INDEX IF NOT EXISTS idx_free_trials_cookie   ON free_trials (cookie_id, started_at DESC) WHERE cookie_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_free_trials_ip       ON free_trials (ip, started_at DESC) WHERE ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_free_trials_started  ON free_trials (started_at DESC);

CREATE TABLE IF NOT EXISTS free_trial_messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trial_id              UUID NOT NULL REFERENCES free_trials (id) ON DELETE CASCADE,
  role                  TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content               TEXT NOT NULL,
  exchange_number       INT,
  tokens_in             INT,
  tokens_out            INT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_free_trial_messages_trial
  ON free_trial_messages (trial_id, created_at);
*/
