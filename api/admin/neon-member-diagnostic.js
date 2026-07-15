// api/admin/neon-member-diagnostic.js
//
// Diagnostic: pull EVERYTHING Neon knows about a member so we can
// compare against what GHL tags say. Use for Bernie or any other
// member we want to verify.
//
// Usage: /api/admin/neon-member-diagnostic?email=locutusborg22@gmail.com
//
// Delete this file after we're done cross-checking.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sessionToken = req.headers["x-session-token"];
  const user = await getUserBySessionToken(sessionToken);
  if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const email = String(req.query.email || "").toLowerCase().trim();
  if (!email) {
    return res.status(400).json({ error: "email_required", hint: "?email=user@example.com" });
  }

  try {
    // 1. User row
    const { rows: userRows } = await sql`
      SELECT id, email, display_name, tier::text AS tier, kajabi_entitled,
             created_at, first_login_at,
             COALESCE(last_completed_day, 0) AS last_completed_day
      FROM users
      WHERE LOWER(email) = ${email}
    `;
    if (userRows.length === 0) {
      return res.status(200).json({ email, found: false });
    }
    const u = userRows[0];

    // 2. Day completions (Reset progress)
    const { rows: completions } = await sql`
      SELECT day, completed_at, session_id, schema_version
      FROM day_completions
      WHERE user_id = ${u.id}
      ORDER BY day ASC
    `;

    // 3. All sessions (Field activity)
    const { rows: sessions } = await sql`
      SELECT id, session_type, started_at,
             metadata->>'process' AS process_key,
             metadata->>'day' AS day_tag
      FROM sessions
      WHERE user_id = ${u.id}
      ORDER BY started_at DESC
      LIMIT 50
    `;

    // 4. Session count by type
    const { rows: sessionsByType } = await sql`
      SELECT session_type, COUNT(*)::int AS count,
             MIN(started_at) AS first_session,
             MAX(started_at) AS last_session
      FROM sessions
      WHERE user_id = ${u.id}
      GROUP BY session_type
    `;

    // 5. Days since purchase
    const daysSincePurchase = Math.max(0,
      Math.floor((Date.now() - new Date(u.created_at).getTime()) / (1000 * 60 * 60 * 24))
    );

    return res.status(200).json({
      email,
      found: true,
      user: u,
      days_since_purchase: daysSincePurchase,
      day_completions_count: completions.length,
      day_completions: completions,
      session_totals_by_type: sessionsByType,
      recent_sessions: sessions,
      summary: {
        neon_says_completed_days: completions.map(c => c.day),
        neon_total_sessions: sessions.length,
        purchase_date: u.created_at,
        days_ago: daysSincePurchase,
      },
      hint: "Compare `neon_says_completed_days` with GHL tags. Also check `recent_sessions` for activity — if empty, this member never actually engaged with the Field even if GHL says they completed days.",
    });
  } catch (e) {
    return res.status(500).json({ error: "diagnostic_failed", message: e.message });
  }
}
