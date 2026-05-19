// api/admin/test-retrieval.js
// Admin-only endpoint for testing brain retrieval. Takes a query string,
// generates an embedding, finds the top N most semantically similar chunks
// from brain_chunks via cosine similarity. Returns them with similarity
// scores so you can sanity-check that the brain returns relevant material.

import { sql } from "@vercel/postgres";

export const config = {
  api: { bodyParser: { sizeLimit: "100kb" } },
  maxDuration: 30,
};

const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const TOP_K = 5;

export default async function handler(req, res) {
  const authToken = req.headers["x-admin-token"];
  if (!authToken || authToken !== process.env.ADMIN_TOKEN) {
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

    const { query, top_k } = req.body || {};
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "missing_query" });
    }
    const k = Math.min(Math.max(parseInt(top_k, 10) || TOP_K, 1), 20);

    // Embed the query.
    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: query,
        model: OPENAI_EMBEDDING_MODEL,
      }),
    });
    if (!embRes.ok) {
      const errText = await embRes.text().catch(() => "");
      return res.status(502).json({ error: "embedding_failed", details: errText.slice(0, 300) });
    }
    const embData = await embRes.json();
    const queryEmbedding = embData.data[0].embedding;
    const embStr = "[" + queryEmbedding.join(",") + "]";

    // Find the top K most similar chunks via cosine distance.
    // Lower distance = more similar. Convert to similarity for readability.
    const { rows } = await sql.query(
      `SELECT
        source_title,
        source_category,
        source_path,
        chunk_index,
        total_chunks,
        LEFT(content, 400) AS preview,
        (1 - (embedding <=> $1::vector)) AS similarity
      FROM brain_chunks
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
      [embStr, k]
    );

    return res.status(200).json({
      query,
      top_k: k,
      results: rows.map((r) => ({
        title: r.source_title,
        category: r.source_category,
        chunk: `${r.chunk_index + 1}/${r.total_chunks}`,
        similarity: Number(r.similarity).toFixed(4),
        preview: r.preview,
      })),
    });
  } catch (err) {
    console.error("test_retrieval_error", err);
    return res.status(500).json({ error: "internal_error", message: err?.message || String(err) });
  }
}
