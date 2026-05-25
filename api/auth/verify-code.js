// api/auth/verify-code.js
// Step 2 of passwordless login. The member submits the 6-digit code. If it is
// valid, a session token is issued and the member is logged in with the tier
// the Kajabi webhook recorded for them.

import crypto from "node:crypto";
import {
  findEntitledMemberByEmail,
  getActiveLoginCode,
  consumeLoginCode,
  incrementLoginCodeAttempts,
  issueSessionToken,
  getOrCreateSession,
  timeRemainingMs,
  resolveActiveDay,
} from "../../lib/db.js";

const MAX_ATTEMPTS = 5;

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const email = String((req.body && req.body.email) || "").toLowerCase().trim();
    const code = String((req.body && req.body.code) || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[0-9]{6}$/.test(code)) {
      return res.status(400).json({ error: "invalid_input" });
    }

    const member = await findEntitledMemberByEmail(email);
    if (!member) return res.status(404).json({ error: "not_a_member" });

    const active = await getActiveLoginCode(email);
    if (!active) return res.status(400).json({ error: "code_expired" });

    if (active.attempts >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: "too_many_attempts" });
    }

    // Constant-time compare of the SHA-256 hashes.
    const submitted = Buffer.from(hashCode(code));
    const stored = Buffer.from(String(active.code_hash));
    const match =
      submitted.length === stored.length &&
      crypto.timingSafeEqual(submitted, stored);

    if (!match) {
      await incrementLoginCodeAttempts(active.id);
      return res.status(401).json({ error: "wrong_code" });
    }

    await consumeLoginCode(active.id);
    await getOrCreateSession(member.id);
    const sessionToken = issueSessionToken(member.id);

    return res.status(200).json({
      sessionToken: sessionToken,
      tier: member.tier,
      displayName: member.display_name || null,
      currentDay: resolveActiveDay(member),
      timeRemainingMs: timeRemainingMs(member),
    });
  } catch (err) {
    console.error("verify_code_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
