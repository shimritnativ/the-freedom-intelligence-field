// api/auth.js
// Passwordless login. Two actions on a single endpoint:
//
//   POST /api/auth?action=request   -> send a 6-digit code to the member's email
//   POST /api/auth?action=verify    -> validate the code and issue a session token
//
// Consolidated from the previous /api/auth/request-code and /api/auth/verify-code
// endpoints to stay under Vercel's Hobby-plan serverless function limit.
// Behavior is identical to the separate endpoints — only the URL changed.

import crypto from "node:crypto";
import {
  findEntitledMemberByEmail,
  createLoginCode,
  countRecentLoginCodes,
  getActiveLoginCode,
  consumeLoginCode,
  incrementLoginCodeAttempts,
  issueSessionToken,
  getOrCreateSession,
  timeRemainingMs,
  resolveActiveDay,
  recordFirstLogin,
  buildDayUnlocks,
} from "../lib/db.js";

const CODE_TTL_MIN = 10;          // code is valid for 10 minutes
const MAX_CODES_PER_WINDOW = 4;   // per email
const RATE_WINDOW_MIN = 15;
const MAX_ATTEMPTS = 5;

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

async function sendCodeEmail(toEmail, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");
  const from = process.env.RESEND_FROM || "The Field <hello@shimritnativ.com>";
  const replyTo = process.env.RESEND_REPLY_TO || "support@shimritnativ.com";

  const subject = "Access The Field · Your one-time code";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1A1612;background:#ffffff;">
      <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#9A6E10;font-weight:700;">The Freedom Intelligence Field</div>
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:400;font-style:italic;margin:18px 0 12px;">Welcome back</h1>
      <p style="font-size:15px;line-height:1.6;color:#333;margin:0 0 6px;">Hi there,</p>
      <p style="font-size:15px;line-height:1.6;color:#333;margin:0 0 18px;">You asked to sign in to The Field. Here is your one-time access code. Enter it on the sign-in page to open your account.</p>
      <div style="font-size:38px;font-weight:700;letter-spacing:0.18em;color:#1A1612;background:#F7F1E1;border-radius:12px;padding:22px;text-align:center;margin:8px 0 20px;">${code}</div>
      <p style="font-size:14px;line-height:1.6;color:#555;margin:0 0 18px;">This code expires in ${CODE_TTL_MIN} minutes and can only be used once. If you did not request it, no action is needed and your account stays safe.</p>
      <p style="font-size:14px;line-height:1.6;color:#555;margin:0 0 24px;">Warmly,<br>The Field team</p>
      <div style="border-top:1px solid #eee;padding-top:16px;font-size:11px;line-height:1.6;color:#999;">
        <p style="margin:0 0 6px;">You are receiving this email because someone (hopefully you) requested a sign-in code for The Field with this email address.</p>
        <p style="margin:0 0 6px;">Need help? Reply to this email and we will get back to you.</p>
        <p style="margin:10px 0 0;">Shimrit Bukelman · Anton Saefkow Str. 18 · 10407 Berlin · Germany</p>
      </div>
    </div>`;

  const text = [
    "The Freedom Intelligence Field",
    "",
    "Hi there,",
    "",
    "You asked to sign in to The Field. Here is your one-time access code:",
    "",
    "    " + code,
    "",
    `This code expires in ${CODE_TTL_MIN} minutes and can only be used once.`,
    "If you did not request it, no action is needed and your account stays safe.",
    "",
    "Warmly,",
    "The Field team",
    "",
    "---",
    "You are receiving this because someone (hopefully you) requested a sign-in code",
    "for The Field with this email address. Reply anytime for help.",
    "",
    "Shimrit Bukelman · Anton Saefkow Str. 18 · 10407 Berlin · Germany",
  ].join("\n");

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: from,
      to: [toEmail],
      reply_to: replyTo,
      subject: subject,
      html: html,
      text: text,
      headers: {
        "List-Unsubscribe": `<mailto:${replyTo}?subject=unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`resend_failed: ${r.status} ${t.slice(0, 200)}`);
  }
}

async function handleRequestCode(req, res) {
  const email = String((req.body && req.body.email) || "").toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }

  const member = await findEntitledMemberByEmail(email);
  if (!member) {
    return res.status(404).json({ error: "not_a_member" });
  }

  const recent = await countRecentLoginCodes(email, RATE_WINDOW_MIN);
  if (recent >= MAX_CODES_PER_WINDOW) {
    return res.status(429).json({ error: "too_many_requests" });
  }

  // 6-digit code from a cryptographic RNG, uniform across 000000-999999.
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await createLoginCode(email, hashCode(code), CODE_TTL_MIN);
  await sendCodeEmail(email, code);

  return res.status(200).json({ ok: true });
}

async function handleVerifyCode(req, res) {
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

  // First login? Set first_login_at and (for preview tier) start the 96h
  // window from now. Idempotent for repeat logins.
  const refreshed = await recordFirstLogin(member.id);
  const userRow = refreshed || member;

  const sessionToken = issueSessionToken(member.id);

  return res.status(200).json({
    sessionToken: sessionToken,
    tier: userRow.tier,
    subscriptionPlan: userRow.subscription_plan || null,
    displayName: userRow.display_name || null,
    email: userRow.email,
    currentDay: resolveActiveDay(userRow),
    timeRemainingMs: timeRemainingMs(userRow),
    dayUnlocks: buildDayUnlocks(userRow),
    firstLoginAt: userRow.first_login_at,
    previewEndsAt: userRow.preview_ends_at,
  });
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const action = (req.query && req.query.action) || "";

  try {
    if (action === "request") return await handleRequestCode(req, res);
    if (action === "verify") return await handleVerifyCode(req, res);
    return res.status(400).json({ error: "unknown_action" });
  } catch (err) {
    console.error("auth_error", { action: action, message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
