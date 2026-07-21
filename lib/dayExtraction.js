// lib/dayExtraction.js
// Auto-extract Day 1/2/3 completion data from assistant messages.
//
// Pipeline (cheap → expensive):
//   1. Fast string-contains heuristic per day. ~Free, runs on every reply.
//   2. If heuristic hits, fire a Haiku call with tool_use to extract the
//      structured fields from the message. ~$0.002 per completion.
//   3. If extraction succeeds and required fields are non-empty, call
//      recordDayCompletion() which inserts the day_completions row AND
//      atomically bumps users.last_completed_day in one CTE.
//
// Strict mode: if ANY required field is empty/missing, skip the record.
// Partial data is worse than no data — the extraction-plan doc calls this
// "default to strict" because the model depends on these being commitments.
//
// Failure: log and continue. Never throw out of maybeRecordDayCompletion —
// the chat reply must always reach the user, even if extraction fails.

import { recordDayCompletion } from "./db.js";

const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const SCHEMA_VERSION = 1;

// Heuristic markers per day. Matched CASE-INSENSITIVELY against the
// assistant reply. Drawn from final output sections of day1.js / day2.js /
// day3.js PLUS observed production wording variants — the model sometimes
// uses title case instead of the all-caps spec ("Living Power Declaration"
// instead of "LIVING POWER DECLARATION") and adds wrap-up phrasing not in
// the original prompt. We match any of these so real completions don't
// silently slip through.
// Markers: cheap first-pass filter. Keep ONLY phrases that are unique to
// the final structured output block for each day. Theme words that appear
// in ordinary conversation ("Decision & Action", "Commitment Statement",
// "Mind, Heart, Body") are OUT — Sandra Venere hit that trap on 2026-07-21,
// getting auto-advanced to Day 3 mid-Day-2 because the AI used the phrase
// "Decision & Action" while explaining what Day 2 is about.
//
// Bias: prefer FALSE NEGATIVES. If auto-detection misses, the member can
// click the prominent "Complete Day X →" button to advance manually. If
// auto-detection over-fires, the member gets pushed to the wrong day and
// hits the wrong-day guardrail with no easy recovery path.
const COMPLETION_MARKERS = {
  1: [
    "YOUR DAY 1 STATE RESET",
    "Day 1 State Reset",
    "State Reset complete",
    "I AM Activation",
    "Sentence to Carry into Day 2",
    "Self-Led Orientation",
    "I-Am Statement",
    "Day 1 record",
    "Day 1 complete",
    "Day 1 is complete",
    "Day 1 of the Reset is complete",
  ],
  2: [
    "DAY 2 RECORD",
    "DECISION AND ACTION ALIGNMENT",
    "LIVING POWER DECLARATION",
    "Living Power Declaration",
    "Your Living Power Declaration",
    "Day 2 complete",
    "Day 2 is complete",
    "Day 2 of the Reset is complete",
    "Decision and Action complete",
  ],
  3: [
    "DAY 3 RECORD",
    "POWER FREQUENCY CALIBRATION",
    "DETERMINED IMAGINATION SCENE",
    "Determined Imagination Scene",
    "72 HOUR POWER RESET — COMPLETE",
    "72 Hour Power Reset complete",
    "72-hour Power Reset is complete",
    "The Reset is complete",
    "Frequency Calibration complete",
    "Day 3 complete",
    "Day 3 is complete",
  ],
};

// JSON schemas the Haiku tool call must conform to. Field names mirror the
// final-output templates in the system prompts so the AI extracts the same
// labels into typed JSON. Required fields are the ones that, if missing,
// mean the message wasn't actually a completion (just a mention).
const DAY_SCHEMAS = {
  1: {
    type: "object",
    properties: {
      is_completion: { type: "boolean", description: "True only if this assistant message contains the full structured Day 1 State Reset final output. False for any message that merely discusses Day 1 or references the structure." },
      current_state: { type: "string" },
      active_pattern: { type: "string" },
      what_directs: { type: "string" },
      true_underneath: { type: "string" },
      i_am_statements: { type: "array", items: { type: "string" } },
      self_led_orientation: { type: "string" },
      stabilizing_action: { type: "string" },
      activation_says: { type: "string" },
      sentence_to_day2: { type: "string" },
    },
    required: ["is_completion"],
  },
  2: {
    type: "object",
    properties: {
      is_completion: { type: "boolean", description: "True only if this assistant message contains the full structured Day 2 Record + Living Power Declaration. False otherwise." },
      decision: { type: "string" },
      resistance: { type: "string" },
      mind: { type: "string" },
      heart: { type: "string" },
      body: { type: "string" },
      action: { type: "string" },
      time: { type: "string" },
      place: { type: "string" },
      if_pattern_pulls: { type: "string" },
      daily_practice: { type: "string" },
      commitment_statement: { type: "string" },
      living_power_declaration: { type: "string" },
    },
    required: ["is_completion"],
  },
  3: {
    type: "object",
    properties: {
      is_completion: { type: "boolean", description: "True only if this assistant message contains the full structured Day 3 Record + Determined Imagination Scene. False otherwise." },
      commitment_from_day2: { type: "string" },
      desired_reality: { type: "string" },
      current_emotional_tone: { type: "string" },
      current_inner_conversation: { type: "string" },
      desired_emotional_tone: { type: "string" },
      desired_inner_conversation: { type: "string" },
      triggers: { type: "string" },
      determined_imagination_scene: { type: "string" },
      return_thought: { type: "string" },
      daily_practice_time: { type: "string" },
    },
    required: ["is_completion"],
  },
};

