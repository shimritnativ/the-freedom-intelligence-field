// lib/prompts/processes/index.js
// Registry of the guided processes available inside The Field Unlimited.
import { ABUNDANCE_PROJECTION_SYSTEM_PROMPT } from "./abundance-projection.js";
import { DECISION_ALIGNMENT_SYSTEM_PROMPT } from "./decision-alignment.js";
import { DESIRED_OUTCOME_SNAPSHOT_SYSTEM_PROMPT } from "./desired-outcome-snapshot.js";
import { DREAM_READING_SYSTEM_PROMPT } from "./dream-reading.js";
import { EMOTIONAL_ADDICTION_RELEASE_SYSTEM_PROMPT } from "./emotional-addiction-release.js";
import { EVENING_RESET_SYSTEM_PROMPT } from "./evening-reset.js";
import { FINANCIAL_THERMOSTAT_RESET_SYSTEM_PROMPT } from "./financial-thermostat-reset.js";
import { FREQUENCY_BOOSTER_SYSTEM_PROMPT } from "./frequency-booster.js";
import { FREQUENCY_CALIBRATION_SYSTEM_PROMPT } from "./frequency-calibration.js";
import { GRAND_VISION_SYSTEM_PROMPT } from "./grand-vision.js";
import { IDENTITY_UPGRADE_SYSTEM_PROMPT } from "./identity-upgrade.js";
import { MORNING_ACTIVATION_SYSTEM_PROMPT } from "./morning-activation.js";
import { PROSPERITY_CODE_SYSTEM_PROMPT } from "./prosperity-code.js";
import { ROOT_PATTERN_RELEASE_SYSTEM_PROMPT } from "./root-pattern-release.js";
import { SETTING_THE_DESTINATION_SYSTEM_PROMPT } from "./setting-the-destination.js";
import { WORTHY_TO_RECEIVE_SYSTEM_PROMPT } from "./worthy-to-receive.js";

// Each process: key (url/id-safe), displayName, descriptor (one line for the
// UI picker), activationPhrase (lowercased substring used to detect a pasted
// activation prompt), and prompt (the full system prompt).
export const PROCESSES = [
  { key: "abundance-projection", displayName: "Abundance Projection",
    descriptor: "Project specific amounts, allocate, and act as the prosperous self now.",
    activationPhrase: "i am entering the abundance projection process",
    prompt: ABUNDANCE_PROJECTION_SYSTEM_PROMPT },
  { key: "decision-alignment", displayName: "Decision Alignment",
    descriptor: "Bring mind, heart, and body into one clear decision.",
    activationPhrase: "i am entering the decision alignment process",
    prompt: DECISION_ALIGNMENT_SYSTEM_PROMPT },
  { key: "desired-outcome-snapshot", displayName: "Desired Outcome Snapshot",
    descriptor: "Map the pattern you are in and the one you are choosing.",
    activationPhrase: "i am entering the desired outcome snapshot process",
    prompt: DESIRED_OUTCOME_SNAPSHOT_SYSTEM_PROMPT },
  { key: "dream-reading", displayName: "Dream Reading",
    descriptor: "Read a dream for its message and one bridging action.",
    activationPhrase: "i am entering the dream reading process",
    prompt: DREAM_READING_SYSTEM_PROMPT },
  { key: "emotional-addiction-release", displayName: "Emotional Addiction Release",
    descriptor: "Interrupt the chemical loop of the familiar emotional state.",
    activationPhrase: "i am entering the emotional addiction release process",
    prompt: EMOTIONAL_ADDICTION_RELEASE_SYSTEM_PROMPT },
  { key: "evening-reset", displayName: "Evening Reset",
    descriptor: "Close the day. Plant the desired future as the last image before sleep.",
    activationPhrase: "i am entering the evening reset",
    prompt: EVENING_RESET_SYSTEM_PROMPT },
  { key: "financial-thermostat-reset", displayName: "Financial Thermostat Reset",
    descriptor: "Name the financial set point, raise the bar, install the new standard.",
    activationPhrase: "i am entering the financial thermostat reset process",
    prompt: FINANCIAL_THERMOSTAT_RESET_SYSTEM_PROMPT },
  { key: "frequency-booster", displayName: "Frequency Booster",
    descriptor: "Quick 10-minute state shift. Lift your frequency right now.",
    activationPhrase: "i am entering the frequency booster",
    prompt: FREQUENCY_BOOSTER_SYSTEM_PROMPT },
  { key: "frequency-calibration", displayName: "Frequency Calibration",
    descriptor: "Tune your instrument to your desired reality.",
    activationPhrase: "i am entering the frequency calibration process",
    prompt: FREQUENCY_CALIBRATION_SYSTEM_PROMPT },
  { key: "grand-vision", displayName: "Grand Vision",
    descriptor: "The foundational compass. Name what you truly desire as already true.",
    activationPhrase: "i am entering the grand vision process",
    prompt: GRAND_VISION_SYSTEM_PROMPT },
  { key: "identity-upgrade", displayName: "Identity Upgrade",
    descriptor: "Resign the old identity. Anchor the one coming online.",
    activationPhrase: "i am entering the identity upgrade process",
    prompt: IDENTITY_UPGRADE_SYSTEM_PROMPT },
  { key: "morning-activation", displayName: "Morning Activation",
    descriptor: "Five minute daily ritual. Tune the instrument before the day begins.",
    activationPhrase: "i am entering the five minute morning activation",
    prompt: MORNING_ACTIVATION_SYSTEM_PROMPT },
  { key: "prosperity-code", displayName: "Prosperity Code",
    descriptor: "Align all four centers with the flow of prosperity.",
    activationPhrase: "i am entering the prosperity code process",
    prompt: PROSPERITY_CODE_SYSTEM_PROMPT },
  { key: "root-pattern-release", displayName: "Root Pattern Release",
    descriptor: "Trace a pattern to its root and release the charge.",
    activationPhrase: "i am entering the root pattern release process",
    prompt: ROOT_PATTERN_RELEASE_SYSTEM_PROMPT },
  { key: "setting-the-destination", displayName: "Setting the Destination",
    descriptor: "Crystallise your one-year and three-month milestones into living affirmations.",
    activationPhrase: "i am entering the setting the destination process",
    prompt: SETTING_THE_DESTINATION_SYSTEM_PROMPT },
  { key: "worthy-to-receive", displayName: "Worthy to Receive",
    descriptor: "Surface worthiness stories and reclaim your capacity to receive.",
    activationPhrase: "i am entering the worthy to receive process",
    prompt: WORTHY_TO_RECEIVE_SYSTEM_PROMPT },
];

export function findProcessByMessage(text) {
  const t = String(text || "").toLowerCase();
  return PROCESSES.find((p) => t.includes(p.activationPhrase)) || null;
}

export function getProcessByKey(key) {
  return PROCESSES.find((p) => p.key === key) || null;
}
