// api/webhooks/ghl-message-status.js
//
// Receives WhatsApp (and other channel) message delivery events from a GHL
// Workflow. GHL's public API doesn't expose message delivery status per
// contact (V1 has no conversations endpoint, V2 requires a Conversations
// scope our PIT can't get), so we own this data ourselves by having GHL
// POST to us whenever a message is sent/delivered/failed.
//
// GHL setup on Geo's side:
//   1. In each WhatsApp workflow (Power Reset, Bonus, etc.):
//      After each "Send WhatsApp" step, add a "Send Webhook" (or "Custom
//      Webhook") action with:
//        - URL: https://thefieldai.app/api/webhooks/ghl-message-status
//        - Method: POST
//        - Payload (any of the accepted field names):
//            email                  — contact email (REQUIRED to match to member)
//            contact_id             — GHL contact ID (helpful for lookup)
//            status                 — sent / delivered / failed / undelivered
//            message_number         — which message in the sequence (Day 1..9)
//            workflow_name          — which workflow (Power Reset, Bonus, etc.)
//            message_preview        — first ~200 chars of the message body
//   2. In the same workflow, add an "if failed" branch that posts the same
//      webhook with status=failed. That's what powers the "member isn't
//      receiving messages" flag in the admin outreach queue.
//
// The endpoint is deliberately lenient — accepts any JSON shape and stores
// the raw payload so we can fix parsing later without losing data.

import { sql } from "@vercel/postgres";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // GHL sends JSON. Vercel's body parsing is automatic.
  const body = req.body || {};

  // Accept several field name variants so Geo can wire up whatever the GHL
  // UI gives her without us being picky about naming.
  const email = String(
    body.email ||
    body.contact_email ||
    (body.contact && body.contact.email) ||
    ""
  ).toLowerCase().trim();

  const ghlContactId = String(
    body.contact_id ||
    body.ghl_contact_id ||
    (body.contact && body.contact.id) ||
    ""
  ).trim() || null;

  const messageId = String(
    body.message_id ||
    body.ghl_message_id ||
    body.provider_message_id ||
    ""
  ).trim() || null;

  const status = String(
    body.status ||
    body.message_status ||
    body.delivery_status ||
    "unknown"
  ).toLowerCase().trim();

  const messageNumber = String(
    body.message_number ||
    body.message_num ||
    body.day ||
    body.day_number ||
    ""
  ).trim() || null;

  const workflowId = String(
    body.workflow_id ||
    (body.workflow && body.workflow.id) ||
    ""
  ).trim() || null;

  const workflowName = String(
    body.workflow_name ||
    (body.workflow && body.workflow.name) ||
    ""
  ).trim() || null;

  const messagePreview = String(
    body.message_preview ||
    body.message_body ||
    body.message ||
    ""
  ).slice(0, 500) || null;

  const channel = String(
    body.channel ||
    "WhatsApp"
  ).trim();

  if (!email && !ghlContactId) {
    return res.status(400).json({
      error: "contact_required",
      message: "Payload must include email or contact_id so we can map the event to a member.",
    });
  }

  try {
    await sql`
      INSERT INTO whatsapp_message_events (
        contact_email, ghl_contact_id, ghl_message_id,
        status, channel, message_number,
        workflow_id, workflow_name, message_preview,
        raw_payload
      ) VALUES (
        ${email || null}, ${ghlContactId}, ${messageId},
        ${status}, ${channel}, ${messageNumber},
        ${workflowId}, ${workflowName}, ${messagePreview},
        ${JSON.stringify(body)}::jsonb
      )
    `;
    return res.status(200).json({
      ok: true,
      recorded: { email, status, channel, message_number: messageNumber },
    });
  } catch (e) {
    console.error("wa_event_insert_failed", { email, status, error: e.message });
    return res.status(500).json({ error: "insert_failed", message: e.message });
  }
}

/*
==============================================================================
ONE-TIME SQL MIGRATION — run in Neon SQL editor before activating the GHL
webhook. Idempotent — safe to re-run.
==============================================================================

CREATE TABLE IF NOT EXISTS whatsapp_message_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_email TEXT,
  ghl_contact_id TEXT,
  ghl_message_id TEXT,
  status TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'WhatsApp',
  message_number TEXT,
  workflow_id TEXT,
  workflow_name TEXT,
  message_preview TEXT,
  raw_payload JSONB,
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_events_email
  ON whatsapp_message_events (LOWER(contact_email));
CREATE INDEX IF NOT EXISTS idx_wa_events_status_time
  ON whatsapp_message_events (status, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_events_ghl_contact
  ON whatsapp_message_events (ghl_contact_id);
*/
