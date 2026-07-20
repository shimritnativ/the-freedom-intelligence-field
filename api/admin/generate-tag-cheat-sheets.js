// api/admin/generate-tag-cheat-sheets.js
//
// Builds a compact, human-readable "cheat sheet" for every Field member
// out of the GHL tags we've already synced into member_ghl_tags. Since
// GHL's V2 conversation API isn't available to us (scopes not granted at
// our plan tier), tags are our best source of pre-call context.
//
// The categorizer sorts each tag into one of these buckets:
//   Programs         · MYP Business Club, RISE, Certification
//   Purchases        · Reset, Now Shift, Book Launch Team, coupons used
//   Consultation     · had a consultation call
//   Workshops        · every "workshop N …" tag, counted + dated
//   Engagement       · newly engaged, engaging, WA paused
//   Source           · ads, Ignite, etc.
//   Attendance       · attended live / zoom / replay
// then writes a formatted summary into member_cheat_sheets.tag_summary
// (a new column — the existing `notes` field stays untouched so Aira's
// manual additions are preserved across re-generations).
//
// Trigger: manual for now (from the admin console). If we later want a
// cron, add it to vercel.json — the generation is idempotent.
//
// Auth: @shimritnativ.com session, same as every admin endpoint.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

// ─── Categorization rules ─────────────────────────────────────────────
// Each entry has a lowercase test predicate + a friendly label used in
// the summary. Order matters within each category — first match wins so
// more specific rules go first.

function classify(tags) {
  const t = (tags || []).map((x) => String(x || "").toLowerCase().trim());
  const has = (needle) => t.some((tag) => tag.includes(needle));
  const startsWith = (prefix) => t.filter((tag) => tag.startsWith(prefix));

  const programs = [];
  if (has("myp business club") || has("business club")) programs.push("Business Club");
  if (t.some((x) => x === "rise client" || x === "rise paused" || x === "rise")) {
    programs.push("RISE (current)");
  } else if (has("past rise client") || has("rise past client") || has("rise graduate")) {
    programs.push("RISE (past / graduate)");
  }
  if (has("myp certificate") || has("myp cert") || has("coaching certification")) {
    programs.push("Certification");
  }

  const purchases = [];
  if (has("power reset - purchased") || has("72-hour power reset - purchased") || has("the 72-hour power reset")) {
    purchases.push("72-Hour Power Reset");
  }
  if (has("power reset - student pre-launch")) purchases.push("Power Reset — student pre-launch");
  if (has("the now shift - purchased") || has("now shift - purchased")) purchases.push("The Now Shift");
  if (has("book launch team") || has("official book launch team")) purchases.push("Book Launch Team");
  if (has("used power50 code") || has("used power50 coupon")) purchases.push("Used POWER50 coupon");
  if (has("used launchteamunlimited") || has("launchteamunlimited")) purchases.push("Used LAUNCHTEAMUNLIMITED coupon");
  if (has("unlimited - purchased")) purchases.push("Unlimited");

  const consultation = has("consultation");
  const isClient = has("client") && !has("workshop lead") /* avoid false-positive on 'workshop client' */;

  // Workshops — every tag beginning "workshop " counts. Preserve original
  // casing when we surface them in the summary by looking up the raw tag.
  const rawTags = tags || [];
  const workshops = rawTags.filter((raw) =>
    typeof raw === "string" && raw.toLowerCase().startsWith("workshop ")
  );

  const engagement = [];
  if (has("newly engaged")) engagement.push("Newly engaged");
  if (has("reset newly engaged")) engagement.push("Reset newly engaged");
  if (has("second engaging tag") || has("engaging")) engagement.push("Engaging");
  if (has("wa-paused-by-reply")) engagement.push("WhatsApp paused by reply");
  if (has("hot lead")) engagement.push("Hot lead");
  if (has("high intent")) engagement.push("High intent");

  const source = [];
  if (has("ads") || has("source - ads")) source.push("Ads");
  if (has("organic") || has("source - organic")) source.push("Organic");
  if (has("source - manychat") || has("manychat")) source.push("ManyChat");
  if (has("ignite 2025")) source.push("Ignite 2025");
  if (has("book launch")) source.push("Book launch");

  const attendance = [];
  // Match tags like "may 18 - attended zoom live", "may 4 (attended live)",
  // "shift april 20 - attended live", etc. — anything with "attended" and
  // either "live" or "zoom".
  const attendedLive = rawTags.filter((raw) => {
    const lc = String(raw || "").toLowerCase();
    return lc.includes("attended") && (lc.includes("live") || lc.includes("zoom"));
  });
  attendance.push(...attendedLive);

  // Anything we didn't classify. Drop generic noise ("org", "email list", …)
  // so the "Other" bucket stays meaningful. Also drop workshop-specific
  // tags (already surfaced) and anything used above.
  const usedLc = new Set();
  const drop = (raw) => usedLc.add(String(raw || "").toLowerCase());
  workshops.forEach(drop);
  attendedLive.forEach(drop);
  const NOISE = new Set([
    "org", "email list - in person event form", "created account themselves",
    "workshop lead", "ads", "client", "consultation",
    "myp business club", "business club",
    "rise client", "rise paused", "rise", "past rise client", "rise past client", "rise graduate",
    "myp certificate", "myp cert", "coaching certification",
    "newly engaged", "reset newly engaged", "engaging", "second engaging tag",
    "wa-paused-by-reply", "hot lead", "high intent",
    "organic", "source - ads", "source - organic", "source - manychat", "manychat",
    "ignite 2025", "book launch", "book launch team", "official book launch team",
    "used power50 code", "used power50 coupon (the power reset)", "used power50 coupon",
    "used launchteamunlimited", "launchteamunlimited", "unlimited - purchased",
    "power reset - purchased", "72-hour power reset - purchased", "the 72-hour power reset",
    "power reset - student pre-launch", "the now shift - purchased", "now shift - purchased",
    "72-hour power reset",
  ]);
  const other = rawTags.filter((raw) => {
    const lc = String(raw || "").toLowerCase().trim();
    return lc && !usedLc.has(lc) && !NOISE.has(lc) && !lc.startsWith("workshop ")
      && !(lc.includes("attended") && (lc.includes("live") || lc.includes("zoom")));
  });

  return { programs, purchases, consultation, isClient, workshops, engagement, source, attendance, other };
}

