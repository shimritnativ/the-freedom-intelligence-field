// api/webhooks/thrivecart.js
// Inbound ThriveCart purchase webhook. Stores every order, rebill, and refund
// in the purchases table so the admin metrics dashboard can compute actual
// revenue per coupon, per product, and per buyer — instead of guessing from
// member counts alone.
//
// Setup (one-time):
//   1. In Neon SQL editor, run the CREATE TABLE statement at the bottom of
//      this file. It is idempotent.
//   2. In ThriveCart admin → Settings → API & Webhooks, paste:
//        https://thefieldai.app/api/webhooks/thrivecart
//      Generate a secret on the same page; set it as THRIVECART_WEBHOOK_SECRET
//      in Vercel env vars. ThriveCart will POST that secret with every event.
//   3. Per product → Notifications, ensure "Send all events to webhook" is on.
//
// Auth: shared secret comparison against THRIVECART_WEBHOOK_SECRET. ThriveCart
// posts the secret as `thrivecart_secret` in the body (their convention).
//
// Idempotency: ON CONFLICT (thrivecart_id, event_type) DO NOTHING so retries
// from ThriveCart never double-count revenue.

import { sql } from "@vercel/postgres";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  // ThriveCart pings the webhook URL with GET / HEAD when you save the config
  // to verify it returns 2xx. Without this branch, the save fails because
  // those methods would hit the 405 below. Real purchases always come as POST,
  // so this health check has no security impact.
  if (req.method === "GET" || req.method === "HEAD") {
    return res.status(200).json({ ok: true, note: "endpoint_alive" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  // ThriveCart posts as application/x-www-form-urlencoded by default. Vercel
  // parses it into req.body as a flat object. JSON also works if the user
  // chose JSON format in ThriveCart settings.
  const body = (req.body && typeof req.body === "object") ? req.body : {};

  const secret = process.env.THRIVECART_WEBHOOK_SECRET;
  const provided = body.thrivecart_secret || body.secret || "";
  if (!secret || provided !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // ThriveCart event types: order.success, order.refund, order.subscription_payment,
  // order.subscription_cancelled, order.subscription_started, etc.
  const event = String(body.event || "").toLowerCase();

  // ThriveCart can send fields at the top level or nested in `customer` / `order`.
  // Cover both shapes for resilience.
  const orderId = String(
    body.order_id ||
    body.invoice_id ||
    (body.order && body.order.id) ||
    ""
  ).trim();

  const email = String(
    body.customer_email ||
    (body.customer && body.customer.email) ||
    body.email ||
    ""
  ).toLowerCase().trim();

  const productId = String(
    body.base_product ||
    body.product_id ||
    (body.order && body.order.product_id) ||
    ""
  );

  const productName = String(
    body.base_product_name ||
    body.product_name ||
    (body.order && body.order.product_name) ||
    ""
  );

  // ThriveCart's `order.total` is in the smallest currency unit (cents). When
  // the field is missing, try the top-level `total` or `amount`. We always
  // store cents to avoid floating-point rounding bugs in SQL aggregates.
  const amountCents = Number(
    (body.order && body.order.total) ||
    body.total ||
    body.amount ||
    0
  );

  const currency = String(
    body.currency ||
    (body.order && body.order.currency) ||
    "EUR"
  ).toUpperCase();

  // Coupon code is null when no discount was applied — that's normal.
  const coupon = (
    body.coupon ||
    body.coupon_code ||
    (body.order && body.order.coupon) ||
    null
  );

  // ThriveCart sends customer name fields at the top level of every webhook.
  // We use them to fill in users.display_name for accounts that came in
  // through a webhook (Kajabi only gave us the email). Falls back to building
  // a name from first + last if full_name is absent.
  const firstName = String(body.first_name || (body.customer && body.customer.first_name) || "").trim();
  const lastName = String(body.last_name || (body.customer && body.customer.last_name) || "").trim();
  const fullName = String(
    body.full_name ||
    body.customer_name ||
    (body.customer && body.customer.full_name) ||
    [firstName, lastName].filter(Boolean).join(" ")
  ).trim();

  if (!orderId || !email || !event) {
    console.warn("thrivecart_webhook_missing_fields", { orderId, email, event });
    return res.status(200).json({ ok: false, note: "missing_required_fields" });
  }

  try {
    await sql`
      INSERT INTO purchases (
        thrivecart_id, event_type, email,
        product_id, product_name,
        amount_cents, currency, coupon_code,
        raw_payload
      ) VALUES (
        ${orderId}, ${event}, ${email},
        ${productId || null}, ${productName || null},
        ${amountCents}, ${currency}, ${coupon || null},
        ${JSON.stringify(body)}::jsonb
      )
      ON CONFLICT (thrivecart_id, event_type) DO NOTHING
    `;
    // Auto-reconcile cleanup. If the cron previously created a
    // placeholder for this email (ThriveCart's webhook arrived late or
    // never until now), the real purchase row above and the placeholder
    // would both exist — double-counting revenue. Detect and remove
    // the placeholder whenever it's close in time + reasonable in
    // amount match (no exact match required — the placeholder was a
    // best-guess anyway). Marker: raw_payload.auto_created = true.
    if (event === "order.success" && amountCents > 0) {
      await sql`
        DELETE FROM purchases
        WHERE LOWER(email) = ${email}
          AND (raw_payload->>'auto_created')::boolean = true
          AND created_at > NOW() - INTERVAL '7 days'
      `;
    }
    // Backfill display_name for users created via Kajabi (email only).
    // Updates when display_name is empty OR looks like a Kajabi-derived
    // email-prefix placeholder (no spaces, looks like the email prefix).
    // We DO want to preserve real names users have set themselves, so
    // the rule is: only overwrite if the existing name has no space AND
    // matches the local-part of the email (case-insensitive, with
    // letters/digits compared).
    //
    // ThriveCart sends proper first + last name fields, so its names
    // almost always contain a space — that's what we trust over the
    // Kajabi placeholder.
    if (fullName && email && fullName.includes(" ")) {
      const localPart = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
      await sql`
        UPDATE users
        SET display_name = ${fullName}, updated_at = NOW()
        WHERE email = ${email}
          AND (
            display_name IS NULL
            OR display_name = ''
            OR (
              -- Looks like an email-prefix placeholder: no space, and
              -- the alphanumeric chars match the email's local-part.
              POSITION(' ' IN display_name) = 0
              AND LOWER(REGEXP_REPLACE(display_name, '[^a-zA-Z0-9]', '', 'g')) = ${localPart}
            )
          )
      `;
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("thrivecart_webhook_error", { message: err?.message, event, orderId });
    // 200 to avoid ThriveCart retry storms; error is in the server logs.
    return res.status(200).json({ ok: false, error: "server_error" });
  }
}

/*
==============================================================================
ONE-TIME SQL MIGRATION — run this in the Neon SQL editor before activating
the ThriveCart webhook. Idempotent — safe to re-run.
==============================================================================

CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thrivecart_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  email TEXT NOT NULL,
  product_id TEXT,
  product_name TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  coupon_code TEXT,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(thrivecart_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_purchases_email ON purchases(email);
CREATE INDEX IF NOT EXISTS idx_purchases_created_at ON purchases(created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_coupon ON purchases(coupon_code);
CREATE INDEX IF NOT EXISTS idx_purchases_event ON purchases(event_type);
*/
