// api/export-pdf.js
//
// Server-side PDF generation for Reset + Field conversation exports.
//
// Why server-side?
//   Client-side libraries like html2pdf.js rasterize the page — text ends
//   up as pixels, not selectable/copyable text. Our members export their
//   conversations specifically so they can paste passages into their own
//   AI, share quotes with a therapist, or save meaningful lines. Selectable
//   text is non-negotiable for that use case.
//
//   Puppeteer + headless Chromium renders the same HTML we already build
//   for the client-side export and prints it to a real vector PDF, exactly
//   as if the user hit File → Print → Save as PDF from Chrome.
//
// Vercel setup:
//   • @sparticuz/chromium bundles a Lambda-compatible headless Chromium.
//   • puppeteer-core connects to that Chromium without shipping its own.
//   • The function needs at least 1024MB memory and 30s maxDuration
//     (configured in vercel.json).
//
// Auth:
//   Standard x-session-token header, matching the rest of the API. We
//   don't restrict by tier — Reset users can export their Reset chats,
//   Field users can export their Field chats. The HTML is built client-
//   side, so this endpoint just renders whatever the authenticated user
//   sends. If someone crafts a fake HTML payload, they only affect their
//   own PDF.
//
// Body:
//   { html: string, title?: string, orientation?: "portrait"|"landscape" }
//
// Response:
//   application/pdf stream with Content-Disposition: attachment.

import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { getUserBySessionToken } from "../lib/db.js";

// Vercel serverless: keep the browser instance out of module scope. Each
// invocation gets a fresh browser so we don't leak Chromium processes
// across warm invocations (which would eventually OOM).
export const config = {
  api: {
    // Conversation exports can be large — a full 6-day Field export with
    // 60+ messages can easily exceed the default 1MB body limit. Bump to
    // 4MB. If someone exports more than that, we return 413 and they can
    // fall back to the client-side HTML export.
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
  // Standalone document Chromium can render. We inline every style so we
  // don't depend on the app's stylesheet or any network resources besides
  // Google Fonts (which loads over TLS and finishes fast).
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
    body { padding: 0; }
    /* Common export elements — the client HTML uses these class names
       already; we're just making sure they render cleanly in print. */
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
  // CORS — match the rest of the API's approach: only allow same-origin
  // + our known domains. For now we mirror /api/chat.js's headers.
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

  // ----- Launch Chromium -----
  let browser;
  try {
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--font-render-hinting=none",
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    const fullHtml = buildFullHtml(html, title);

    // waitUntil "networkidle0" waits until there are no network
    // connections for at least 500ms — good balance between waiting for
    // fonts to load and not stalling forever if some CDN is slow.
    await page.setContent(fullHtml, { waitUntil: "networkidle0", timeout: 20000 });

    const pdfBuffer = await page.pdf({
      format: "a4",
      landscape: orientation === "landscape",
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: "15mm",
        right: "15mm",
        bottom: "18mm",
        left: "15mm",
      },
    });

    await browser.close();
    browser = null;

    const filename = sanitizeFilename(title) + ".pdf";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.setHeader("Content-Length", pdfBuffer.length);
    // Buffer.from ensures we send bytes, not a stringified buffer.
    return res.status(200).send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error("[export-pdf] pdf generation failed", err);
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
    return res.status(500).json({ error: "pdf_failed", detail: String(err && err.message || err) });
  }
}
