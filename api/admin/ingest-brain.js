// api/admin/ingest-brain.js
// One-time admin endpoint that reads pre-extracted brain chunks from
// lib/brain/chunks.json, generates embeddings via OpenAI, and writes them
// to the brain_chunks table in Postgres.
//
// Auth: accepts EITHER the ADMIN_TOKEN header (for curl/CI) OR a valid
// @shimritnativ.com session token (so Geo can trigger it from the admin
// browser console without hunting down the env token).
// Idempotent: TRUNCATEs the table before insert, so re-running gives a
// fresh ingest. Safe to call again whenever chunks.json changes.

import { sql } from "@vercel/postgres";
import fs from "fs";
import path from "path";
import { getUserBySessionToken } from "../../lib/db.js";

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } },
  maxDuration: 300,
};

const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 100;
const ALLOWED_DOMAIN = "@shimritnativ.com";

export default async function handler(req, res) {
  // CORS headers for browser console calls from the admin dashboard.
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-admin-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Auth path 1: legacy ADMIN_TOKEN header (curl / CI).
  const adminToken = req.headers["x-admin-token"];
  const hasValidAdminToken = adminToken && adminToken === process.env.ADMIN_TOKEN;

  // Auth path 2: same session-token check every other admin endpoint uses.
  // Lets Geo hit this from the browser console with her existing login.
  let hasValidSession = false;
  if (!hasValidAdminToken) {
    try {
      const sessionToken = req.headers["x-session-token"];
      const user = await getUserBySessionToken(sessionToken);
      if (user && (user.email || "").toLowerCase().endsWith(ALLOWED_DOMAIN)) {
        hasValidSession = true;
      }
    } catch {}
  }

  if (!hasValidAdminToken && !hasValidSession) {
    return res.status(401).json({ error: "unauthorized" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return res.status(500).json({ error: "missing_openai_key" });
    }

    // Read the pre-extracted chunks from the deployed bundle.
    const chunksPath = path.join(process.cwd(), "lib/brain/chunks.json");
    let chunks;
    try {
      const raw = fs.readFileSync(chunksPath, "utf-8");
      chunks = JSON.parse(raw);
    } catch (e) {
      return res.status(500).json({
        error: "could_not_load_chunks",
        details: e.message,
        hint: "Make sure lib/brain/chunks.json is committed to the repo."
      });
    }

    if (!Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: "no_chunks_found" });
    }

    // Start fresh. Re-running this endpoint replaces all chunks.
    await sql`TRUNCATE TABLE brain_chunks`;

    let inserted = 0;
    const startedAt = Date.now();

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map((c) => c.content);

      // Generate embeddings for the whole batch in one API call.
      const embRes = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: texts,
          model: OPENAI_EMBEDDING_MODEL,
        }),
      });

      if (!embRes.ok) {
        const errText = await embRes.text().catch(() => "");
        return res.status(502).json({
          error: "embedding_failed",
          details: errText.slice(0, 500),
          completed_before_error: inserted,
        });
      }

      const embData = await embRes.json();
      const embeddings = embData.data.map((d) => d.embedding);

      // Insert each chunk with its embedding.
      for (let j = 0; j < batch.length; j++) {
        const c = batch[j];
        const emb = embeddings[j];
        const embStr = "[" + emb.join(",") + "]";

        await sql`
          INSERT INTO brain_chunks (
            source_path, source_title, source_category,
            chunk_index, total_chunks, content, token_count,
            embedding, metadata
          ) VALUES (
            ${c.source_path}, ${c.source_title}, ${c.source_category},
            ${c.chunk_index}, ${c.total_chunks}, ${c.content}, ${c.token_count},
            ${embStr}::vector, ${JSON.stringify(c.metadata || {})}
          )
        `;
        inserted++;
      }
    }

    const elapsedMs = Date.now() - startedAt;

    // Quick summary of what's in the brain now.
    const { rows: categoryCounts } = await sql`
      SELECT source_category, COUNT(*)::int AS count
      FROM brain_chunks
      GROUP BY source_category
      ORDER BY count DESC
    `;

    return res.status(200).json({
      success: true,
      total_chunks: chunks.length,
      inserted,
      elapsed_ms: elapsedMs,
      categories: categoryCounts,
    });
  } catch (err) {
    console.error("ingest_brain_error", err);
    return res.status(500).json({
      error: "internal_error",
      message: err?.message || String(err),
    });
  }
}
