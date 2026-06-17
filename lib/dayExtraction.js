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

// Heuristic markers per day. If the assistant reply contains ANY of these
// strings, we fire the Haiku extraction call. Drawn directly from the final
// output sections of day1.js / day2.js / day3.js so they stay in sync with
// what the production system prompts ask the model to emit.
const COMPLETION_MARKERS = {
  1: [
    "YOUR DAY 1 STATE RESET",
    "State Reset complete.",
  ],
  2: [
    "DAY 2 RECORD — DECISION AND ACTION ALIGNMENT",
    "LIVING POWER DECLARATION",
  ],
  3: [
    "DAY 3 RECORD — POWER FREQUENCY CALIBRATION",
    "72 Hour Power Reset complete",
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

// Fields each day MUST have populated for the completion to count. If any
// of these is empty after extraction, we skip the record (strict mode).
const REQUIRED_FIELDS = {
  1: ["current_state", "active_pattern", "stabilizing_action", "sentence_to_day2"],
  2: ["decision", "action", "commitment_statement", "living_power_declaration"],
  3: ["desired_reality", "determined_imagination_scene", "return_thought"],
};

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
  const markers = COMPLETION_MARKERS[day] || [];
  return markers.some((m) => text.includes(m));
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
  if (data.is_completion !== true) {
    return null; // Haiku decided this isn't a real completion
  }

  // Strict mode — every required field must be a non-empty string.
  const required = REQUIRED_FIELDS[day] || [];
  for (const field of required) {
    const value = data[field];
    if (!value || (typeof value === "string" && value.trim().length === 0)) {
      console.warn("extract_strict_reject", { day, missing_field: field });
      return null;
    }
  }

  // Drop the gate flag — we don't need it in storage.
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

    const data = await extractDayCompletion(assistantMessage, day);
    if (!data) return null;

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
