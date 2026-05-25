// api/auth/request-code.js
// Step 1 of passwordless login. The member submits their email; if it belongs
// to an entitled Kajabi member, a 6-digit code is emailed to them via Resend.

import crypto from "node:crypto";
import {
  findEntitledMemberByEmail,
  createLoginCode,
  countRecentLoginCodes,
} from "../../lib/db.js";

const CODE_TTL_MIN = 10;          // code is valid for 10 minutes
const MAX_CODES_PER_WINDOW = 4;   // per email
const RATE_WINDOW_MIN = 15;

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

async function sendCodeEmail(toEmail, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");
  const from = process.env.RESEND_FROM || "The Field <onboarding@resend.dev>";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1A1612;">
      <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#9A6E10;font-weight:700;">The Freedom Intelligence Field</div>
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:400;font-style:italic;margin:18px 0 8px;">Your login code</h1>
      <p style="font-size:14px;line-height:1.6;color:#555;">Enter this code to open The Field. It expires in ${CODE_TTL_MIN} minutes.</p>
      <div style="font-size:38px;font-weight:700;letter-spacing:0.18em;color:#1A1612;background:#F7F1E1;border-radius:12px;padding:20px;text-align:center;margin:20px 0;">${code}</div>
      <p style="font-size:12px;line-height:1.6;color:#999;">If you didn't request this, you can safely ignore this email.</p>
    </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: from,
      to: [toEmail],
      subject: `Your Field login code: ${code}`,
      html: html,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`resend_failed: ${res.status} ${t.slice(0, 200)}`);
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const email = String((req.body && req.body.email) || "").toLowerCase().trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "invalid_email" });
    }

    const member = await findEntitledMemberByEmail(email);
    if (!member) {
      // Not an entitled member. Told plainly so a real member who mistyped
      // their address can correct it; enumeration risk is low for this product.
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
  } catch (err) {
    console.error("request_code_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
