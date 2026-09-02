// api/generate-image.js
// Calls OpenAI's Images API (gpt-image-1) to render a Beyond Potential
// Board (or any other workshop-integration visualization) for a workshop
// VIP member. Returns the image as a base64-encoded PNG so the client
// can persist it inline in the message content and it survives beyond
// OpenAI's temporary URL expiry.
//
// Auth: same session-token pattern as /api/chat.
// Tier gate: workshop-tier ONLY. Preview/full/etc. return 403. This is a
//   VIP-only feature and shouldn't accidentally light up for someone who
//   URL-hacks their way into calling it.
// Rate limit: 10 images per user per 24-hour rolling window. Enough to
//   build a Board, refine it once or twice, and have room to breathe.
//   Enforced against the messages table (looks for prior [[img:...]]
//   tokens in the last 24h from this user).

import { sql } from "@vercel/postgres";
import { getUserBySessionToken } from "../lib/db.js";

// Bytes cap for the returned base64. gpt-image-1 at 1024x1024 typically
// returns ~1.5MB base64. 4MB gives headroom for HD variants without letting
// pathological responses through.
const MAX_B64_BYTES = 4 * 1024 * 1024;
const RATE_LIMIT_PER_24H = 10;

function applyCors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!origin && process.env.NODE_ENV !== "production") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const startedAt = Date.now();
  try {
    // ----- Auth -----
    const token = req.headers["x-session-token"];
    const user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    // ----- Tier gate: workshop tier only -----
    // Image generation is part of the ATWT VIP experience. Preview and
    // full-tier members do not have access. Return a clear error so the
    // client can distinguish this from a network failure.
    if (user.tier !== "workshop") {
      return res.status(403).json({
        error: "not_available_on_your_tier",
        message: "Image generation is a Workshop VIP feature.",
      });
    }

    // ----- API key check -----
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("generate_image_no_openai_key");
      return res.status(500).json({ error: "image_generation_unavailable" });
    }

    // ----- Input validation -----
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const prompt = String(body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "missing_prompt" });
    if (prompt.length > 4000) {
      return res.status(400).json({ error: "prompt_too_long" });
    }
    // Allow the caller to request 1024x1024 (default), 1024x1536 (portrait),
    // or 1536x1024 (landscape). Anything else falls back to square.
    const requestedSize = String(body.size || "1024x1024");
    const size = ["1024x1024", "1024x1536", "1536x1024"].includes(requestedSize)
      ? requestedSize
      : "1024x1024";

    // ----- Rate limit -----
    // Count how many images this user has generated in the last 24h by
    // counting assistant messages that contain an [[img:...]] token. Cheap
    // enough as a per-request check and self-heals if the counter drifts
    // (we don't need a separate counter table).
    const { rows: countRows } = await sql`
      SELECT COUNT(*)::int AS n
      FROM messages
      WHERE user_id = ${user.id}
        AND role = 'assistant'
        AND content LIKE '%[[img:%'
        AND created_at > NOW() - INTERVAL '24 hours'
    `;
    const recentCount = Number(countRows[0]?.n || 0);
    if (recentCount >= RATE_LIMIT_PER_24H) {
      return res.status(429).json({
        error: "rate_limited",
        message: `Daily image limit reached (${RATE_LIMIT_PER_24H} per 24 hours). Try again tomorrow, or take a moment with what you've already created.`,
      });
    }

    // ----- OpenAI Images API call -----
    // gpt-image-1 returns b64_json when response_format is set, which is
    // what we want so the client can persist the image inline.
    const openaiRes = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt,
        n: 1,
        size,
        // Standard quality is fine for vision boards and half the cost of
        // "high". Members can request a regeneration if they want more
        // detail.
        quality: "standard",
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text().catch(() => "");
      // Try to parse OpenAI's structured error so we can distinguish
      // between: real content-policy violation, model-not-available
      // (org verification required), rate limit, quota, and other
      // 400/403 conditions. Each needs a different member-facing
      // message and dev-facing log signal.
      let parsedErr = null;
      try { parsedErr = JSON.parse(errText); } catch (_) {}
      const errCode = parsedErr?.error?.code || parsedErr?.error?.type || null;
      const errMsg = parsedErr?.error?.message || errText.slice(0, 300);
      console.error("generate_image_openai_error", {
        status: openaiRes.status,
        code: errCode,
        message: errMsg,
        body: errText.slice(0, 500),
        user_id: user.id,
        prompt_preview: prompt.slice(0, 200),
        elapsed_ms: Date.now() - startedAt,
      });

      // Org-verification required (recent OpenAI change for gpt-image-1
      // — some accounts need to complete organization verification at
      // platform.openai.com before they can call this model).
      const lowerMsg = String(errMsg).toLowerCase();
      if (
        lowerMsg.includes("must be verified") ||
        lowerMsg.includes("verify your organization") ||
        lowerMsg.includes("organization verification") ||
        errCode === "organization_must_be_verified"
      ) {
        return res.status(400).json({
          error: "org_verification_required",
          message: "OpenAI needs to verify the organization before this model can be used. Visit platform.openai.com/settings/organization/general and complete verification.",
        });
      }

      // Model not available (usually means the API key doesn't have
      // access to gpt-image-1 yet or the model name is wrong).
      if (
        lowerMsg.includes("does not have access") ||
        lowerMsg.includes("model_not_found") ||
        errCode === "model_not_found"
      ) {
        return res.status(400).json({
          error: "model_unavailable",
          message: "The image model is not enabled on this OpenAI account. Check that gpt-image-1 is available under platform.openai.com/limits.",
        });
      }

      // Rate limit / quota.
      if (openaiRes.status === 429 || errCode === "rate_limit_exceeded" || errCode === "insufficient_quota") {
        return res.status(429).json({
          error: "openai_rate_limited",
          message: "OpenAI is rate-limiting or the account has no billing balance. Check platform.openai.com/usage.",
        });
      }

      // Real content policy violation — the prompt itself is what
      // tripped the safety filter.
      if (
        openaiRes.status === 400 &&
        (errCode === "content_policy_violation" ||
         lowerMsg.includes("safety system") ||
         lowerMsg.includes("content policy") ||
         lowerMsg.includes("did not pass"))
      ) {
        return res.status(400).json({
          error: "prompt_rejected",
          message: "OpenAI's safety system didn't accept that prompt. Try adjusting the wording.",
        });
      }

      // Anything else: surface the raw OpenAI message so we can see it
      // in the client instead of a generic "failed".
      return res.status(502).json({
        error: "image_generation_failed",
        message: "OpenAI: " + errMsg.slice(0, 200),
      });
    }

    const data = await openaiRes.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      console.error("generate_image_no_b64", { data_keys: Object.keys(data || {}) });
      return res.status(502).json({ error: "image_generation_empty" });
    }

    // Size cap. If the base64 is larger than our ceiling, something is
    // wrong on OpenAI's side (or we asked for a bigger variant). Reject
    // rather than persisting a 10MB image row.
    if (b64.length > MAX_B64_BYTES) {
      console.warn("generate_image_too_large", {
        user_id: user.id,
        bytes: b64.length,
      });
      return res.status(502).json({ error: "image_too_large" });
    }

    // ----- Persist to the AI's message if a messageId was supplied -----
    // Persistence flow: the AI emits a [[genimg:PROMPT]] token in its
    // response. The client renders that token as a loading card, then
    // POSTs here with the message_id. On success, we replace the
    // [[genimg:...]] token in that message's content with a
    // [[img:BASE64]] token so future page loads render the persisted
    // image inline without re-billing OpenAI. If message_id is missing
    // or invalid we still return the b64 to the client — the client
    // can display it, but the image will not survive a reload.
    let messageUpdated = false;
    const messageId = String(body.message_id || "").trim();
    if (messageId) {
      try {
        // Ownership check: only touch a message that belongs to this user
        // and is an assistant message. Prevents members from mutating each
        // other's rows via forged message_ids.
        const { rows: msgRows } = await sql`
          SELECT id, content FROM messages
          WHERE id = ${messageId}
            AND user_id = ${user.id}
            AND role = 'assistant'
          LIMIT 1
        `;
        if (msgRows[0]) {
          const oldContent = String(msgRows[0].content || "");
          // Replace the FIRST [[genimg:PROMPT]] match with [[img:BASE64]].
          // We rebuild the token literal from the request prompt so we
          // don't rely on a regex across arbitrary user text (prompts can
          // contain characters that would break a naive regex).
          const oldToken = `[[genimg:${prompt}]]`;
          if (oldContent.includes(oldToken)) {
            const newToken = `[[img:${b64}]]`;
            const newContent = oldContent.replace(oldToken, newToken);
            await sql`
              UPDATE messages
              SET content = ${newContent}
              WHERE id = ${messageId}
            `;
            messageUpdated = true;
          }
        }
      } catch (persistErr) {
        // Non-fatal — the client still gets the b64 back.
        console.warn("generate_image_persist_failed", {
          message_id: messageId,
          err: persistErr?.message,
        });
      }
    }

    console.log("generate_image_ok", {
      user_id: user.id,
      prompt_length: prompt.length,
      b64_length: b64.length,
      size,
      message_updated: messageUpdated,
      elapsed_ms: Date.now() - startedAt,
    });

    return res.status(200).json({
      image_b64: b64,
      mime_type: "image/png",
      size,
      message_updated: messageUpdated,
    });
  } catch (err) {
    console.error("generate_image_error", {
      message: err?.message,
      elapsed_ms: Date.now() - startedAt,
    });
    return res.status(500).json({ error: "internal_error" });
  }
}
