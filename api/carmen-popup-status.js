// api/carmen-popup-status.js
//
// Tells app.html's Carmen intercom popup whether to appear for the
// currently signed-in member. The popup nags every 7 days by default,
// but if a member has ALREADY BOOKED a connect call in GHL we want to
// stop showing it entirely — nobody wants a "book a call?" nudge after
// they've booked a call.
//
// Signal: GHL applies the tag "connect call - new form" automatically
// to any contact who books through the connectcall calendar. That tag
// gets synced to Neon via /api/admin/ghl-tags-sync. We check for it
// here (case-insensitive) and gate the popup accordingly.
//
// GET → { should_show: bool, reason: string }
// Auth: member session token via x-session-token header (same key the
// Field's chat endpoints use).

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../lib/db.js";

// Tag GHL applies automatically when a connect call is booked.
// Matched case-insensitively so casing changes in GHL don't break us.
const BOOKED_TAG = "connect call - new form";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const token = req.headers["x-session-token"];
  const user = token ? await getUserBySessionToken(token) : null;
  if (!user) {
    // Not signed in — the client-side check already skips in this case,
    // but return an explicit reason so we can log/inspect if needed.
    return res.status(200).json({ should_show: false, reason: "not_authenticated" });
  }

  try {
    const { rows } = await sql`
      SELECT 1
      FROM member_ghl_tags mgt,
           jsonb_array_elements_text(COALESCE(mgt.tags, '[]'::jsonb)) t(tag)
      WHERE LOWER(mgt.email) = LOWER(${user.email})
        AND LOWER(t.tag) = ${BOOKED_TAG}
      LIMIT 1
    `;
    if (rows.length > 0) {
      return res.status(200).json({ should_show: false, reason: "already_booked" });
    }
    return res.status(200).json({ should_show: true, reason: "eligible" });
  } catch (e) {
    // On any DB error, default to SHOWING so a temporary Neon blip
    // doesn't silently break Carmen's outreach. The client-side
    // cooldown + local-storage flag still keep it from spamming.
    console.error("carmen_popup_status_failed", e);
    return res.status(200).json({ should_show: true, reason: "check_failed" });
  }
}
