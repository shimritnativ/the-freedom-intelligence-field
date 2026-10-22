// api/admin/grant.js
// Admin one-click grant endpoint. Lets the team comp access to the
// 72-Hour Reset or Unlimited without going through Kajabi checkout.
//
// Usage (browser, easiest):
//   https://<host>/api/admin/grant?token=ADMIN_TOKEN&email=teammate@x.com&tier=preview
//
// Usage (curl, with header instead of query token):
//   curl -X POST https://<host>/api/admin/grant \
//     -H "x-admin-token: ADMIN_TOKEN" \
//     -H "content-type: application/json" \
//     -d '{"email":"teammate@x.com","tier":"preview"}'
//
// Usage (admin dashboard, what the team actually uses):
//   The "Give access" panel on the Members tab posts here with the
//   signed-in @shimritnativ.com session token, so nobody needs to hold
//   ADMIN_TOKEN just to comp someone.
//
// Tier values: 'preview' (The 72-Hour Power Reset) | 'full' (The Field Unlimited)
//
// Auth: @shimritnativ.com session OR ADMIN_TOKEN, the same pair every other
// admin endpoint accepts. ADMIN_TOKEN is still read from the query string so
// the plain browser URL above keeps working. Never expose that token publicly.
// Idempotent: re-running for the same email is safe, it upserts.

import { sql } from "@vercel/postgres";
import {
  grantEntitlement,
  revokeEntitlementByEmail,
  getUserBySessionToken,
} from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-admin-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Admin auth. ADMIN_TOKEN is accepted from a header OR the query string so
  // this can still be triggered with a plain browser URL. The dashboard
  // instead sends the signed-in member's session token.
  const adminToken = process.env.ADMIN_TOKEN;
  const providedAdminToken =
    (req.headers && req.headers["x-admin-token"]) ||
    (req.query && req.query.token) ||
    "";
  const sessionToken = req.headers && req.headers["x-session-token"];
  let authorized = false;
  let actor = null;
  if (adminToken && providedAdminToken === adminToken) {
    authorized = true;
    actor = "admin_token";
  } else if (sessionToken) {
    const admin = await getUserBySessionToken(sessionToken);
    if (admin && (admin.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
      authorized = true;
      actor = admin.email;
    }
  }
  if (!authorized) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // Pull params from query (browser flow) or body (curl flow).
  const q = req.query || {};
  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const email = String(q.email || body.email || "").trim().toLowerCase();
  const tier = String(q.tier || body.tier || "preview").trim().toLowerCase();
  const action = String(q.action || body.action || "grant").trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return respond(req, res, 400, {
      ok: false,
      error: "invalid_email",
      message: "Provide a valid ?email=... ",
    });
  }

  if (action !== "grant" && action !== "revoke") {
    return respond(req, res, 400, {
      ok: false,
      error: "invalid_action",
      message: "action must be 'grant' or 'revoke'",
    });
  }

  if (action === "grant" && tier !== "preview" && tier !== "full") {
    return respond(req, res, 400, {
      ok: false,
      error: "invalid_tier",
      message: "tier must be 'preview' or 'full'",
    });
  }

  try {
    let user;
    if (action === "revoke") {
      user = await revokeEntitlementByEmail(email);
      if (!user) {
        // revokeEntitlementByEmail returns null for two unrelated reasons:
        // the email is not in users at all, or the revoke was deliberately
        // skipped by its 30-minute activate:full guard (the monthly to yearly
        // upgrade race). Reporting both as user_not_found sends the team
        // hunting for a typo when the guard is what actually fired.
        const { rows } = await sql`
          SELECT email FROM users WHERE email = ${email} LIMIT 1
        `;
        if (rows.length > 0) {
          return respond(req, res, 409, {
            ok: false,
            error: "revoke_skipped_recent_grant",
            email: email,
            message:
              "A webhook granted this account full access in the last 30 " +
              "minutes, so the revoke was skipped to protect a monthly to " +
              "yearly upgrade. Try again in half an hour.",
          });
        }
        return respond(req, res, 404, {
          ok: false,
          error: "user_not_found",
          email: email,
          message: "No account has ever signed up with that email.",
        });
      }
      console.log("admin_revoke", { actor: actor, email: user.email });
      return respond(req, res, 200, {
        ok: true,
        action: "revoke",
        email: user.email,
        tier: user.tier,
        kajabi_entitled: user.kajabi_entitled,
      });
    }

    user = await grantEntitlement({
      email: email,
      tier: tier,
      kajabiMemberId: null, // admin grants are not tied to a Kajabi member
    });
    console.log("admin_grant", { actor: actor, email: user.email, tier: user.tier });
    return respond(req, res, 200, {
      ok: true,
      action: "grant",
      email: user.email,
      tier: user.tier,
      preview_ends_at: user.preview_ends_at,
      login_url: "https://thefieldai.app/",
    });
  } catch (err) {
    console.error("admin_grant_error", { message: err?.message });
    return respond(req, res, 500, { ok: false, error: "server_error" });
  }
}

// Render JSON for API callers, simple HTML for browser hits, so the team
// gets a friendly success page when they click the URL.
function respond(req, res, status, payload) {
  const accept = (req.headers && req.headers.accept) || "";
  const wantsHtml = accept.indexOf("text/html") !== -1;
  if (!wantsHtml) {
    return res.status(status).json(payload);
  }
  const ok = !!payload.ok;
  const title = ok ? "Access granted" : "Could not complete";
  const body = ok
    ? `
      <h1>${escape(title)}</h1>
      <p><strong>${escape(payload.email || "")}</strong> now has
         <strong>${escape(payload.tier || "")}</strong> access.</p>
      ${payload.preview_ends_at ? `<p>72-Hour Reset window ends: <code>${escape(payload.preview_ends_at)}</code></p>` : ""}
      <p>They can log in here:
        <a href="${escape(payload.login_url || "/app.html")}">${escape(payload.login_url || "/app.html")}</a>
      </p>`
    : `
      <h1>${escape(title)}</h1>
      <p><code>${escape(payload.error || "unknown_error")}</code></p>
      ${payload.message ? `<p>${escape(payload.message)}</p>` : ""}`;
  res.setHeader("content-type", "text/html; charset=utf-8");
  return res.status(status).send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px;
         margin: 64px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.5; }
  h1 { font-size: 28px; margin-bottom: 16px; }
  code { background: #f3f3f3; padding: 2px 6px; border-radius: 4px; }
  a { color: #6b46c1; }
</style></head>
<body>${body}</body></html>`);
}

function escape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
