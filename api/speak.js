// api/speak.js
// Accepts text from the client, forwards it to ElevenLabs TTS with Shimrit's
// cloned voice, returns the resulting audio as MP3 bytes.
//
// Auth: same session-token pattern as /api/chat. CORS gated to ALLOWED_ORIGINS.
// Cost: ElevenLabs charges per character. Creator plan = 100K chars/month.

import { getUserBySessionToken } from "../lib/db.js";

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } }
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

// Cap text length to prevent runaway costs. The Day 3 Living Power
// Declaration runs ~60-90 seconds of spoken audio (~600-1200 chars) and we
// leave headroom for participant message TTS and slightly longer Day 3
// declarations. 2500 chars is roughly 3 minutes max at ~10 chars/sec.
const MAX_TEXT_LENGTH = 2500;

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

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!apiKey || !voiceId) {
      console.error("speak_missing_credentials", {
        hasKey: !!apiKey,
        hasVoiceId: !!voiceId
      });
      return res.status(500).json({ error: "tts_unavailable" });
    }

    const { text } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "missing_text" });
    }

    const cleanText = text.trim();
    if (cleanText.length === 0) {
      return res.status(400).json({ error: "empty_text" });
    }
    if (cleanText.length > MAX_TEXT_LENGTH) {
      return res.status(413).json({ error: "text_too_long" });
    }

    // ElevenLabs TTS endpoint. Returns audio/mpeg bytes directly.
    // Using eleven_flash_v2_5: supports 32 languages including Hebrew, low
    // latency, and works with cloned voices like Shimrit's. Matches our
    // Whisper auto-detect flow so the AI can answer in any language the
    // participant speaks and the response is read back in that language.
    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
    const ttsBody = {
      text: cleanText,
      model_id: "eleven_flash_v2_5",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true
      }
    };

    const ttsRes = await fetch(ttsUrl, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify(ttsBody)
    });

    if (!ttsRes.ok) {
      const errText = await ttsRes.text().catch(() => "");
      console.error("speak_elevenlabs_error", {
        status: ttsRes.status,
        body: errText.slice(0, 300)
      });
      return res.status(502).json({ error: "tts_failed" });
    }

    // Get the audio bytes from ElevenLabs and send them to the client.
    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(audioBuffer.length));
    return res.status(200).send(audioBuffer);
  } catch (err) {
    console.error("speak_error", { message: err?.message });
    return res.status(500).json({ error: "internal_error" });
  }
}
