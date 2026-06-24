// api/admin/manual-purchase.js
// Manual purchase entry. Used when a real customer paid via ThriveCart
// but the webhook didn't reach us — happens occasionally (Elena's
// Unlimited monthly, N Dyudneva's Reset). Faster than typing raw SQL
// into Neon every time.
//
// Auth: @shimritnativ.com session OR ADMIN_TOKEN. Always admin-only.
//
// POST body:
//   {
//     thrivecart_id: "MYP-000100586",   // required, unique key
//     event_type: "order.success",      // default "order.success"
//     email: "n.dyudneva@gmail.com",    // required
//     product_name: "The Power Reset",  // required
//     amount_cents: 450,                // required, gross price in cents
//     currency: "EUR",                   // default "EUR"
//     coupon_code: "POWER50",            // optional
//     notes: "Manually backfilled..."    // optional, stored in raw_payload
//   }
//
// Returns the inserted row OR a clear error on duplicate / missing fields.
// Idempotent on (thrivecart_id, event_type) — re-submitting the same
// invoice with the same event type returns the existing row instead of
// erroring, so accidental double-clicks are harmless.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-admin-token");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Auth: admin token OR @shimritnativ.com session.
  const adminToken = process.env.ADMIN_TOKEN;
  const providedAdminToken =
    (req.headers && req.headers["x-admin-token"]) || "";
  const sessionToken = req.headers["x-session-token"];
  let authorized = false;
  let actorEmail = null;
  if (adminToken && providedAdminToken === adminToken) {
    authorized = true;
    actorEmail = "admin-token";
  } else if (sessionToken) {
    const user = await getUserBySessionToken(sessionToken);
    if (user && (user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
      authorized = true;
      actorEmail = (user.email || "").toLowerCase();
    }
  }
  if (!authorized) return res.status(401).json({ error: "unauthorized" });

  const body = req.body || {};

  // Validate. We're strict about the four fields that drive accounting
  // (id, email, product name, amount) and permissive about the rest.
  const thrivecartId = String(body.thrivecart_id || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const productName = String(body.product_name || "").trim();
  const amountCents = Math.round(Number(body.amount_cents || 0));
  if (!thrivecartId) return res.status(400).json({ error: "missing_thrivecart_id" });
  if (!email || !email.includes("@")) return res.status(400).json({ error: "invalid_email" });
  if (!productName) return res.status(400).json({ error: "missing_product_name" });
  if (!Number.isFinite(amountCents) || amountCents < 0) {
    return res.status(400).json({ error: "invalid_amount_cents" });
  }

  const eventType = String(body.event_type || "order.success").trim();
  const currency = String(body.currency || "EUR").trim().toUpperCase().slice(0, 3);
  const couponCode = body.coupon_code ? String(body.coupon_code).trim() : null;
  const notes = body.notes ? String(body.notes).slice(0, 1000) : null;
  const productId = body.product_id ? String(body.product_id).trim() : null;

  // Build the raw_payload marker so a later reconciliation against
  // ThriveCart can spot manually-entered rows and treat them differently
  // if needed (e.g., "trust ThriveCart's number over ours when they diverge").
  const rawPayload = {
    manual_entry: true,
    entered_by: actorEmail,
    entered_at: new Date().toISOString(),
    notes: notes || null,
  };

  try {
    const { rows } = await sql`
      INSERT INTO purchases (
        thrivecart_id, event_type, email,
        product_id, product_name,
        amount_cents, currency, coupon_code,
        raw_payload
      ) VALUES (
        ${thrivecartId}, ${eventType}, ${email},
        ${productId}, ${productName},
        ${amountCents}, ${currency}, ${couponCode},
        ${JSON.stringify(rawPayload)}::jsonb
      )
      ON CONFLICT (thrivecart_id, event_type) DO NOTHING
      RETURNING *
    `;

    if (rows.length === 0) {
      // Conflict — already exists. Return existing row so the UI can
      // show "this purchase is already logged" instead of "saved".
      const { rows: existing } = await sql`
        SELECT * FROM purchases
        WHERE thrivecart_id = ${thrivecartId}
          AND event_type = ${eventType}
        LIMIT 1
      `;
      return res.status(200).json({
        ok: true,
        already_existed: true,
        row: existing[0] || null,
      });
    }

    return res.status(200).json({
      ok: true,
      already_existed: false,
      row: rows[0],
    });
  } catch (err) {
    console.error("manual_purchase_error", { message: err?.message });
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message,
    });
  }
}
