// lib/memory.js
// Cross-process participant memory for The Field. Builds a single text
// block the AI sees on every chat turn so it remembers what the user
// has said, decided, and worked on across every process — Reset and
// Unlimited combined.
//
// The block layers four sources of memory, from most-durable to most-
// recent:
//
//   1. Profile basics (name, tier, joined, days completed)
//   2. Structured Day completions (decisions, declarations, actions —
//      the typed fields already in day_completions.data)
//   3. Durable facts auto-extracted from chats (memory_summaries.kind
//      = 'profile_fact') — see extractDurableFacts() below
//   4. A roster of past Unlimited processes they've run, with dates
//
// Loaded by api/chat.js and api/unlimited/chat.js and injected at the
// top of the system prompt. Together with the existing message-history
// memory, this means the Field no longer asks "what's your name?" or
// "what did you decide?" twice — every chat starts with the full
// picture.

import { sql } from "@vercel/postgres";
import { getProcessByKey } from "./prompts/processes/index.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const EXTRACT_MODEL = "claude-haiku-4-5-20251001";

// =============================================================================
// LOAD — assemble the memory block for a given user
// =============================================================================

/**
 * Build a single text block summarising everything the Field knows about
 * this participant, ready to be appended to a system prompt.
 *
 * Safe to call on every chat turn — all queries are indexed lookups on
 * user_id. Returns an empty-feeling string for brand-new users so the
 * AI knows to introduce itself naturally instead of acting like it has
 * memory it doesn't.
 */
export async function loadUserMemory(userId) {
  if (!userId) return "";

  // Fire the four reads in parallel — they're independent.
  const [profile, completions, facts, processHistory] = await Promise.all([
    loadProfile(userId),
    loadDayCompletions(userId),
    loadDurableFacts(userId),
    loadProcessHistory(userId),
  ]);

  // FALLBACK: for any Reset day that has messages but NO formal completion
  // row (the marker-detection heuristic missed the final structured output),
  // pull a raw recap of that day's conversation so prior-day context is
  // never lost. This is what makes "the Field remembers everything" feel
  // true even when our auto-detection silently fails.
  const recordedDays = new Set((completions || []).map((c) => Number(c.day)));
  const missingDays = [1, 2, 3].filter((d) => !recordedDays.has(d));
  const dayRecaps = await loadFallbackDayRecaps(userId, missingDays);

  return renderMemoryBlock({ profile, completions, facts, processHistory, dayRecaps });
}

/**
 * Pull a compressed recap of each missing Reset day's conversation. Used
 * as a fallback when day_completions has no row for a day — usually
 * because the AI's final reply didn't trip the structured-output marker
 * heuristic (which is brittle and easy to miss).
 *
 * Returns a map { dayNum: recapText }. Empty object if no missing days
 * or no messages for those days.
 *
 * Cheap: one query per missing day, capped at the last 20 messages per
 * day, indexed lookup on (user_id, day_at_send).
 */
async function loadFallbackDayRecaps(userId, missingDays) {
  if (!Array.isArray(missingDays) || missingDays.length === 0) return {};
  const recaps = {};
  for (const day of missingDays) {
    const { rows } = await sql`
      SELECT role, content, created_at
      FROM messages
      WHERE user_id = ${userId}
        AND day_at_send = ${day}
        AND role IN ('user', 'assistant')
      ORDER BY created_at DESC
      LIMIT 20
    `;
    if (rows.length < 2) continue; // skip empty / one-message days

    // We sliced DESC + LIMIT 20 to keep only the LAST 20 messages (the
    // closing portion of that day's work is the most contextful). Now
    // reverse to chronological so the AI reads it naturally.
    const ordered = rows.reverse();

    // Build a compact verbatim transcript. Truncate per-message at 500
    // chars so a single long reply doesn't blow the budget. Prefix each
    // turn with role for clarity.
    const transcript = ordered
      .map((m) => {
        const who = m.role === "user" ? "Them" : "Field";
        const text = String(m.content || "").trim().slice(0, 500);
        return `${who}: ${text}`;
      })
      .join("\n\n");

    recaps[day] = transcript;
  }
  return recaps;
}

