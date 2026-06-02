// lib/prompts/index.js
// Day-prompt selector + Unlimited prompt export. Pure function. No I/O.

import { DAY1_SYSTEM_PROMPT } from "./day1.js";
import { DAY2_SYSTEM_PROMPT } from "./day2.js";
import { DAY3_SYSTEM_PROMPT } from "./day3.js";
import { UNLIMITED_SYSTEM_PROMPT } from "./unlimited.js";

const PROMPTS = {
  1: DAY1_SYSTEM_PROMPT,
  2: DAY2_SYSTEM_PROMPT,
  3: DAY3_SYSTEM_PROMPT,
};

export function getSystemPromptForDay(dayNumber) {
  const day = Number(dayNumber);
  if (![1, 2, 3].includes(day)) {
    throw new Error(`Invalid day number: ${dayNumber}. Must be 1, 2, or 3.`);
  }
  return PROMPTS[day];
}

export function getUnlimitedSystemPrompt() {
  return UNLIMITED_SYSTEM_PROMPT;
}

// Version hash for observability. Bump on prompt changes so historical
// messages can be correlated to the prompt version that produced them.
export const PROMPT_VERSION = "v5.7-dream-reading-phase6-tightened";
