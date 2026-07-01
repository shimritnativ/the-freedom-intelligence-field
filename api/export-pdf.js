// api/export-pdf.js
//
// Server-side PDF generation via PDFShift (https://pdfshift.io).
//
// Why an external service?
//   We tried self-hosted Chromium on Vercel with @sparticuz/chromium +
//   puppeteer-core. Vercel's Node runtime dropped libnss3.so, so
//   Chromium can't launch. That approach is dead until Vercel changes
//   their runtime or we move to a different platform.
//
//   PDFShift solves this permanently:
//     • Real vector PDF with selectable, copyable text (members can paste
//       passages into their own AI, share quotes with a therapist).
//     • Free tier is 250 credits/month, which covers The Field's export
//       volume for the foreseeable future.
//     • No infrastructure to maintain. If PDFShift ever goes down we
//       swap the endpoint to DocRaptor or another provider in 15 min.
//
// Auth:
//   Standard x-session-token header, matching the rest of the API.
//   We don't restrict by tier — Reset users export Reset chats, Field
//   users export Field chats.
//
// Env vars:
//   PDFSHIFT_API_KEY — required. Get one at https://pdfshift.io.
//   Store in Vercel → project → Settings → Environment Variables.
//   If missing, the endpoint returns 503 and the client falls back to
//   the browser print dialog so members still get their PDF.
//
// Body:
//   { html: string, title?: string, orientation?: "portrait"|"landscape" }
//
// Response:
//   application/pdf stream with Content-Disposition: attachment.

import { getUserBySessionToken } from "../lib/db.js";

export const config = {
  api: {
    // Conversation exports can be large. Bump to 4MB. If someone exports
    // more than that, we return 413 and they fall back to the client-side
    // print-dialog path (which handles any size).
    bodyParser: {
      sizeLimit: "4mb",
    },
  },
};

function sanitizeFilename(raw) {
  const cleaned = String(raw || "conversation")
    .replace(/[\\/:*?"<>|\r\n\t]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return cleaned || "conversation";
}

function buildFullHtml(bodyHtml, title) {
  // Standalone HTML document that PDFShift can render. We inline the
  // print styles so the PDF looks right without needing the app's
  // stylesheet.
  const safeTitle = String(title || "Conversation")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <style>
    @page {
      size: A4;
      margin: 15mm 15mm 18mm 15mm;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      color: #1a1a1a;
      font-family: Georgia, "Times New Roman", Times, serif;
      font-size: 12pt;
      line-height: 1.55;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    h1, h2, h3 { color: #7a5a1e; font-family: Georgia, serif; }
    a { color: #7a5a1e; text-decoration: none; }
    .avoid-break, .msg, .message, .entry {
      page-break-inside: avoid;
      break-inside: avoid;
    }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-session-token",
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // ----- Auth -----
  let user;
  try {
    const token = req.headers["x-session-token"];
    user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });
  } catch (err) {
    console.error("[export-pdf] auth check failed", err);
    return res.status(500).json({ error: "auth_failed" });
  }

  // ----- Config check -----
  const apiKey = process.env.PDFSHIFT_API_KEY;
  if (!apiKey) {
    console.error("[export-pdf] PDFSHIFT_API_KEY is not set");
    // 503 signals "server is temporarily unable to fulfill". Client will
    // fall back to the browser print dialog.
    return res.status(503).json({ error: "pdfshift_not_configured" });
  }

  // ----- Validate body -----
  const body = req.body || {};
  const html = typeof body.html === "string" ? body.html : "";
  const title = typeof body.title === "string" ? body.title : "conversation";
  const orientation =
    body.orientation === "landscape" ? "landscape" : "portrait";

  if (!html.trim()) {
    return res.status(400).json({ error: "missing_html" });
  }
  if (html.length > 4 * 1024 * 1024) {
    return res.status(413).json({ error: "html_too_large" });
  }

  // ----- Call PDFShift -----
  const fullHtml = buildFullHtml(html, title);

  try {
    // PDFShift API v3. Auth is Basic with "api" as username and the API
    // key as password. Docs: https://docs.pdfshift.io/
    const authHeader =
      "Basic " + Buffer.from("api:" + apiKey).toString("base64");

    const pdfshiftResp = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: fullHtml,
        format: "A4",
        margin: "15mm 15mm 18mm 15mm",
        landscape: orientation === "landscape",
        // Uncomment for testing without using credits (adds watermark):
        // sandbox: true,
      }),
    });

    if (!pdfshiftResp.ok) {
      const errText = await pdfshiftResp.text().catch(() => "");
      console.error(
        "[export-pdf] PDFShift error",
        pdfshiftResp.status,
        errText,
      );
      return res.status(502).json({
        error: "pdfshift_failed",
        status: pdfshiftResp.status,
        detail: errText.slice(0, 500),
      });
    }

    const pdfArrayBuffer = await pdfshiftResp.arrayBuffer();
    const pdfBuffer = Buffer.from(pdfArrayBuffer);

    const filename = sanitizeFilename(title) + ".pdf";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.setHeader("Content-Length", pdfBuffer.length);
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error("[export-pdf] fetch failed", err);
    return res.status(500).json({
      error: "pdf_failed",
      detail: String((err && err.message) || err),
    });
  }
}
