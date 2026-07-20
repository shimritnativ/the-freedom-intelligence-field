// api/admin/generate-tag-cheat-sheets.js
//
// Turns each member's GHL tags into a plain-English cheat sheet Carmen can
// read in 5 seconds before dialing. Optimized for a non-technical reader:
//   - Sentence-case section labels (no ALL CAPS)
//   - Cleaned workshop names (Workshop 7 — The Prosperity Code, not
//     "workshop 7 the prosperity code")
//   - Combines the 3 Reset completion tags into one line ("Completed all
//     3 days ✓")
//   - Distinguishes workshops she ATTENDED from workshop-lead SOURCE tags
//   - Drops meaningless noise ("org", "email list", generic tags)
//   - No monospace, no bracketed IDs, no field names Carmen won't recognize
//
// Output is a multi-line string written to member_cheat_sheets.tag_summary.
// Aira's manual notes column stays untouched.

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../../lib/db.js";

const ALLOWED_DOMAIN = "@shimritnativ.com";

// ─── Helpers ────────────────────────────────────────────────────────

// Title-case with intelligent handling of small words + acronyms.
function titleCase(s) {
  if (!s) return s;
  const small = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
  const acronyms = new Set(["myp", "wa", "rise", "atwt", "sms", "dm"]);
  return String(s)
    .toLowerCase()
    .split(/\s+/)
    .map((word, i) => {
      const clean = word.replace(/[^\w]/g, "");
      if (acronyms.has(clean)) return word.toUpperCase();
      if (i > 0 && small.has(clean)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

// Turn shorthand month tokens into readable form: "may-24" → "May 2024",
// "aug24" → "Aug 2024", "oct24" → "Oct 2024".
function humanizeDate(tail) {
  const MONTHS = { jan:"Jan", feb:"Feb", mar:"Mar", apr:"Apr", may:"May", jun:"Jun",
                   jul:"Jul", aug:"Aug", sep:"Sep", oct:"Oct", nov:"Nov", dec:"Dec" };
  const m = String(tail).toLowerCase().match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[-\s]?(\d{2,4})/);
  if (!m) return null;
  const month = MONTHS[m[1]];
  const yearRaw = m[2];
  const year = yearRaw.length === 2 ? "20" + yearRaw : yearRaw;
  return `${month} ${year}`;
}

// Clean a "workshop N …" tag into a readable label.
function cleanWorkshopName(raw) {
  const lc = String(raw || "").toLowerCase().trim();
  if (!lc.startsWith("workshop")) return titleCase(raw);

  // Extract workshop number if present ("workshop 12 …", "workshop 1h-…").
  const numMatch = lc.match(/^workshop\s+(\d+[a-z]?[-:]?)\s*[:—-]?\s*(.*)$/);
  // Also handles "workshop: some name" (no number).
  const noNumMatch = lc.match(/^workshop\s*:\s*(.*)$/);
  let num = null;
  let rest = null;
  if (numMatch && numMatch[1] && /\d/.test(numMatch[1])) {
    num = numMatch[1].replace(/[-:]$/, "").toUpperCase();
    rest = numMatch[2] || "";
  } else if (noNumMatch) {
    rest = noNumMatch[1] || "";
  } else {
    // Fallback: strip the "workshop" prefix and title-case what's left.
    rest = lc.replace(/^workshop\b/i, "").trim();
  }

  // Pull off a trailing date suffix like "may 24" / "-may24" / "sep-24".
  const dateInTail = humanizeDate(rest);
  if (dateInTail) {
    rest = rest.replace(/(?:[-\s]+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[-\s]?\d{2,4}\s*$/i, "").trim();
  }

  // Also strip an "- ads" suffix (means it was an ads-sourced workshop
  // announcement, not part of the workshop title).
  rest = rest.replace(/[-\s]+ads\s*$/i, "").trim();

  // Prettify the name portion.
  let name = titleCase(rest.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim());
  // Small tidy-up: replace ":" with " —" for "workshop N: name" style tags.
  name = name.replace(/^:\s*/, "");

  const parts = [];
  if (num) parts.push(`Workshop ${num}`);
  if (name) parts.push(name);
  let label = parts.join(" — ");
  if (dateInTail) label += ` (${dateInTail})`;
  return label || titleCase(raw);
}

// Simple pretty-printer for anything else.
function prettyTag(raw) {
  return titleCase(String(raw || "").replace(/[-_]/g, " ").replace(/\s+/g, " ").trim());
}

// ─── Categorization ────────────────────────────────────────────────

function classify(tags, neonState) {
  const raw = tags || [];
  const lower = raw.map((x) => String(x || "").toLowerCase().trim());
  const has = (needle) => lower.some((tag) => tag.includes(needle));
  const eq = (needle) => lower.includes(needle);

  // ── Programs & client status
  const programs = [];
  if (has("myp business club") || has("business club")) programs.push("MYP Business Club");
  if (eq("rise client") || eq("rise paused")) programs.push("RISE client (current)");
  if (has("past rise client") || has("rise past client") || has("rise graduate")) programs.push("Past RISE client");
  if (has("myp certificate") || has("myp cert") || has("coaching certification")) programs.push("MYP Certification");
  const isBookLaunchTeam = has("book launch team") || has("official book launch team");
  if (isBookLaunchTeam) programs.push("Book launch team");

  const isClient = eq("client") && !eq("workshop lead");
  const hadConsultation = has("consultation");

  // ── Purchases + Reset progression
  const purchases = [];
  if (has("power reset - purchased") || has("72-hour power reset - purchased") || has("the 72-hour power reset")) {
    purchases.push("72-Hour Power Reset");
  }
  if (has("power reset - student pre-launch")) {
    purchases.push("Power Reset (student pre-launch)");
  }
  if (has("the now shift - purchased") || has("now shift - purchased")) purchases.push("The Now Shift");
  if (has("unlimited - purchased")) purchases.push("The Field Unlimited");

  const coupons = [];
  if (has("used power50 code") || has("used power50 coupon")) coupons.push("POWER50");
  if (has("used launchteamunlimited") || has("launchteamunlimited")) coupons.push("LAUNCHTEAMUNLIMITED");

  // Power Reset progress — Neon is the source of truth, NOT GHL tags.
  // The GHL "completed day X" tags fire from Kajabi lesson clicks
  // (someone opened the Kajabi page) so they show as false positives
  // for members who never actually logged into the Field.
  const firstLogin = neonState && neonState.first_login_at ? new Date(neonState.first_login_at) : null;
  const neverLoggedIn = !firstLogin;
  const daysCompleted = Math.max(0, Math.min(3, Number(neonState && neonState.last_completed_day) || 0));

  // ── Workshops attended (numbered ones)
  // A "workshop lead" tag = source. A tag like "workshop N …" or
  // "workshop: some name" means attended (usually). Tags ending in
  // "- ads" are workshop-shaped LEAD SOURCE (someone saw a workshop ad),
  // not attendance — bucket those into source instead.
  const attendedWorkshops = [];
  const workshopLeadSources = [];
  for (const t of raw) {
    const lc = String(t || "").toLowerCase();
    if (!lc.startsWith("workshop")) continue;
    if (lc === "workshop lead") { workshopLeadSources.push("Workshop lead"); continue; }
    if (lc === "workshop form" || lc.startsWith("workshop form")) { workshopLeadSources.push("Workshop form"); continue; }
    if (/-\s*ads\s*$/.test(lc) || /\bads\b/.test(lc.replace(/\band\b/g, ""))) {
      // Workshop-shaped ad audience tag → source, not attendance.
      workshopLeadSources.push(cleanWorkshopName(t) + " (ad audience)");
      continue;
    }
    attendedWorkshops.push(cleanWorkshopName(t));
  }
  // Dedupe.
  const uniq = (arr) => Array.from(new Set(arr));

  // ── Live attendance (webinars, zoom, etc.)
  const liveAttendance = [];
  for (const t of raw) {
    const lc = String(t || "").toLowerCase();
    if (lc.includes("attended") && (lc.includes("live") || lc.includes("zoom"))) {
      liveAttendance.push(prettyTag(t.replace(/[-]/g, " ")));
    }
  }

  // ── Engagement signals
  const engagement = [];
  if (has("reset newly engaged")) engagement.push("Reset newly engaged");
  else if (has("newly engaged")) engagement.push("Newly engaged");
  if (has("engaging") || has("second engaging tag")) engagement.push("Engaging");
  if (has("high intent")) engagement.push("High intent");
  if (has("hot lead")) engagement.push("Hot lead");
  if (has("wa-paused-by-reply")) engagement.push("WhatsApp paused (they replied)");

  // ── Source / attribution
  // NOTE: "email list - in person event form" is NOT a source — it's the
  // segment we email when there's an in-person event coming up. Don't
  // add it here (Geo confirmed nobody actually came in via that path).
  const source = [];
  if (has("ads") || has("source - ads")) source.push("Ads");
  if (has("organic") || has("source - organic")) source.push("Organic");
  if (has("manychat") || has("source - manychat")) source.push("ManyChat");
  if (has("ignite 2025")) source.push("Ignite 2025");

  // ── Other worth noting — everything left over that isn't noise
  const NOISE = new Set([
    "org", "created account themselves",
    // In-person-event mailing-list segment tags. These aren't a source
    // or a meaningful signal for Carmen — just how the mailing list is
    // organised. Drop from every bucket.
    "email list - in person event form",
    "in person event email list",
    "in-person event email list",
    "in person event - email list",
    "client", "consultation",
    "myp business club", "business club",
    "rise client", "rise paused", "rise", "past rise client", "rise past client", "rise graduate",
    "myp certificate", "myp cert", "coaching certification",
    "newly engaged", "reset newly engaged", "engaging", "second engaging tag",
    "wa-paused-by-reply", "hot lead", "high intent",
    "ads", "organic", "source - ads", "source - organic", "source - manychat", "manychat",
    "ignite 2025",
    "book launch team", "official book launch team", "book launch",
    "used power50 code", "used power50 coupon (the power reset)", "used power50 coupon",
    "used launchteamunlimited", "launchteamunlimited",
    "power reset - purchased", "72-hour power reset - purchased", "the 72-hour power reset",
    "power reset - student pre-launch",
    "the now shift - purchased", "now shift - purchased",
    "unlimited - purchased",
    "workshop lead", "workshop form",
    "the 72-hour power reset - completed day 1",
    "the 72-hour power reset - completed day 2",
    "the 72-hour power reset - completed day 3",
    "72-hour power reset - completed day 1",
    "72-hour power reset - completed day 2",
    "72-hour power reset - completed day 3",
  ]);
  const other = [];
  for (const t of raw) {
    const lc = String(t || "").toLowerCase().trim();
    if (!lc) continue;
    if (NOISE.has(lc)) continue;
    // Already surfaced elsewhere:
    if (lc.startsWith("workshop")) continue;
    if (lc.includes("attended") && (lc.includes("live") || lc.includes("zoom"))) continue;
    other.push(prettyTag(t));
  }

  return {
    programs: uniq(programs),
    isClient,
    hadConsultation,
    purchases: uniq(purchases),
    coupons: uniq(coupons),
    neverLoggedIn,
    firstLogin,
    daysCompleted,
    attendedWorkshops: uniq(attendedWorkshops),
    workshopLeadSources: uniq(workshopLeadSources),
    liveAttendance: uniq(liveAttendance),
    engagement: uniq(engagement),
    source: uniq(source),
    other: uniq(other),
  };
}

// ─── Formatter — plain English, no jargon ─────────────────────────

function formatSummary(c, sourceHint) {
  const sections = [];

  // Product & progress. Progress is derived from the Neon `users` row,
  // NOT GHL tags — because "completed day X" tags in GHL fire from
  // Kajabi lesson clicks even when the member never actually logged
  // into the Field.
  const productLines = [];
  if (c.purchases.length) {
    for (const p of c.purchases) productLines.push(`• Bought ${p}`);
  } else {
    productLines.push("• No purchase on file (lead only)");
  }
  if (c.coupons.length) {
    productLines.push(`• Used coupon: ${c.coupons.join(", ")}`);
  }
  // Field usage — honest state
  if (c.purchases.length) {
    if (c.neverLoggedIn) {
      productLines.push("• Bought but has never logged into the Field ⚠️");
    } else if (c.daysCompleted === 3) {
      productLines.push("• Completed all 3 days of the Power Reset ✓");
    } else if (c.daysCompleted > 0) {
      productLines.push(`• Completed Day ${c.daysCompleted} in the Field (stalled after that)`);
    } else if (c.firstLogin) {
      const daysAgo = Math.max(0, Math.floor((Date.now() - c.firstLogin.getTime()) / 86400000));
      productLines.push(`• Logged in ${daysAgo === 0 ? "today" : daysAgo + " day(s) ago"} but hasn't completed Day 1 yet`);
    }
  }
  if (c.isClient) productLines.push("• Active client");
  if (c.hadConsultation) productLines.push("• Had a consultation call");
  if (productLines.length) {
    sections.push("Product & progress\n" + productLines.join("\n"));
  }

  // Programs
  if (c.programs.length) {
    sections.push("Programs\n" + c.programs.map((p) => `• ${p}`).join("\n"));
  }

  // Workshops attended
  if (c.attendedWorkshops.length) {
    const header = c.attendedWorkshops.length === 1
      ? "Workshop attended"
      : `Workshops attended (${c.attendedWorkshops.length})`;
    sections.push(header + "\n" + c.attendedWorkshops.map((w) => `• ${w}`).join("\n"));
  }

  // Live attendance
  if (c.liveAttendance.length) {
    sections.push("Attended live\n" + c.liveAttendance.map((a) => `• ${a}`).join("\n"));
  }

  // Engagement
  if (c.engagement.length) {
    sections.push("Engagement signals\n" + c.engagement.map((e) => `• ${e}`).join("\n"));
  }

  // How they came in
  const sourceParts = c.source.slice();
  if (c.workshopLeadSources.length) {
    for (const s of c.workshopLeadSources) sourceParts.push(s);
  }
  if (sourceHint && !sourceParts.some((s) => s.toLowerCase() === String(sourceHint).toLowerCase())) {
    sourceParts.push(sourceHint);
  }
  if (sourceParts.length) {
    sections.push("How they came in\n" + sourceParts.map((s) => `• ${s}`).join("\n"));
  }

  // Anything else — cap so the sheet stays readable
  if (c.other.length) {
    const shown = c.other.slice(0, 8);
    const overflow = c.other.length - 8;
    const lines = shown.map((o) => `• ${o}`);
    if (overflow > 0) lines.push(`• …and ${overflow} more`);
    sections.push("Other context\n" + lines.join("\n"));
  }

  return sections.join("\n\n");
}

// ─── Handler ────────────────────────────────────────────────────────

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

  // Join with the users table so we can derive real Field progress from
  // Neon (first_login_at, last_completed_day) instead of trusting GHL's
  // "completed day X" tags — which are triggered by Kajabi lesson clicks
  // and produce false positives for members who never actually logged in.
  const { rows } = await sql`
    SELECT
      LOWER(mgt.email)    AS email,
      mgt.tags            AS tags,
      mgt.source          AS source,
      u.first_login_at    AS first_login_at,
      u.last_completed_day AS neon_last_completed_day,
      u.kajabi_entitled   AS kajabi_entitled
    FROM member_ghl_tags mgt
    LEFT JOIN users u ON LOWER(u.email) = LOWER(mgt.email)
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
      const neonState = {
        first_login_at: row.first_login_at,
        last_completed_day: row.neon_last_completed_day,
      };
      const classified = classify(tags, neonState);
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
Idempotent — safe to re-run.
==============================================================================

ALTER TABLE member_cheat_sheets
  ADD COLUMN IF NOT EXISTS tag_summary TEXT;
*/
