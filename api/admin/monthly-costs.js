// api/admin/monthly-costs.js
// Monthly cost snapshot endpoint. Two methods:
//   GET  /api/admin/monthly-costs              → list every service + amount
//   POST /api/admin/monthly-costs              → upsert one or many services
//
// Auth: @shimritnativ.com session only (same gate as the rest of admin).
//
// POST body shape:
//   { costs: [{ service_key, amount, currency, notes? }, ...] }
//
// The endpoint upserts each row, sets updated_by_email to the caller, and
// returns the full refreshed list so the UI can render immediately without
// a second GET round-trip.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

function isAdmin(user) {
  return !!user && (user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");

  const token = req.headers["x-session-token"];
  const user = await getUserBySessionToken(token);
  if (!isAdmin(user)) return res.status(403).json({ error: "forbidden" });

  try {
    if (req.method === "GET") {
      const { rows } = await sql`
        SELECT service_key, amount::text, currency, notes,
               updated_by_email, updated_at
        FROM monthly_costs
        ORDER BY service_key
      `;
      // amount comes back as a string from NUMERIC — coerce to number so
      // the frontend can use it in arithmetic without parseFloat dance.
      const costs = rows.map(r => ({
        service_key: r.service_key,
        amount: Number(r.amount || 0),
        currency: r.currency || "USD",
        notes: r.notes || "",
        updated_by_email: r.updated_by_email || null,
        updated_at: r.updated_at || null,
      }));
      return res.status(200).json({ costs });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const items = Array.isArray(body.costs) ? body.costs : [];
      if (!items.length) {
        return res.status(400).json({ error: "no_items" });
      }
      const senderEmail = (user.email || "").toLowerCase();

      // Upsert each item. ON CONFLICT updates everything except service_key
      // (the primary key) and only touches updated_at + updated_by_email.
      // We loop rather than building a multi-row VALUES list because the
      // input length is small (~9 items) and the loop is clearer.
      for (const item of items) {
        const key = String(item.service_key || "").trim().toLowerCase();
        if (!key) continue;
        const amount = Number(item.amount || 0);
        const currency = String(item.currency || "USD").toUpperCase().slice(0, 3);
        const notes = item.notes != null ? String(item.notes).slice(0, 200) : null;
        await sql`
          INSERT INTO monthly_costs (service_key, amount, currency, notes,
                                     updated_by_email, updated_at)
          VALUES (${key}, ${amount}, ${currency}, ${notes},
                  ${senderEmail}, NOW())
          ON CONFLICT (service_key) DO UPDATE SET
            amount = EXCLUDED.amount,
            currency = EXCLUDED.currency,
            notes = COALESCE(EXCLUDED.notes, monthly_costs.notes),
            updated_by_email = EXCLUDED.updated_by_email,
            updated_at = NOW()
        `;
      }

      // Return refreshed list.
      const { rows } = await sql`
        SELECT service_key, amount::text, currency, notes,
               updated_by_email, updated_at
        FROM monthly_costs
        ORDER BY service_key
      `;
      const costs = rows.map(r => ({
        service_key: r.service_key,
        amount: Number(r.amount || 0),
        currency: r.currency || "USD",
        notes: r.notes || "",
        updated_by_email: r.updated_by_email || null,
        updated_at: r.updated_at || null,
      }));
      return res.status(200).json({ ok: true, costs });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("monthly_costs_error", { message: err?.message });
    return res.status(500).json({ error: "server_error" });
  }
}
