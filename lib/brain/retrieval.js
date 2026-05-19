// lib/brain/retrieval.js
// Brain retrieval utilities. Given a user query, embed it and find the most
// semantically similar chunks from brain_chunks via cosine similarity.

import { sql } from "@vercel/postgres";

const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_TOP_K = 8;

// Generate an OpenAI embedding for a single text input.
export async function embedQuery(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("missing_openai_key");
  }
  const cleanText = String(text || "").trim();
  if (!cleanText) {
    throw new Error("empty_text");
  }
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: cleanText,
      model: OPENAI_EMBEDDING_MODEL,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`embed_failed: ${res.status} ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

// Retrieve the top K most semantically similar chunks for a query.
// Returns chunks with their content, source metadata, and similarity score.
// Filter by category if provided (e.g., only "methodology" chunks).
export async function retrieveChunks(query, options = {}) {
  const topK = Math.min(Math.max(options.topK || DEFAULT_TOP_K, 1), 20);
  const categoryFilter = options.category || null;

  const queryEmbedding = await embedQuery(query);
  const embStr = "[" + queryEmbedding.join(",") + "]";

  let result;
  if (categoryFilter) {
    result = await sql.query(
      `SELECT
        source_title,
        source_category,
        source_path,
        content,
        (1 - (embedding <=> $1::vector)) AS similarity
      FROM brain_chunks
      WHERE source_category = $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
      [embStr, categoryFilter, topK]
    );
  } else {
    result = await sql.query(
      `SELECT
        source_title,
        source_category,
        source_path,
        content,
        (1 - (embedding <=> $1::vector)) AS similarity
      FROM brain_chunks
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
      [embStr, topK]
    );
  }

  return result.rows.map((r) => ({
    title: r.source_title,
    category: r.source_category,
    path: r.source_path,
    content: r.content,
    similarity: Number(r.similarity),
  }));
}

// Format retrieved chunks as a context block for the AI system prompt.
// The AI sees this as authoritative Shimrit material to ground its response.
export function formatRetrievedContext(chunks) {
  if (!chunks || chunks.length === 0) {
    return "RETRIEVED CONTEXT (none — no semantically relevant material found for this message; respond from your core voice and methodology).";
  }
  const blocks = chunks.map((c, i) => {
    return `[${i + 1}] (${c.category}) ${c.title}\n${c.content}`;
  });
  return `RETRIEVED CONTEXT (Shimrit's actual teachings and methodology, ranked by relevance to the participant's current message):\n\n${blocks.join("\n\n---\n\n")}`;
}

// Build the participant context block from their Reset outputs.
// Used in the system prompt so the AI knows who the participant is.
export function formatParticipantContext(resetData) {
  if (!resetData || (!resetData.day1 && !resetData.day2 && !resetData.day3)) {
    return "PARTICIPANT CONTEXT (none — this is a new participant with no prior Reset work).";
  }
  const parts = ["PARTICIPANT CONTEXT (their prior 72 Hour Reset work):"];
  if (resetData.day1) {
    parts.push(`\nDay 1 — State Reset:\n${JSON.stringify(resetData.day1, null, 2)}`);
  }
  if (resetData.day2) {
    parts.push(`\nDay 2 — Decision Alignment:\n${JSON.stringify(resetData.day2, null, 2)}`);
  }
  if (resetData.day3) {
    parts.push(`\nDay 3 — Living Power Declaration:\n${JSON.stringify(resetData.day3, null, 2)}`);
  }
  return parts.join("\n");
}
