// api/transcribe.js
// Accepts a base64-encoded audio clip from the client, forwards it to
// OpenAI's Whisper API for transcription, and returns the resulting text.
//
// Auth: same session-token pattern as /api/chat. CORS gated to ALLOWED_ORIGINS.
// Cost: ~$0.006/minute of audio (Whisper-1). Per-call cost is capped by the
// client-side 5-minute recording limit (~3¢/clip worst case).

import { getUserBySessionToken } from "../lib/db.js";

// Allow up to 25MB request body. A 5-minute clip:
//   • WebM/Opus @ 48kbps ≈ 1.5MB (Chrome/Firefox default)
//   • Safari mp4 @ 128kbps ≈ 5MB
//   • Higher-bitrate codecs on some Android browsers ≈ 8-12MB
// Base64 encoding inflates by ~1.33x, so 25MB bodyParser accepts up to
// ~18MB of raw audio, comfortably fitting every codec at 5 minutes.
// Bumped July 2026 after members reported "recording is too large"
// errors — the previous 10MB limit + 5MB per-clip cap wasn't matching
// the 5-minute client-side recording ceiling.
export const config = {
  api: { bodyParser: { sizeLimit: "25mb" } }
};

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

// Map browser MIME types to the file extensions Whisper accepts.
// Whisper supports: flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm.
function extensionForMime(mimeType) {
  const mt = (mimeType || "").toLowerCase();
  if (mt.includes("webm")) return "webm";
  if (mt.includes("mp4")) return "mp4";
  if (mt.includes("ogg")) return "ogg";
  if (mt.includes("wav")) return "wav";
  if (mt.includes("mpeg") || mt.includes("mp3")) return "mp3";
  return "webm";
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const token = req.headers["x-session-token"];
    const user = await getUserBySessionToken(token);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("transcribe_no_openai_key");
      return res.status(500).json({ error: "transcription_unavailable" });
    }

    const { audioBase64, mimeType } = req.body || {};
    if (!audioBase64 || typeof audioBase64 !== "string") {
      return res.status(400).json({ error: "missing_audio" });
    }

    // Decode the base64 audio into a buffer.
    let audioBuffer;
    try {
      audioBuffer = Buffer.from(audioBase64, "base64");
    } catch (e) {
      return res.status(400).json({ error: "invalid_audio_encoding" });
    }

    // Sanity-check size. < 1KB is almost certainly an empty recording.
    // Whisper accepts up to 25MB per file. We cap at 20MB to leave headroom
    // for the HTTP overhead + slight base64 decoding variance. A 5-minute
    // Safari mp4 recording at 128 kbps is ~5MB, and 5 min at 256 kbps ≈
    // 10MB — 20MB safely covers every browser at the full client-side 5-min
    // recording ceiling. Previous 5MB cap assumed 60-second clips and was
    // the cause of the "recording is too large" errors members reported.
    if (audioBuffer.length < 1000) {
      return res.status(400).json({ error: "audio_too_short" });
    }
    if (audioBuffer.length > 20 * 1024 * 1024) {
      return res.status(413).json({ error: "audio_too_large" });
    }

    const ext = extensionForMime(mimeType);
    const filename = `audio.${ext}`;
    const fileType = mimeType || `audio/${ext}`;

    // Build multipart form data the way OpenAI's audio endpoint expects.
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: fileType });
    formData.append("file", blob, filename);
    formData.append("model", "whisper-1");
    // Language auto-detection enabled. Whisper detects the spoken language
    // automatically when no language parameter is provided. This lets the
    // Field support clients in any language they speak naturally.
    //
    // Bias the transcription toward our domain vocabulary to reduce
    // mishears of terms like "Human Instrument", "Master Your Path", etc.
    // WARNING — Whisper prompt biasing leaks: if the prompt contains
    // repetitive patterns like "Day 1: X. Day 2: Y. Day 3: Z.", Whisper
    // will hallucinate that pattern into low-confidence transcription
    // windows (silences, quiet openings, accented speech). Root-caused
    // 2026-07-23 when Antonella's recording of her anchor sentence was
    // prepended with a fabricated "Day 4. Decision. Day 5. Decision.
    // Day 6. Decision. Day 7. Decision." because the old prompt taught
    // Whisper that pattern. Keep the vocabulary here as PROSE, never
    // as a list of "Day N: X" pairs.
    formData.append(
      "prompt",
      "Master Your Path. The Freedom Intelligence Field. Human Instrument method by Shimrit Nativ. The 72-Hour Power Reset guides members through a state reset, an aligned decision, and calibrated action."
    );

    const openaiRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text().catch(() => "");
      console.error("transcribe_openai_error", {
        status: openaiRes.status,
        body: errText.slice(0, 200)
      });
      return res.status(502).json({ error: "transcription_failed" });
    }

    const data = await openaiRes.json();
    const text = ((data && data.text) || "").trim();

    return res.status(200).json({ text });
  } catch (err) {
    console.error("transcribe_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
