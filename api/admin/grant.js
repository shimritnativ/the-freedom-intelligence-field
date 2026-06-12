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
// Tier values: 'preview' (72-Hour Reset) | 'full' (Unlimited)
//
// Auth: gated by ADMIN_TOKEN env var. Never expose this token publicly.
// Idempotent: re-running for the same email is safe — it upserts.

import { grantEntitlement, revokeEntitlementByEmail } from "../../lib/db.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  // Admin auth — accept token from header OR query string so this can be
  // triggered with a plain browser URL.
  const adminToken = process.env.ADMIN_TOKEN;
  const provided =
    (req.headers && req.headers["x-admin-token"]) ||
    (req.query && req.query.token) ||
    "";
  if (!adminToken || provided !== adminToken) {
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
        return respond(req, res, 404, {
          ok: false,
          error: "user_not_found",
          email: email,
        });
      }
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
