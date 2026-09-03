// api/unlimited/sessions.js
// List a user's Unlimited chat sessions (most recent first).
// Used by the sidebar to render the chat history list.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";
import { getProcessByKey } from "../../lib/prompts/processes/index.js";

function applyCors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!origin && process.env.NODE_ENV !== "production") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const token = req.headers["x-session-token"];
    const user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    // Tier gate:
    //   - full: standard Unlimited access (list + create any session).
    //   - workshop: ATWT VIP tier, uses this endpoint to open the three
    //     workshop-integration processes (Beyond Potential Board,
    //     Pattern Breakthrough, Quantum Leap Decision).
    //   - preview WITH addon: allowed ONLY to create/list workshop-
    //     integration sessions (the per-request process check further
    //     down enforces that). This is the "Power Reset buyer bought
    //     the workshop integration add-on without upgrading to
    //     Unlimited" path.
    //   - kajabi_entitled = false: anonymous demo accounts, bypassed
    //     so demo testing works.
    const hasWorkshopAddon = user.workshop_addon_expires_at
      ? new Date(user.workshop_addon_expires_at).getTime() > Date.now()
      : false;
    const allowedTier = user.tier === "full" || user.tier === "workshop" || hasWorkshopAddon;
    if (!allowedTier && user.kajabi_entitled === true) {
      return res.status(403).json({ error: "unlimited_locked" });
    }
    // Preview-tier addon holders can ONLY list workshop-integration
    // sessions, not their (nonexistent) library. On GET, filter the
    // list to workshop-integration sessions only.
    const previewAddonOnly = hasWorkshopAddon && user.tier === "preview";

    if (req.method === "GET") {
      // List the user's Unlimited sessions. Pinned chats sort to the top
      // (most recently pinned first), then unpinned chats by recency.
      // Preview-tier addon holders only get to see their workshop-
      // integration sessions (they don't have a real Unlimited library).
      const { rows } = previewAddonOnly ? await sql`
        SELECT
          id,
          title,
          started_at,
          last_message_at,
          metadata,
          pinned_at,
          folder_id
        FROM sessions
        WHERE user_id = ${user.id}
          AND session_type = 'unlimited'
          AND metadata->>'process' LIKE 'workshop-integration-%'
        ORDER BY
          pinned_at DESC NULLS LAST,
          COALESCE(last_message_at, started_at) DESC
        LIMIT 100
      ` : await sql`
        SELECT
          id,
          title,
          started_at,
          last_message_at,
          metadata,
          pinned_at,
          folder_id
        FROM sessions
        WHERE user_id = ${user.id} AND session_type = 'unlimited'
        ORDER BY
          pinned_at DESC NULLS LAST,
          COALESCE(last_message_at, started_at) DESC
        LIMIT 100
      `;
      return res.status(200).json({
        sessions: rows.map((r) => ({
          id: r.id,
          title: r.title || "New chat",
          startedAt: r.started_at,
          lastMessageAt: r.last_message_at,
          metadata: r.metadata || {},
          pinnedAt: r.pinned_at,
          folderId: r.folder_id || null,
        })),
      });
    }

    if (req.method === "POST") {
      // Create a new Unlimited session. Optionally bind it to a guided
      // process (when started from the picker) — its prompt then drives
      // every turn of this chat.
      const requestedProcess = req.body && req.body.process;
      const proc = requestedProcess ? getProcessByKey(requestedProcess) : null;

      // Workshop-integration process gate. These three processes
      // (workshop-integration-1/2/3) are the paid add-on for the
      // September 2026 ATTT VIP cohort. Three paths allow it:
      //   1. tier='workshop' — the full ATTT VIP tier that also
      //      includes the Power Reset Steps.
      //   2. tier='full' AND workshop_addon_expires_at > now — an
      //      Unlimited member who bought the workshop add-on.
      //   3. tier='preview' AND workshop_addon_expires_at > now — a
      //      Power Reset buyer who bought the workshop add-on but not
      //      Unlimited. They still see the "Unlock Unlimited" paywall,
      //      but the addon dropdown is theirs to use.
      // Anyone else trying to open a workshop-integration process
      // (URL-hack, curl, etc.) gets 403.
      const isWorkshopIntegration = proc && String(proc.key || "").startsWith("workshop-integration-");
      if (isWorkshopIntegration) {
        const hasWorkshopTier = user.tier === "workshop";
        const canUseAddon = (user.tier === "full" || user.tier === "preview") && hasWorkshopAddon;
        if (!hasWorkshopTier && !canUseAddon) {
          return res.status(403).json({ error: "workshop_addon_required" });
        }
      }
      // Preview-tier addon holders can ONLY create workshop-integration
      // sessions (not general Unlimited chats). Enforce that here since
      // the coarse tier gate above lets them in for both.
      if (previewAddonOnly && !isWorkshopIntegration) {
        return res.status(403).json({ error: "unlimited_locked" });
      }

      const newTitle = proc ? proc.displayName : "New chat";
      const newMetadata = JSON.stringify(proc ? { process: proc.key } : {});
      const { rows } = await sql`
        INSERT INTO sessions (user_id, session_type, title, metadata)
        VALUES (${user.id}, 'unlimited', ${newTitle}, ${newMetadata})
        RETURNING id, title, started_at, last_message_at, metadata, pinned_at
      `;
      const row = rows[0];
      return res.status(200).json({
        session: {
          id: row.id,
          title: row.title,
          startedAt: row.started_at,
          lastMessageAt: row.last_message_at,
          metadata: row.metadata || {},
          pinnedAt: row.pinned_at,
        },
      });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("unlimited_sessions_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
