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
  //
  // AI-generated content marking (EU AI Act Article 50):
  // -----------------------------------------------------
  // Chromium (which PDFShift uses under the hood) copies HTML <meta>
  // tags into the PDF's XMP/Document Info metadata. That makes the PDF
  // MACHINE-READABLE as AI-generated to any downstream tool that inspects
  // PDF metadata — which is what Article 50(2) of the EU AI Act requires
  // for exported AI content as of 2 Aug 2026.
  //
  // We ALSO print a small visible footer on the last page so a human
  // opening the PDF sees the marking too. Belt-and-braces: machine
  // readers get the metadata, humans get the footer.
  const safeTitle = String(title || "Conversation")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const generatedIso = new Date().toISOString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>

  <!-- EU AI Act Article 50 — machine-readable AI-generated markers -->
  <meta name="author" content="Freedom Intelligence Field (AI-generated)" />
  <meta name="creator" content="Freedom Intelligence Field — AI system powered by Anthropic Claude" />
  <meta name="producer" content="Freedom Intelligence Field (Master Your Path). AI-generated content." />
  <meta name="subject" content="AI-generated coaching conversation transcript" />
  <meta name="keywords" content="AI-generated, artificial intelligence, EU AI Act, Anthropic Claude, Freedom Intelligence Field, Master Your Path, coaching transcript" />
  <meta name="generator" content="Freedom Intelligence Field (AI) — https://thefieldai.app" />
  <meta name="dc.creator" content="Freedom Intelligence Field (AI system)" />
  <meta name="dc.publisher" content="Master Your Path — Shimrit Bukelman, Berlin" />
  <meta name="dc.type" content="Text; AI-generated content" />
  <meta name="dc.date" content="${generatedIso}" />
  <meta name="dcterms.created" content="${generatedIso}" />
  <meta name="ai-generated" content="true" />
  <meta name="ai-provider" content="Anthropic Claude" />
  <meta name="ai-act-compliance" content="EU AI Act 2024/1689 Article 50" />

  <style>
    @page {
      size: A4;
      margin: 15mm 15mm 22mm 15mm;
      /* Machine-readable footer stamp printed on every page: identifies
         the document as AI-generated so it remains visible even if the
         PDF is split, cropped, or a single page is shared out of context. */
      @bottom-center {
        content: "AI-generated content — Freedom Intelligence Field (Anthropic Claude) · EU AI Act Art. 50";
        font-family: Georgia, "Times New Roman", Times, serif;
        font-size: 8pt;
        color: #8B7E66;
      }
      @bottom-right {
        content: counter(page) " / " counter(pages);
        font-family: Georgia, "Times New Roman", Times, serif;
        font-size: 8pt;
        color: #8B7E66;
      }
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
    /* Cover-page AI marker — visible statement at the top of the
       document so a reader who opens the PDF sees it immediately. */
    .ai-generated-notice {
      margin: 0 0 18pt 0;
      padding: 10pt 12pt;
      border: 1px solid #d4c8a8;
      background: #FAF6EE;
      border-radius: 6pt;
      font-family: -apple-system, "Segoe UI", sans-serif;
      font-size: 9pt;
      line-height: 1.5;
      color: #4A4030;
    }
    .ai-generated-notice strong { color: #1a1a1a; }
  </style>
</head>
<body>
<div class="ai-generated-notice" role="note">
  <strong>AI-generated content.</strong> This document is a transcript of a session with the Freedom Intelligence Field, an AI system powered by Anthropic Claude and guided by Shimrit Nativ's Human Instrument® method. All Field replies are generated by AI. Marked as AI-generated in this document's metadata in line with Article 50 of the EU AI Act (Regulation (EU) 2024/1689).
</div>
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