async function loadProfile(userId) {
  const { rows } = await sql`
    SELECT display_name, email, tier::text AS tier,
           subscription_plan, first_login_at, created_at,
           COALESCE(last_completed_day, 0) AS last_completed_day
    FROM users
    WHERE id = ${userId}
    LIMIT 1
  `;
  return rows[0] || null;
}

async function loadDayCompletions(userId) {
  const { rows } = await sql`
    SELECT day, data, completed_at
    FROM day_completions
    WHERE user_id = ${userId}
    ORDER BY day ASC
  `;
  return rows;
}

async function loadDurableFacts(userId) {
  // Pull every profile_fact for this user, newest first. We cap at 30
  // because once we're past the most-recent 30 personal facts, the
  // older ones tend to be either stale or already implied by the
  // newer ones. The cap also keeps token cost predictable per turn.
  const { rows } = await sql`
    SELECT content, created_at, kind
    FROM memory_summaries
    WHERE user_id = ${userId}
      AND kind = 'profile_fact'
    ORDER BY created_at DESC
    LIMIT 30
  `;
  return rows;
}

async function loadProcessHistory(userId) {
  // Distinct list of Unlimited processes the user has launched, with
  // the most recent run timestamp. Skips chats with no metadata.process
  // (free-form Unlimited chat) and the current session naturally falls
  // out because metadata.process is set on first activation.
  const { rows } = await sql`
    SELECT (metadata->>'process') AS process_key,
           MAX(COALESCE(last_message_at, started_at)) AS last_run_at,
           COUNT(*)::int AS times_run
    FROM sessions
    WHERE user_id = ${userId}
      AND session_type = 'unlimited'
      AND metadata->>'process' IS NOT NULL
    GROUP BY metadata->>'process'
    ORDER BY last_run_at DESC
    LIMIT 30
  `;
  return rows;
}

// =============================================================================
// RENDER — turn the four sources into a single text block
// =============================================================================