// Required fields disabled. In production the AI sometimes uses different
// section labels than the spec template ("Your Return Phrase" instead of
// "Return thought", etc.), so a per-field strict check was rejecting real
// completions. Haiku's own is_completion=true decision is now the only gate,
// which it bases on the overall structure and content. False positives are
// caught by the heuristic still requiring at least one strong day-specific
// marker to even fire the Haiku call.
const REQUIRED_FIELDS = { 1: [], 2: [], 3: [] };

const EXTRACTION_SYSTEM_PROMPT = `You are a structured-data extractor for The Freedom Intelligence Field.

The user will paste an assistant message from the 72-Hour Power Reset chat. Your job: determine whether the message contains the FULL structured final output for Day {day}, and if so, extract every named field into typed JSON.

Rules:
- Set is_completion = true ONLY if the message contains the complete structured Day {day} record AS THE ACTUAL FINAL OUTPUT (not as a quoted example, instruction, or reference).
- Set is_completion = false if the message is mid-conversation, only mentions the structure, or is missing required fields.
- For each field, extract the participant's actual words from the message verbatim. Do not paraphrase or summarize.
- If a field is missing or empty in the source, leave that property out (rather than emitting an empty string).

Use the extract_completion tool to return your result.`;

/**
 * Fast heuristic — does this look like a day completion at all?
 * Free. Runs on every assistant reply. Returns true if any of the per-day
 * markers appears in the text, which means we should fire the extraction.
 */
export function looksLikeDayCompletion(text, day) {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase();
  const markers = COMPLETION_MARKERS[day] || [];
  return markers.some((m) => lower.includes(m.toLowerCase()));
}

/**
 * Haiku call with tool_use to pull structured fields out of an assistant
 * message. Returns the parsed JSON object, or null if Haiku says it isn't
 * actually a completion / extraction failed / strict-mode rejected.
 */
export async function extractDayCompletion(text, day) {
  const schema = DAY_SCHEMAS[day];
  if (!schema) return null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("extract_no_api_key");
    return null;
  }

  const systemPrompt = EXTRACTION_SYSTEM_PROMPT.replaceAll("{day}", String(day));

  let response;
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2500,
        system: systemPrompt,
        tools: [
          {
            name: "extract_completion",
            description: `Extract the Day ${day} structured final output into typed JSON. Set is_completion=false if this isn't a true completion.`,
            input_schema: schema,
          },
        ],
        tool_choice: { type: "tool", name: "extract_completion" },
        messages: [
          {
            role: "user",
            content: `Extract the Day ${day} final output from this assistant message:\n\n---\n\n${text}\n\n---`,
          },
        ],
      }),
    });
  } catch (err) {
    console.error("extract_network_error", { message: err?.message, day });
    return null;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error("extract_non_2xx", { status: response.status, day, body: body.slice(0, 300) });
    return null;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  // Find the tool_use block in the assistant's response.
  const block = (payload.content || []).find((b) => b.type === "tool_use");
  if (!block || !block.input) {
    console.warn("extract_no_tool_use_block", { day });
    return null;
  }

  const data = block.input;
  // is_completion is the hard gate. Haiku is much better at
  // "is this the actual final structured output vs. an incidental mention"
  // than substring matching. If Haiku says no, we skip the record.
  //
  // Previously removed because loose heuristic markers were catching
  // mid-conversation mentions and Haiku correctly rejected them, so
  // completions "looked missed." Real fix was to tighten the heuristic
  // markers (see COMPLETION_MARKERS above), not disable Haiku's judgment.
  // Re-instated 2026-07-21 after Sandra Venere got auto-advanced to Day 3
  // during a Day 2 chat.
  if (data.is_completion !== true) {
    console.log("extract_haiku_rejected", { day, reason: "is_completion=false" });
    return null;
  }
  delete data.is_completion;
  return data;
}

/**
 * Composite — heuristic + extraction + record, all in one. Call this from
 * the chat handler after persisting an assistant message. Never throws.
 * Returns the day_completions row that was inserted, or null if nothing
 * was recorded (not a completion, extraction failed, or already recorded).
 */
export async function maybeRecordDayCompletion({
  assistantMessage,
  day,
  userId,
  sessionId,
  messageId,
}) {
  try {
    if (!day || day < 1 || day > 3) return null;
    if (!looksLikeDayCompletion(assistantMessage, day)) return null;

    // Fail closed. Only record if Haiku EXTRACTED successfully AND
    // confirmed via is_completion=true (checked inside extractDayCompletion).
    // If Haiku fails (network / rate limit / schema rejection) or says
    // this isn't a real completion, we skip the record. The member can
    // click the "Complete Day X →" button to advance manually — a much
    // better failure mode than auto-pushing them to the wrong day.
    let data;
    try {
      data = await extractDayCompletion(assistantMessage, day);
    } catch (err) {
      console.warn("extract_failed_skipping_record", {
        message: err?.message, day, userId,
      });
      return null;
    }
    if (!data) {
      console.log("extract_returned_null_skipping_record", { day, userId });
      return null;
    }

    const row = await recordDayCompletion({
      userId,
      sessionId,
      day,
      data,
      schemaVersion: SCHEMA_VERSION,
      messageId: messageId || null,
    });
    console.log("day_completion_recorded", { userId, day, messageId });
    return row;
  } catch (err) {
    console.error("day_completion_record_failed", {
      message: err?.message,
      day,
      userId,
    });
    return null;
  }
}
