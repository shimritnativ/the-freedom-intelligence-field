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

  const startedAt = Date.now();
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
    // Whisper prompt bias intentionally OFF.
    //
    // History: we used to pass a domain-vocabulary prompt here
    // ("Master Your Path. The Freedom Intelligence Field. Human
    // Instrument method by Shimrit Nativ. The 72-Hour Power Reset
    // guides members through a state reset, an aligned decision,
    // and calibrated action.") to reduce mishears of terms like
    // "Human Instrument" and "Master Your Path".
    //
    // The bias LEAKED into low-confidence windows — silences,
    // quiet openings, soft speech, non-English audio, Danish
    // accented English — and Whisper output the prompt VERBATIM
    // or in garbled form as if the member had spoken it.
    //   - 2026-07-23: Antonella's anchor recording got a
    //     fabricated "Day 4. Decision. Day 5. Decision. Day 6.
    //     Decision. Day 7. Decision." prepended (list-pattern
    //     prompt taught Whisper that structure).
    //   - 2026-08-28: Susse (Danish) had multiple recordings
    //     transcribed as literal "The 72-Hour Power Reset guides
    //     members through a state reset, an aligned decision, and
    //     calibrated action." and as garbled "A security measure
    //     is used to align with the state reserve conductors."
    //
    // Prose alone did not solve it — Whisper hallucinates prompts
    // from any format when the audio has room. Only reliable fix
    // is no prompt at all. We accept occasional mistranscription
    // of "Human Instrument" as "human instructor" in exchange for
    // zero fabricated marketing copy in members' journals.
    //
    // Do NOT add a `prompt` field back without a proven mitigation
    // (e.g. VAD trimming of silence, per-language separate paths).

    const openaiRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text().catch(() => "");
      console.error("transcribe_openai_error", {
        status: openaiRes.status,
        body: errText.slice(0, 200),
        audio_bytes: audioBuffer.length,
        mime_type: mimeType,
        user_id: user.id,
        elapsed_ms: Date.now() - startedAt,
      });
      return res.status(502).json({ error: "transcription_failed" });
    }

    const data = await openaiRes.json();
    const text = ((data && data.text) || "").trim();

    // Whisper repetition-hallucination guard.
    //
    // Even with no prompt bias, Whisper occasionally locks into a loop
    // and returns the same short phrase repeated 3+ times, sometimes
    // in a language different from what the member actually spoke
    // (Antonella, Italian speaker, 2026-08-29: got "3-4 хвилини
    // попередніше 3-4 хвилини попередніше 3-4 хвилини попередніше" —
    // Ukrainian for "3-4 minutes previously" x3 — while she was still
    // recording her Frequency Booster session in Italian).
    //
    // This is a known Whisper failure mode triggered by long silences,
    // background noise, or ambiguous language detection. The fix is to
    // detect the repetition pattern server-side and refuse to return
    // the hallucination as if it were real speech. The member sees a
    // clean error and re-records, rather than seeing gibberish appear
    // in their input.
    //
    // Detection heuristic: split on whitespace; if there is a token
    // sequence of 2+ words that repeats 3+ times consecutively, and
    // the repeated block accounts for most of the total text, it is a
    // hallucination. Legitimate speech almost never repeats the same
    // phrase 3 times in a row.
    function looksLikeRepetitionHallucination(t) {
      if (!t || t.length < 20) return false;
      const words = t.split(/\s+/).filter(Boolean);
      if (words.length < 6) return false;
      // Try phrase lengths 2..6 words. If any consecutive repetition
      // of the same phrase covers >= 60% of the words, it's hallucinated.
      for (let phraseLen = 2; phraseLen <= 6; phraseLen++) {
        for (let start = 0; start + phraseLen * 3 <= words.length; start++) {
          const phrase = words.slice(start, start + phraseLen).join(" ").toLowerCase();
          let reps = 1;
          let cursor = start + phraseLen;
          while (cursor + phraseLen <= words.length &&
                 words.slice(cursor, cursor + phraseLen).join(" ").toLowerCase() === phrase) {
            reps++;
            cursor += phraseLen;
          }
          if (reps >= 3 && (reps * phraseLen) / words.length >= 0.6) {
            return { phrase, reps };
          }
        }
      }
      return false;
    }
    const rep = looksLikeRepetitionHallucination(text);
    if (rep) {
      console.warn("transcribe_repetition_hallucination", {
        user_id: user.id,
        audio_bytes: audioBuffer.length,
        text_preview: text.slice(0, 200),
        repeated_phrase: rep.phrase,
        repetition_count: rep.reps,
      });
      return res.status(422).json({
        error: "audio_unclear",
        message: "The recording didn't transcribe cleanly. Please try again in a quieter space, or speak a little closer to the microphone.",
      });
    }

    // Success-path logging so we can spot patterns without waiting
    // for a user report. Every transcribe leaves a trace with the
    // audio size, mime type, whether Whisper returned empty text,
    // and round-trip time. Cross-reference with Vercel's own 413
    // logs (which fire BEFORE our handler runs for oversized
    // uploads) to see the full picture.
    console.log("transcribe_ok", {
      audio_bytes: audioBuffer.length,
      mime_type: mimeType,
      text_length: text.length,
      text_empty: text.length === 0,
      user_id: user.id,
      elapsed_ms: Date.now() - startedAt,
    });

    return res.status(200).json({ text });
  } catch (err) {
    console.error("transcribe_error", {
      message: err?.message,
      elapsed_ms: Date.now() - startedAt,
    });
    return res.status(500).json({ error: "internal_error" });
  }
}