function renderMemoryBlock({ profile, completions, facts, processHistory, dayRecaps }) {
  // Brand new participant — nothing to say. Return an empty block so
  // the AI prompt-assembly logic can detect "no prior memory" and adapt
  // its opening tone.
  const hasRecaps = dayRecaps && Object.keys(dayRecaps).length > 0;
  const hasAnything =
    (completions && completions.length > 0) ||
    (facts && facts.length > 0) ||
    (processHistory && processHistory.length > 0) ||
    hasRecaps;
  if (!hasAnything && !profile) return "";

  const sections = [];

  // --- Profile block ---
  if (profile) {
    const lines = [];
    if (profile.display_name) lines.push(`Name they go by: ${profile.display_name}`);
    if (profile.tier === "full") {
      const plan = profile.subscription_plan ? ` (${profile.subscription_plan})` : "";
      lines.push(`Member level: Unlimited${plan}`);
    } else if (profile.tier === "preview") {
      lines.push(`Member level: 72-Hour Power Reset (preview)`);
    }
    if (profile.first_login_at) {
      lines.push(`First logged in: ${formatDate(profile.first_login_at)}`);
    }
    if (profile.last_completed_day > 0) {
      lines.push(`Completed: Day ${profile.last_completed_day} of the Reset`);
    }
    if (lines.length > 0) {
      sections.push("**Who they are:**\n" + lines.join("\n"));
    }
  }

  // --- Structured day completions ---
  if (completions && completions.length > 0) {
    const dayBlocks = completions
      .map((c) => renderDayCompletion(c))
      .filter(Boolean);
    if (dayBlocks.length > 0) {
      sections.push(
        "**Their Reset work (verbatim from their own completions):**\n\n" +
          dayBlocks.join("\n\n")
      );
    }
  }

  // --- Fallback recaps for days with messages but no formal completion ---
  // This is what makes "the Field remembers everything" hold up even when
  // our auto-detection missed the structured output. The AI sees the raw
  // conversation and can extract whatever's relevant.
  if (hasRecaps) {
    const recapBlocks = Object.keys(dayRecaps)
      .sort((a, b) => Number(a) - Number(b))
      .map((day) => {
        return `### Day ${day} conversation recap (no formal completion was recorded — pull anything meaningful from this transcript when relevant):\n\n${dayRecaps[day]}`;
      });
    sections.push(
      "**Recent conversation history from prior Reset days:**\n\n" +
        recapBlocks.join("\n\n---\n\n")
    );
  }

  // --- Durable facts auto-extracted from past chats ---
  if (facts && facts.length > 0) {
    const factLines = facts.map((f) => `- ${f.content}`).join("\n");
    sections.push(
      "**Facts they've shared in past chats:**\n" + factLines
    );
  }

  // --- Process history ---
  if (processHistory && processHistory.length > 0) {
    const procLines = processHistory.map((p) => {
      const proc = getProcessByKey(p.process_key);
      const name = proc ? proc.displayName : p.process_key;
      const when = formatRelative(p.last_run_at);
      const count = p.times_run > 1 ? ` · run ${p.times_run}×` : "";
      return `- ${name}${count} (last: ${when})`;
    }).join("\n");
    sections.push(
      "**Processes they've already done in The Field:**\n" + procLines
    );
  }

  if (sections.length === 0) return "";

  return [
    "## WHAT THE FIELD ALREADY KNOWS ABOUT THIS PARTICIPANT",
    "",
    "This is silent context loaded from every prior chat, day, and process " +
      "across The Field. Use it ACTIVELY:",
    "",
    "  • Call them by name. Never re-ask facts they've already shared.",
    "  • When opening a new day or process, reference what they did in the " +
      "prior day/process and build on it (e.g. 'Yesterday you decided X — " +
      "today we take that into Y'). Don't ask them to re-derive prior work.",
    "  • If prior-day work is in the recap section below (no formal " +
      "completion row), READ THE TRANSCRIPT and pull whatever's meaningful " +
      "yourself — declarations, decisions, actions, patterns named. Do not " +
      "say 'your prior work isn't showing here' or ask them to recall it. " +
      "It IS here, in the transcript. Read it.",
    "  • NEVER recite this block back verbatim or list it as a summary. " +
      "Reference it naturally, the way a coach who remembers you would.",
    "",
    "The participant cannot see any of this. To them, it feels like the " +
      "Field simply remembers them — every word, every day, every process.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

function renderDayCompletion(c) {
  const d = c.data || {};
  const lines = [`### Day ${c.day} (${formatDate(c.completed_at)})`];

  if (c.day === 1) {
    if (d.current_state) lines.push(`- Current state named: "${d.current_state}"`);
    if (d.active_pattern) lines.push(`- Active pattern: "${d.active_pattern}"`);
    if (d.true_underneath) lines.push(`- True underneath: "${d.true_underneath}"`);
    if (Array.isArray(d.i_am_statements) && d.i_am_statements.length > 0) {
      lines.push(`- I-am statements: ${d.i_am_statements.map(s => `"${s}"`).join(", ")}`);
    }
    if (d.self_led_orientation) lines.push(`- Self-led orientation: "${d.self_led_orientation}"`);
    if (d.stabilizing_action) lines.push(`- Stabilizing action: "${d.stabilizing_action}"`);
  }

  if (c.day === 2) {
    if (d.decision) lines.push(`- Decision: "${d.decision}"`);
    if (d.resistance) lines.push(`- Resistance: "${d.resistance}"`);
    if (d.mind) lines.push(`- Mind: "${d.mind}"`);
    if (d.heart) lines.push(`- Heart: "${d.heart}"`);
    if (d.body) lines.push(`- Body: "${d.body}"`);
    if (d.action) lines.push(`- Action committed: "${d.action}"`);
    if (d.time) lines.push(`- Time: "${d.time}"`);
    if (d.place) lines.push(`- Place: "${d.place}"`);
    if (d.daily_practice) lines.push(`- Daily practice: "${d.daily_practice}"`);
    if (d.commitment_statement) lines.push(`- Commitment statement: "${d.commitment_statement}"`);
    if (d.living_power_declaration) lines.push(`- Living Power Declaration: "${d.living_power_declaration}"`);
  }

  if (c.day === 3) {
    if (d.desired_reality) lines.push(`- Desired reality: "${d.desired_reality}"`);
    if (d.current_emotional_tone) lines.push(`- Current emotional tone: "${d.current_emotional_tone}"`);
    if (d.desired_emotional_tone) lines.push(`- Desired emotional tone: "${d.desired_emotional_tone}"`);
    if (d.desired_inner_conversation) lines.push(`- Desired inner conversation: "${d.desired_inner_conversation}"`);
    if (d.triggers) lines.push(`- Known triggers: "${d.triggers}"`);
    if (d.determined_imagination_scene) lines.push(`- Imagination scene: "${d.determined_imagination_scene}"`);
    if (d.return_thought) lines.push(`- Return thought: "${d.return_thought}"`);
    if (d.daily_practice_time) lines.push(`- Daily practice time: "${d.daily_practice_time}"`);
  }

  // Only emit a block if at least one structured field was present —
  // otherwise we'd output an empty Day heading on completion rows that
  // failed to extract typed data.
  if (lines.length <= 1) return null;
  return lines.join("\n");
}

function formatDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (!isFinite(dt.getTime())) return "";
  return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatRelative(d) {
  if (!d) return "unknown";
  const dt = new Date(d).getTime();
  if (!isFinite(dt)) return "unknown";
  const diffMs = Date.now() - dt;
  const days = Math.floor(diffMs / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return formatDate(d);
}

// =============================================================================
// EXTRACT — pull durable facts out of a user message after each turn
// =============================================================================

// Heuristic gate. We only fire the Haiku call if the user message looks
// like it might contain something durable about them — a name, a role,
// a relationship, a pattern they're identifying with. Saves ~80% of
// extraction calls (most chat turns are "yes", "I felt that", "ok",
// or process-step responses that don't reveal facts).
const FACT_INDICATORS = [
  /\bmy\b/i,
  /\bI'?m a\b/i,
  /\bI am a\b/i,
  /\bI work as\b/i,
  /\bI live\b/i,
  /\bI have\b/i,
  /\bmy partner\b/i,
  /\bmy husband\b/i,
  /\bmy wife\b/i,
  /\bmy kids?\b/i,
  /\bmy son\b/i,
  /\bmy daughter\b/i,
  /\bmy mom\b/i,
  /\bmy mother\b/i,
  /\bmy dad\b/i,
  /\bmy father\b/i,
  /\bmy boss\b/i,
  /\bmy job\b/i,
  /\bmy business\b/i,
  /\bmy company\b/i,
  /\bmy team\b/i,
  /\bmy friend\b/i,
  /\bmy name is\b/i,
  /\bcall me\b/i,
  /\bI live in\b/i,
  /\bI come from\b/i,
  /\byears old\b/i,
  /\bI always\b/i,
  /\bI never\b/i,
  /\bI keep\b/i,
];

export function looksLikeFactSharing(userMessage) {
  if (!userMessage || typeof userMessage !== "string") return false;
  if (userMessage.length < 12) return false;
  return FACT_INDICATORS.some((re) => re.test(userMessage));
}

const EXTRACTION_SYSTEM = `You extract DURABLE PERSONAL FACTS from a participant's message in a coaching chat.

A "durable fact" is something that will remain true about this person for weeks or months:
- Their name or nickname
- Family / relationships (partner's name, kids' ages, parents)
- Work / role / business / industry
- Location they live in
- A pattern they keep naming about themselves
- A long-standing belief, identity statement, or recurring struggle they reference

NOT durable facts:
- How they feel right now ("I'm anxious today")
- A single event that happened today
- The process-step answer they're giving (e.g. "my decision is X" — that's already captured separately)
- Hypotheticals or someone else's situation

For each durable fact, return a short third-person statement (e.g. "Has two kids, ages 8 and 11", "Works as a graphic designer in Berlin", "Goes by Sam, prefers they/them pronouns").

If the message contains NO durable facts, return an empty array — do not strain to find one. False positives degrade the memory.`;

const FACT_TOOL = {
  name: "record_facts",
  description: "Record zero or more durable personal facts extracted from the message.",
  input_schema: {
    type: "object",
    properties: {
      facts: {
        type: "array",
        description: "Each fact as a short third-person statement (under 120 chars). Empty array if nothing durable.",
        items: { type: "string" },
      },
    },
    required: ["facts"],
  },
};

/**
 * Run Haiku against a single user message to pull durable facts. Returns
 * an array of strings, possibly empty. Never throws — failures return [].
 */
export async function extractDurableFacts(userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        max_tokens: 400,
        system: EXTRACTION_SYSTEM,
        tools: [FACT_TOOL],
        tool_choice: { type: "tool", name: "record_facts" },
        messages: [
          { role: "user", content: userMessage.slice(0, 2000) },
        ],
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const toolUse = (data.content || []).find((b) => b.type === "tool_use");
    if (!toolUse) return [];
    const facts = (toolUse.input && Array.isArray(toolUse.input.facts))
      ? toolUse.input.facts
      : [];
    return facts
      .map((f) => String(f || "").trim())
      .filter((f) => f.length > 0 && f.length <= 160);
  } catch (e) {
    console.warn("extractDurableFacts_failed", e?.message);
    return [];
  }
}

/**
 * Idempotent-ish save. If a near-identical fact already exists for this
 * user (same lowercased content), we skip. Otherwise insert a new row.
 *
 * "Near-identical" uses exact lowercase match, not fuzzy. We'd rather
 * occasionally store two variants of the same fact than miss a new one.
 */
export async function saveDurableFacts({ userId, messageId, facts }) {
  if (!userId || !Array.isArray(facts) || facts.length === 0) return 0;
  let saved = 0;
  for (const fact of facts) {
    const trimmed = String(fact || "").trim();
    if (!trimmed) continue;
    const { rows: existing } = await sql`
      SELECT 1 FROM memory_summaries
      WHERE user_id = ${userId}
        AND kind = 'profile_fact'
        AND LOWER(content) = LOWER(${trimmed})
      LIMIT 1
    `;
    if (existing.length > 0) continue;
    await sql`
      INSERT INTO memory_summaries (
        user_id, kind, content, source_message_ids, period_start, period_end
      ) VALUES (
        ${userId},
        'profile_fact',
        ${trimmed},
        ${messageId ? [messageId] : []}::uuid[],
        NOW(),
        NOW()
      )
    `;
    saved++;
  }
  return saved;
}

/**
 * Composite. Heuristic gate → extract → save. Never throws. Call this
 * after persisting a user message; it runs entirely in the background
 * from the caller's POV and the chat response doesn't wait on it.
 *
 * Returns the count of newly-saved facts, or 0 if nothing was extracted.
 */
export async function maybeRecordDurableFacts({ userMessage, userId, messageId }) {
  try {
    if (!looksLikeFactSharing(userMessage)) return 0;
    const facts = await extractDurableFacts(userMessage);
    if (facts.length === 0) return 0;
    return await saveDurableFacts({ userId, messageId, facts });
  } catch (e) {
    console.warn("maybeRecordDurableFacts_failed", e?.message);
    return 0;
  }
}
