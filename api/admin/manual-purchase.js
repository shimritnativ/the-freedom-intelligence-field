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
//     full_name: "Majbritt Gilbert Jespersen", // optional, backfills users.display_name
//     first_name: "Majbritt",            // optional, used if full_name absent
//     last_name: "Gilbert Jespersen",    // optional, used if full_name absent
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

  // Customer name: prefer full_name if given, otherwise build from first + last.
  // Used downstream to backfill users.display_name for Kajabi-created accounts
  // whose name is currently just the email prefix.
  const firstName = String(body.first_name || "").trim();
  const lastName = String(body.last_name || "").trim();
  const fullName = String(
    body.full_name ||
    body.customer_name ||
    [firstName, lastName].filter(Boolean).join(" ")
  ).trim();

  // UTM passthrough — accept the same field names ThriveCart exposes in
  // Zapier (passthrough_utm_*) plus the bare utm_* aliases. Used to set
  // users.utm_source / utm_medium / utm_campaign so the admin dashboard
  // can attribute the buyer to Meta ads (vs Organic) and so the Ads tab's
  // revenue-by-campaign metric works. Stored on user row only when the
  // user doesn't already have UTMs (first-touch attribution rule).
  const trunc200 = (s) => s ? String(s).slice(0, 200) : null;
  // Prefer ThriveCart's passthrough values (which reflect the real
  // campaign the buyer came from — cold, warm, etc.) over any Zap-
  // hardcoded utm_* fields. Reversed July 2026 after Mikael's
  // cold/warm ambiguity: the Zap was hardcoding utm_campaign=meta_ads,
  // which overwrote ThriveCart's real "cold" or "warm" passthrough
  // value and lost per-campaign attribution. Now passthrough wins;
  // hardcoded stays as fallback so direct-to-cart buyers still get
  // an ads tag if the Zap sends one.
  const utmSource   = trunc200(body.passthrough_utm_source   || body.utm_source);
  const utmMedium   = trunc200(body.passthrough_utm_medium   || body.utm_medium);
  const utmCampaign = trunc200(body.passthrough_utm_campaign || body.utm_campaign);
  const utmContent  = trunc200(body.passthrough_utm_content  || body.utm_content);
  const utmTerm     = trunc200(body.passthrough_utm_term     || body.utm_term);

  // Build the raw_payload marker so a later reconciliation against
  // ThriveCart can spot manually-entered rows and treat them differently
  // if needed (e.g., "trust ThriveCart's number over ours when they diverge").
  const rawPayload = {
    manual_entry: true,
    entered_by: actorEmail,
    entered_at: new Date().toISOString(),
    notes: notes || null,
    full_name: fullName || null,
    first_name: firstName || null,
    last_name: lastName || null,
    utm_source: utmSource,
    utm_medium: utmMedium,
    utm_campaign: utmCampaign,
    utm_content: utmContent,
    utm_term: utmTerm,
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

    // UTM passthrough — write to users row using first-touch attribution
    // (COALESCE keeps existing UTM if already set, only fills in nulls).
    // This is what makes the Ads tab attribute a purchase to Meta vs
    // Organic. Without this, every Zapier-created purchase defaulted to
    // Organic regardless of where the buyer actually came from.
    if (utmSource || utmMedium || utmCampaign || utmContent || utmTerm) {
      try {
        await sql`
          UPDATE users
          SET utm_source   = COALESCE(utm_source, ${utmSource}),
              utm_medium   = COALESCE(utm_medium, ${utmMedium}),
              utm_campaign = COALESCE(utm_campaign, ${utmCampaign}),
              utm_content  = COALESCE(utm_content, ${utmContent}),
              utm_term     = COALESCE(utm_term, ${utmTerm}),
              updated_at   = NOW()
          WHERE LOWER(email) = ${email}
        `;
      } catch (utmErr) {
        // Non-fatal: a missing utm_source column shouldn't block a purchase.
        // Worst case the buyer just shows as Organic until manually corrected.
        console.warn("manual_purchase_utm_backfill_failed", { message: utmErr?.message });
      }
    }

    // Backfill display_name on the user row using the same conservative
    // rule the ThriveCart webhook uses: only overwrite when the existing
    // name is empty OR looks like a Kajabi email-prefix placeholder
    // (alphanumeric chars match the local-part). Real user-entered names
    // are preserved.
    if (fullName && fullName.includes(" ")) {
      try {
        const localPart = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
        await sql`
          UPDATE users
          SET display_name = ${fullName}, updated_at = NOW()
          WHERE email = ${email}
            AND (
              display_name IS NULL
              OR display_name = ''
              OR (
                POSITION(' ' IN display_name) = 0
                AND LOWER(REGEXP_REPLACE(display_name, '[^a-zA-Z0-9]', '', 'g')) = ${localPart}
              )
            )
        `;
      } catch (nameErr) {
        // Non-fatal: a name mismatch shouldn't block a purchase.
        console.warn("manual_purchase_name_backfill_failed", { message: nameErr?.message });
      }
    }

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
