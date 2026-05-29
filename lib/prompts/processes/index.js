// lib/prompts/processes/index.js
// Registry of the guided processes available inside The Field Unlimited.
import { DECISION_ALIGNMENT_SYSTEM_PROMPT } from "./decision-alignment.js";
import { DESIRED_OUTCOME_SNAPSHOT_SYSTEM_PROMPT } from "./desired-outcome-snapshot.js";
import { DREAM_READING_SYSTEM_PROMPT } from "./dream-reading.js";
import { EMOTIONAL_ADDICTION_RELEASE_SYSTEM_PROMPT } from "./emotional-addiction-release.js";
import { FREQUENCY_CALIBRATION_SYSTEM_PROMPT } from "./frequency-calibration.js";
import { IDENTITY_UPGRADE_SYSTEM_PROMPT } from "./identity-upgrade.js";
import { ROOT_PATTERN_RELEASE_SYSTEM_PROMPT } from "./root-pattern-release.js";

// Each process: key (url/id-safe), displayName, descriptor (one line for the
// UI picker), activationPhrase (lowercased substring used to detect a pasted
// activation prompt), and prompt (the full system prompt).
export const PROCESSES = [
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
  { key: "frequency-calibration", displayName: "Frequency Calibration",
    descriptor: "Tune your instrument to your desired reality.",
    activationPhrase: "i am entering the frequency calibration process",
    prompt: FREQUENCY_CALIBRATION_SYSTEM_PROMPT },
  { key: "identity-upgrade", displayName: "Identity Upgrade",
    descriptor: "Resign the old identity. Anchor the one coming online.",
    activationPhrase: "i am entering the identity upgrade process",
    prompt: IDENTITY_UPGRADE_SYSTEM_PROMPT },
  { key: "root-pattern-release", displayName: "Root Pattern Release",
    descriptor: "Trace a pattern to its root and release the charge.",
    activationPhrase: "i am entering the root pattern release process",
    prompt: ROOT_PATTERN_RELEASE_SYSTEM_PROMPT },
];

export function findProcessByMessage(text) {
  const t = String(text || "").toLowerCase();
  return PROCESSES.find((p) => t.includes(p.activationPhrase)) || null;
}

export function getProcessByKey(key) {
  return PROCESSES.find((p) => p.key === key) || null;
}
