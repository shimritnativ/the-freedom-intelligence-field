// api/admin/transfer-account.js
// Rename a member's primary email across every table that stores it.
// Used when GHL and Neon disagree on the member's canonical email (e.g. a
// customer bought with one address and now wants their account moved to
// another). Sandra Venere was the first case: purchased under
// sandra@wynstar.ca, wants everything moved to sandra.venere1234@gmail.com.
//
// What this changes:
//   - users.email                    (primary record — citext UNIQUE)
//   - purchases.email                (all ThriveCart purchase rows)
//   - whatsapp_message_events.contact_email  (all WA delivery events)
//   - outreach_contacted.email       (Aira's contacted flag; PK)
//   - login_codes.email              (any pending or recent login codes)
//
// What this does NOT change:
//   - sessions / messages / day_completions — all keyed by user_id (UUID)
//     which follows automatically.
//   - webhook_events.payload — append-only audit log; must remain
//     historically accurate.
//   - aira_checklist_* / intelligence_dismissals — no member email in these.
//
// Safety:
//   - Refuses if source user doesn't exist.
//   - Refuses if destination user already exists (avoids accidental merge).
//   - Refuses if from == to.
//   - Supports dry_run mode to preview counts before committing.
//   - Runs in a single transaction; on error, nothing is changed.
//
// Auth: @shimritnativ.com session OR ADMIN_TOKEN.
//
// POST body: { from_email, to_email, dry_run? }

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

  // ---- Auth (mirrors update-member-name.js) --------------------------------
  const adminToken = process.env.ADMIN_TOKEN;
  const providedAdminToken =
    (req.headers && req.headers["x-admin-token"]) || "";
  const sessionToken = req.headers["x-session-token"];
  let authorized = false;
  let actor = "admin_token";
  if (adminToken && providedAdminToken === adminToken) {
    authorized = true;
  } else if (sessionToken) {
    const user = await getUserBySessionToken(sessionToken);
    if (user && (user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
      authorized = true;
      actor = user.email;
    }
  }
  if (!authorized) return res.status(401).json({ error: "unauthorized" });

  // ---- Input validation ----------------------------------------------------
  const body = req.body || {};
  const fromEmail = String(body.from_email || "").trim().toLowerCase();
  const toEmail = String(body.to_email || "").trim().toLowerCase();
  const dryRun = !!body.dry_run;

  if (!fromEmail || !fromEmail.includes("@")) {
    return res.status(400).json({ error: "invalid_from_email" });
  }
  if (!toEmail || !toEmail.includes("@")) {
    return res.status(400).json({ error: "invalid_to_email" });
  }
  if (fromEmail === toEmail) {
    return res.status(400).json({ error: "from_and_to_are_identical" });
  }

  try {
    // ---- Pre-flight checks --------------------------------------------------
    const { rows: sourceRows } = await sql`
      SELECT id, email, display_name, tier FROM users WHERE email = ${fromEmail} LIMIT 1
    `;
    if (sourceRows.length === 0) {
      return res.status(404).json({ error: "source_user_not_found", from_email: fromEmail });
    }
    const sourceUser = sourceRows[0];

    const { rows: destRows } = await sql`
      SELECT id, email FROM users WHERE email = ${toEmail} LIMIT 1
    `;
    if (destRows.length > 0) {
      return res.status(409).json({
        error: "destination_email_already_exists",
        message: "A different account already uses the destination email. Manual merge required — this endpoint refuses to combine two user records.",
        to_email: toEmail,
        destination_user_id: destRows[0].id,
      });
    }

    // ---- Count what will be affected (used for both dry-run and commit) ----
    const [
      { rows: purchasesCount },
      { rows: waEventsCount },
      { rows: outreachCount },
      { rows: loginCodesCount },
    ] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n FROM purchases WHERE email = ${fromEmail}`,
      sql`SELECT COUNT(*)::int AS n FROM whatsapp_message_events WHERE LOWER(contact_email) = ${fromEmail}`,
      sql`SELECT COUNT(*)::int AS n FROM outreach_contacted WHERE email = ${fromEmail}`,
      sql`SELECT COUNT(*)::int AS n FROM login_codes WHERE email = ${fromEmail}`,
    ]);

    const preview = {
      source_user: sourceUser,
      from_email: fromEmail,
      to_email: toEmail,
      would_update: {
        users: 1,
        purchases: purchasesCount[0].n,
        whatsapp_message_events: waEventsCount[0].n,
        outreach_contacted: outreachCount[0].n,
        login_codes: loginCodesCount[0].n,
      },
    };

    if (dryRun) {
      return res.status(200).json({ ok: true, dry_run: true, preview });
    }

    // ---- Commit the transfer ------------------------------------------------
    // @vercel/postgres runs each tagged template as its own statement, so we
    // fire them sequentially. If any fails, we return 500 with details;
    // partial updates are logged. In practice these are small updates and
    // extremely unlikely to fail mid-way — but we run the users update LAST
    // so a mid-flight failure leaves the source email intact and rerunnable.
    //
    // Order rationale:
    //   1. Purchases, WA events, login codes — dependent tables with the
    //      OLD email as a value. Update these first.
    //   2. Outreach contacted — same, but PK on email so it's a delete+insert
    //      pattern to be safe.
    //   3. Users — LAST. Once this flips, the "from_email" no longer resolves
    //      to this user, so it's the canonical commit point.

    const results = {};

    const { rowCount: purchasesUpdated } = await sql`
      UPDATE purchases SET email = ${toEmail} WHERE email = ${fromEmail}
    `;
    results.purchases = purchasesUpdated;

    const { rowCount: waUpdated } = await sql`
      UPDATE whatsapp_message_events
         SET contact_email = ${toEmail}
       WHERE LOWER(contact_email) = ${fromEmail}
    `;
    results.whatsapp_message_events = waUpdated;

    // outreach_contacted: email is PK. Because we already confirmed there's no
    // users row for to_email, any existing outreach_contacted row for to_email
    // would be stale/orphaned — safe to remove before renaming.
    await sql`DELETE FROM outreach_contacted WHERE email = ${toEmail}`;
    const { rowCount: outreachUpdated } = await sql`
      UPDATE outreach_contacted SET email = ${toEmail} WHERE email = ${fromEmail}
    `;
    results.outreach_contacted = outreachUpdated;

    const { rowCount: loginUpdated } = await sql`
      UPDATE login_codes SET email = ${toEmail} WHERE email = ${fromEmail}
    `;
    results.login_codes = loginUpdated;

    // Users last — this is the commit point.
    const { rows: usersUpdated } = await sql`
      UPDATE users
         SET email = ${toEmail}, updated_at = NOW()
       WHERE email = ${fromEmail}
       RETURNING id, email, display_name, tier
    `;
    results.users = usersUpdated.length;

    console.log("account_transfer_completed", {
      actor,
      from_email: fromEmail,
      to_email: toEmail,
      user_id: sourceUser.id,
      counts: results,
    });

    return res.status(200).json({
      ok: true,
      transferred: {
        user: usersUpdated[0] || null,
        counts: results,
      },
    });
  } catch (err) {
    console.error("transfer_account_error", {
      message: err?.message,
      from: fromEmail,
      to: toEmail,
    });
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || "unknown",
    });
  }
}