function formatSummary(classified, source) {
  const lines = [];
  const status = [];
  if (classified.isClient) status.push("Client");
  if (classified.consultation) status.push("Had a consultation call");
  if (status.length) lines.push("STATUS · " + status.join(" · "));

  if (classified.programs.length) {
    lines.push("PROGRAMS · " + classified.programs.join(" · "));
  }
  if (classified.purchases.length) {
    lines.push("PURCHASES · " + classified.purchases.join(" · "));
  }
  if (classified.workshops.length) {
    // Show most recent 3 workshops, note total.
    const recent = classified.workshops.slice(0, 3);
    let line = `WORKSHOPS · ${classified.workshops.length} attended`;
    if (recent.length) line += ": " + recent.join(", ");
    if (classified.workshops.length > 3) line += ", …";
    lines.push(line);
  }
  if (classified.attendance.length) {
    lines.push("LIVE ATTENDANCE · " + classified.attendance.slice(0, 4).join(" · "));
  }
  if (classified.engagement.length) {
    lines.push("ENGAGEMENT · " + classified.engagement.join(" · "));
  }
  if (classified.source.length || source) {
    const parts = [...classified.source];
    if (source && !parts.some((p) => p.toLowerCase() === String(source).toLowerCase())) {
      parts.push(source);
    }
    if (parts.length) lines.push("SOURCE · " + parts.join(" · "));
  }
  if (classified.other.length) {
    // Cap to keep the summary compact.
    const shown = classified.other.slice(0, 6);
    let line = "OTHER TAGS · " + shown.join(", ");
    if (classified.other.length > 6) line += `, … (+${classified.other.length - 6} more)`;
    lines.push(line);
  }

  return lines.join("\n");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sessionToken = req.headers["x-session-token"];
  const user = await getUserBySessionToken(sessionToken);
  if (!user || !(user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const startedAt = Date.now();

  const { rows } = await sql`
    SELECT LOWER(email) AS email, tags, source
    FROM member_ghl_tags
  `;

  if (rows.length === 0) {
    return res.status(200).json({
      ok: true,
      generated: 0,
      note: "No rows in member_ghl_tags. Run /api/admin/ghl-tags-sync first.",
      elapsed_ms: Date.now() - startedAt,
    });
  }

  let generated = 0;
  const skipped = [];
  for (const row of rows) {
    try {
      const tags = Array.isArray(row.tags) ? row.tags : [];
      const classified = classify(tags);
      const summary = formatSummary(classified, row.source);
      if (!summary.trim()) {
        skipped.push({ email: row.email, reason: "no_meaningful_tags" });
        continue;
      }
      await sql`
        INSERT INTO member_cheat_sheets (email, tag_summary, updated_by, updated_at)
        VALUES (${row.email}, ${summary}, 'auto-tag-generator', NOW())
        ON CONFLICT (email) DO UPDATE SET
          tag_summary = EXCLUDED.tag_summary,
          updated_at = NOW()
      `;
      generated++;
    } catch (e) {
      skipped.push({ email: row.email, reason: e.message });
    }
  }

  return res.status(200).json({
    ok: true,
    total_candidates: rows.length,
    generated,
    skipped_count: skipped.length,
    skipped: skipped.slice(0, 20),
    elapsed_ms: Date.now() - startedAt,
  });
}

/*
==============================================================================
ONE-TIME SQL MIGRATION — run in Neon SQL editor before hitting this endpoint.
Adds the tag_summary column to the existing member_cheat_sheets table.
Idempotent — safe to re-run.
==============================================================================

ALTER TABLE member_cheat_sheets
  ADD COLUMN IF NOT EXISTS tag_summary TEXT;
*/
