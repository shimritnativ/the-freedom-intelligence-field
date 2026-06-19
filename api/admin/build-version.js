// api/admin/build-version.js
// Returns the current deploy's build identifier as plain text. The
// admin.html page fetches this on every load (with cache:'no-store')
// and compares it to its embedded window.__ADMIN_BUILD constant. If
// they don't match — meaning the user is on a cached HTML from an
// older deploy — the page force-reloads with a cache-bust query.
//
// This is the safety net that breaks iOS Safari out of an old cached
// admin.html after we ship a new deploy. Without it, mobile users had
// to manually hard-refresh to see updates.
//
// We prefer VERCEL_GIT_COMMIT_SHA because it changes on every deploy.
// Falls back to a fixed string so local dev doesn't trip the reload.

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Content-Type", "text/plain");
  const build =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_DEPLOYMENT_ID ||
    "2026-06-19-T1";
  res.status(200).send(build);
}
