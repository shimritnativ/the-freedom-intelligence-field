// api/business-inquiry.js
//
// Handles "Talk to us" submissions from the Business tier on the
// marketing site. Validates the fields, sanity-checks them against
// obvious bot patterns, and emails the contents to Shimrit's team
// via Resend. Reply-To is set to the prospect's email so a reply
// goes straight back to them.
//
// POST body:
//   {
//     name: string,
//     email: string,
//     phone: string,           // free-form, country code expected
//     team_size: string,       // e.g. "1-5", "6-20", "21-100", "100+"
//     industry: string,        // free-form
//     // OPTIONAL: source: string — where the form was opened from
//   }
//
// Returns 200 { ok: true } on success.
// Returns 400 with { error } for validation failures.
// Returns 500 if Resend fails — frontend should show "try again"
// rather than blocking the user.

const TO_EMAIL = "support@shimritnativ.com";

// This is a PUBLIC contact form — no credentials, no auth, no PII
// beyond what the user voluntarily submits. Safe to allow any origin.
// Simpler than maintaining an allowlist, and means the form works no
// matter which domain the marketing page is served from.
function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const body = req.body || {};

    // Trim + cap each field to a sane length so a malicious POST can't
    // shove 50KB into our email.
    const name = String(body.name || "").trim().slice(0, 120);
    const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
    const phone = String(body.phone || "").trim().slice(0, 60);
    const teamSize = String(body.team_size || "").trim().slice(0, 50);
    const industry = String(body.industry || "").trim().slice(0, 120);
    const source = String(body.source || "the-field-website business tier").trim().slice(0, 80);

    // Honeypot — a hidden field in the form that a real user won't
    // fill. Bots auto-fill every field, so a non-empty website is a
    // spam signal. Silently accept to avoid telling the bot.
    const honeypot = String(body.website || "").trim();
    if (honeypot) {
      return res.status(200).json({ ok: true });
    }

    // Validation — minimal but real.
    if (!name) return res.status(400).json({ error: "name_required" });
    if (!email || !email.includes("@") || !email.includes(".")) {
      return res.status(400).json({ error: "valid_email_required" });
    }
    if (!phone) return res.status(400).json({ error: "phone_required" });
    if (!teamSize) return res.status(400).json({ error: "team_size_required" });
    if (!industry) return res.status(400).json({ error: "industry_required" });

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("business_inquiry_no_resend_key");
      return res.status(500).json({ error: "email_not_configured" });
    }
    const from = process.env.RESEND_FROM || "The Field <onboarding@resend.dev>";

    // Email body — clean HTML, easy to scan + reply to in Gmail/Apple Mail.
    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#1A1612;">
        <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#9A6E10;font-weight:700;">The Field for Business — New Inquiry</div>
        <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:400;font-style:italic;margin:18px 0 24px;">${escapeHtml(name)} wants to talk.</h1>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr>
            <td style="padding:10px 0;color:#888;width:140px;vertical-align:top;">Name</td>
            <td style="padding:10px 0;color:#1A1612;font-weight:600;">${escapeHtml(name)}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#888;vertical-align:top;border-top:1px solid #eee;">Email</td>
            <td style="padding:10px 0;color:#1A1612;font-weight:600;border-top:1px solid #eee;"><a href="mailto:${escapeHtml(email)}" style="color:#9A6E10;text-decoration:none;">${escapeHtml(email)}</a></td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#888;vertical-align:top;border-top:1px solid #eee;">Phone</td>
            <td style="padding:10px 0;color:#1A1612;font-weight:600;border-top:1px solid #eee;">${escapeHtml(phone)}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#888;vertical-align:top;border-top:1px solid #eee;">Team size</td>
            <td style="padding:10px 0;color:#1A1612;font-weight:600;border-top:1px solid #eee;">${escapeHtml(teamSize)}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#888;vertical-align:top;border-top:1px solid #eee;">Industry</td>
            <td style="padding:10px 0;color:#1A1612;font-weight:600;border-top:1px solid #eee;">${escapeHtml(industry)}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#888;vertical-align:top;border-top:1px solid #eee;">Source</td>
            <td style="padding:10px 0;color:#999;font-size:12px;border-top:1px solid #eee;">${escapeHtml(source)}</td>
          </tr>
        </table>
        <div style="margin-top:24px;padding:16px;background:#F7F1E1;border-radius:8px;font-size:13px;color:#555;">
          <strong>Reply directly to this email</strong> and it will go to ${escapeHtml(name)} at ${escapeHtml(email)}.
        </div>
      </div>`;

    const subject = `[Field for Business] ${name} · ${teamSize} · ${industry}`;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [TO_EMAIL],
        reply_to: email,
        subject,
        html,
      }),
    });

    if (!resendRes.ok) {
      const t = await resendRes.text().catch(() => "");
      console.error("business_inquiry_resend_failed", {
        status: resendRes.status,
        body: t.slice(0, 300),
      });
      return res.status(500).json({ error: "send_failed" });
    }

    console.log("business_inquiry_sent", { name, email, team_size: teamSize, industry });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("business_inquiry_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
