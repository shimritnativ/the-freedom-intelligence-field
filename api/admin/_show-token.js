// api/admin/_show-token.js
//
// ⚠️ ONE-TIME DEBUG ENDPOINT — DELETE AFTER USE ⚠️
//
// Purpose: reveal the current ADMIN_TOKEN value once so Geo can save it
// to her password manager (the Vercel UI redacts sensitive env vars and
// the CLI pull also redacts them, leaving no in-product way to recover).
//
// HOW IT WORKS:
//   - GET (no auth header)   → serves an HTML page that reads the session
//     token from localStorage and POSTs back to this same endpoint.
//     Result: you visit one URL while logged in to /admin and see the value.
//   - POST (with auth header) → returns JSON with the token value, gated
//     by an @shimritnativ.com session.
//
// USAGE:
//   1. Deploy this file.
//   2. Make sure you are logged in to https://thefieldai.app/admin in
//      the SAME browser tab/window (your session is stored in localStorage).
//   3. In that same browser, navigate to:
//        https://thefieldai.app/api/admin/_show-token
//   4. The page will auto-fetch the value and display it. Copy it.
//   5. Save in your password manager.
//   6. DELETE THIS FILE and redeploy.

import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

export default async function handler(req, res) {
  // CORS / preflight
  if (req.method === "OPTIONS") return res.status(200).end();
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");

  // ---- GET: serve the HTML helper page ----
  // Browser-friendly path. The page reads the session token from
  // localStorage (key matches admin.html's STORAGE_KEY) and POSTs back
  // to this endpoint with the header, then renders the value.
  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reveal ADMIN_TOKEN — one-off</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #0E0B07; color: #F7F1E1; padding: 40px; max-width: 720px; margin: 0 auto; }
    h1 { color: #C9A84C; font-weight: 500; }
    .box { background: #1A1612; border: 1px solid #C9A84C44; border-radius: 8px;
           padding: 24px; margin: 24px 0; }
    pre { background: #000; padding: 16px; border-radius: 4px; overflow-x: auto;
          color: #C9A84C; word-break: break-all; white-space: pre-wrap; }
    button { background: #C9A84C; color: #0E0B07; border: none; padding: 10px 18px;
             font-size: 14px; border-radius: 6px; cursor: pointer; font-weight: 600; }
    .err { color: #ff7676; }
    .ok { color: #6ec46e; }
    .warning { background: #4a1a1a; border-color: #ff7676; }
  </style>
</head>
<body>
  <h1>Reveal ADMIN_TOKEN</h1>
  <p>One-off recovery tool. After you copy the value, delete <code>/api/admin/_show-token.js</code> from the repo and redeploy.</p>
  <div id="result" class="box">Loading…</div>
  <div class="box warning">
    <strong>⚠️ Delete this endpoint after use.</strong> Anyone with a valid @shimritnativ.com session could see the token here. Keep the window short.
  </div>
  <script>
    (async function() {
      const result = document.getElementById('result');
      const token = localStorage.getItem('tfif_session_v1');
      if (!token) {
        result.innerHTML = '<p class="err">No session token in this browser. Open <a href="/admin" style="color:#C9A84C;">/admin</a> first, log in, then come back to this URL.</p>';
        return;
      }
      try {
        const r = await fetch('/api/admin/_show-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-session-token': token },
        });
        const data = await r.json();
        if (!r.ok) {
          result.innerHTML = '<p class="err">Error: ' + (data.error || r.status) + '</p>';
          return;
        }
        result.innerHTML =
          '<p class="ok">✓ Authenticated as ' + data.accessed_by + '</p>' +
          '<p><strong>ADMIN_TOKEN</strong> (' + data.admin_token_length + ' chars):</p>' +
          '<pre id="tok">' + (data.admin_token || '(empty)') + '</pre>' +
          '<button onclick="navigator.clipboard.writeText(document.getElementById(\\'tok\\').textContent).then(()=>this.textContent=\\'Copied!\\')">Copy to clipboard</button>' +
          (data.cron_secret ? '<p style="margin-top:24px;"><strong>CRON_SECRET</strong> (also worth saving):</p><pre>' + data.cron_secret + '</pre>' : '') +
          '<p style="margin-top:24px;font-size:13px;opacity:0.7;">Now: 1) Copy. 2) Save in password manager. 3) Delete /api/admin/_show-token.js. 4) Push + redeploy.</p>';
      } catch (e) {
        result.innerHTML = '<p class="err">Network error: ' + e.message + '</p>';
      }
    })();
  </script>
</body>
</html>`);
  }

  // ---- POST: return the JSON with the actual values ----
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const sessionToken = req.headers["x-session-token"];
  if (!sessionToken) {
    return res.status(401).json({
      error: "unauthorized",
      hint: "Visit the GET version of this URL in a browser logged in to /admin.",
    });
  }

  const user = await getUserBySessionToken(sessionToken);
  if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const adminToken = process.env.ADMIN_TOKEN || null;
  const cronSecret = process.env.CRON_SECRET || null;

  // Audit log — captures who, when, and lengths, but never the actual value.
  console.warn("admin_token_revealed", {
    accessed_by: user.email,
    accessed_at: new Date().toISOString(),
    has_admin_token: Boolean(adminToken),
    admin_token_length: adminToken ? adminToken.length : 0,
  });

  return res.status(200).json({
    ok: true,
    warning: "DELETE /api/admin/_show-token.js AFTER COPYING",
    admin_token: adminToken,
    admin_token_set: Boolean(adminToken),
    admin_token_length: adminToken ? adminToken.length : 0,
    cron_secret: cronSecret,
    cron_secret_set: Boolean(cronSecret),
    accessed_by: user.email,
    accessed_at: new Date().toISOString(),
  });
}
