// api/transcribe.js
// Accepts a base64-encoded audio clip from the client, forwards it to
// OpenAI's Whisper API for transcription, and returns the resulting text.
//
// Auth: same session-token pattern as /api/chat. CORS gated to ALLOWED_ORIGINS.
// Cost: ~$0.006/minute of audio (Whisper-1). Per-call cost is capped by the
// client-side 5-minute recording limit (~3¢/clip worst case).

import { getUserBySessionToken } from "../lib/db.js";
import { notifyAdmins } from "../lib/adminNotify.js";

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
    // Language hint. Sourced from the user's stored `preferred_language`
    // ONLY — never from a client-side body field or navigator.language.
    //
    // Why not navigator.language: multilingual members set their browser
    // to their native locale but often speak English inside The Field.
    // Antonella (Italian browser, Sep 2026) got her English speech
    // transcribed as Italian because navigator.language forced Whisper
    // into Italian mode. Whisper's `language` param is a hard input
    // hint, not a soft suggestion: setting it to "it" tells Whisper
    // the audio IS Italian, which produces Italian text for English
    // input.
    //
    // Only a curated allow-list of codes is passed through. When no
    // preference is stored, we fall back to Whisper auto-detect — this
    // works well for English/Italian/Spanish/etc. speakers; Danish
    // speakers who hit the auto-detect Swedish confusion should set
    // their preference to "da" (Susse's fix).
    const ALLOWED_LANGUAGES = new Set([
      "en", "da", "sv", "no", "nb", "nn", "fi",
      "it", "es", "pt", "fr", "de", "nl",
      "pl", "cs", "sk", "hu", "ro", "bg", "el",
      "ru", "uk", "he", "ar", "tr",
      "ja", "ko", "zh",
    ]);
    const storedPref = user.preferred_language
      ? String(user.preferred_language).trim().toLowerCase().split(/[-_]/)[0]
      : "";
    const validLanguage = ALLOWED_LANGUAGES.has(storedPref) ? storedPref : null;

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

    // The multipart body is built inside the retry loop below, because a
    // FormData whose body has been sent cannot be re-sent on a second
    // attempt. Two fields go into it:
    //
    // Language hint. Only forwarded when the user has EXPLICITLY set a
    // preferred_language via Your Account → Preferences. See the block
    // above for why navigator.language is a bad source. If no
    // preference is stored, Whisper auto-detects, which works reliably
    // for most speakers.
    //
    // Whisper prompt bias intentionally OFF (see history below).
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

    // Call Whisper with a per-attempt deadline and one retry.
    //
    // Before this, the call had no timeout and no retry: a slow or flaky
    // response from OpenAI hung until the platform killed the function,
    // and a single transient 429 or 5xx surfaced to the member as "our
    // transcription service hiccupped" with no second attempt. Members
    // recording two or three minutes lost the transcription and re-recorded
    // the whole thing (reported October 2026).
    //
    // 120s per attempt is generous even for the 15-minute client ceiling,
    // and two attempts fit inside the 300s function budget set in
    // vercel.json with room to spare. Only transport errors, 408, 429 and
    // 5xx are retried: a 400 means the audio itself is the problem and
    // sending it again would fail the same way.
    const OPENAI_ATTEMPT_TIMEOUT_MS = 120 * 1000;
    const retryableStatus = (s) => s === 408 || s === 429 || s >= 500;

    let openaiRes = null;
    let lastStatus = 0;
    let lastErrText = "";
    let transportError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const ac = new AbortController();
      const killer = setTimeout(() => ac.abort(), OPENAI_ATTEMPT_TIMEOUT_MS);
      try {
        // FormData is rebuilt per attempt: a consumed body cannot be re-sent.
        const fd = new FormData();
        fd.append("file", new Blob([audioBuffer], { type: fileType }), filename);
        fd.append("model", "whisper-1");
        if (validLanguage) fd.append("language", validLanguage);

        const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: fd,
          signal: ac.signal,
        });
        if (r.ok) { openaiRes = r; break; }

        lastStatus = r.status;
        lastErrText = await r.text().catch(() => "");
        if (attempt === 2 || !retryableStatus(r.status)) break;
        console.warn("transcribe_openai_retry", {
          attempt: attempt, status: r.status, user_id: user.id,
          audio_bytes: audioBuffer.length,
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
      } catch (e) {
        transportError = e;
        if (attempt === 2) break;
        console.warn("transcribe_openai_retry", {
          attempt: attempt,
          reason: e && e.name === "AbortError" ? "attempt_timeout" : "transport",
          message: e && e.message, user_id: user.id,
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
      } finally {
        clearTimeout(killer);
      }
    }

    if (!openaiRes) {
      const reason = transportError
        ? (transportError.name === "AbortError" ? "attempt_timeout" : "transport_error")
        : ("http_" + lastStatus);
      console.error("transcribe_openai_error", {
        status: lastStatus,
        body: lastErrText.slice(0, 200),
        transport: transportError
          ? (transportError.name === "AbortError" ? "attempt_timeout" : transportError.message)
          : null,
        reason: reason,
        audio_bytes: audioBuffer.length,
        mime_type: mimeType,
        user_id: user.id,
        elapsed_ms: Date.now() - startedAt,
      });

      // Tell the team now rather than waiting for the member to complain.
      // Vercel's runtime logs are short-lived and awkward to query after the
      // fact, so the October 2026 reports arrived long after the evidence had
      // aged out. Deliberately carries no transcript and no audio, only who
      // it happened to and what broke.
      //
      // notificationKey is bucketed by the hour, and it is the dedup key in
      // push_notifications_sent, so an OpenAI outage sends one ping an hour
      // instead of one per member.
      try {
        const hourBucket = new Date().toISOString().slice(0, 13);
        await notifyAdmins({
          title: "A voice note failed to transcribe",
          body: `${user.email}: ${reason}, ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB `
            + `of ${mimeType || "audio"}, after ${Math.round((Date.now() - startedAt) / 1000)}s. `
            + `Their recording is still on their screen behind Try again.`,
          url: "/admin/members",
          tag: "transcribe-fail",
          notificationKey: `transcribe-fail-${hourBucket}`,
          requireInteraction: false,
        });
      } catch (e) {
        console.error("transcribe_notify_failed", { message: e && e.message });
      }

      return res.status(502).json({ error: "transcription_failed" });
    }

    const data = await openaiRes.json();
    let text = ((data && data.text) || "").trim();

    // Whisper YouTube-boilerplate stripper.
    //
    // Whisper was trained on YouTube captions and often hallucinates
    // subscription callouts at the end of transcriptions when the audio
    // has silence, background noise, or a pause. These come in many
    // languages regardless of what the member actually spoke —
    // Antonella (Italian) got Japanese "チャンネル登録をお願いいたします"
    // ("please subscribe to my channel") tacked onto her English
    // transcript, 2026-08-30.
    //
    // Strategy: match a curated list of known Whisper boilerplate
    // phrases anywhere in the text and remove them. Case-insensitive.
    // Whitespace and punctuation around the phrase get cleaned up too.
    const WHISPER_BOILERPLATE = [
      // English YouTube outros
      /thanks?\s+(you\s+)?for\s+watching[.!]?/gi,
      /please\s+subscribe(?:\s+to\s+(?:my|our|the)\s+channel)?[.!]?/gi,
      /don'?t\s+forget\s+to\s+subscribe[.!]?/gi,
      /like\s+and\s+subscribe[.!]?/gi,
      /see\s+you\s+in\s+the\s+next\s+video[.!]?/gi,
      /subscribe\s+to\s+(?:my|our|the)\s+channel[.!]?/gi,
      // Chinese (simplified + traditional): "Thanks for watching",
      // "Please subscribe", "Please like/subscribe/share"
      /感谢您的观看[.。!！]?/g,
      /感謝您的觀看[.。!！]?/g,
      /请订阅我的频道[.。!！]?/g,
      /請訂閱我的頻道[.。!！]?/g,
      /请点赞订阅[.。!！]?/g,
      // Japanese: channel subscription callouts
      /チャンネル登録[をお]?願いいたします[.。!！]?/g,
      /チャンネル登録[をお]?願いします[.。!！]?/g,
      /高評価[とと]?チャンネル登録[.。!！]?/g,
      /ご視聴ありがとうございました[.。!！]?/g,
      // Korean
      /구독과\s*좋아요\s*부탁드립니다[.。!！]?/g,
      /구독\s*부탁드립니다[.。!！]?/g,
      // Russian: "Don't forget to subscribe"
      /не\s+забудьте\s+подписаться[.!]?/gi,
      /подпишитесь\s+на\s+(?:мой|наш)\s+канал[.!]?/gi,
      // Spanish
      /gracias\s+por\s+ver[.!]?/gi,
      /suscr[ií]bete\s+al\s+canal[.!]?/gi,
      // French
      /merci\s+d'avoir\s+regard[ée][.!]?/gi,
      /abonnez-vous[.!]?/gi,
      // Portuguese
      /obrigad[oa]\s+por\s+assistir[.!]?/gi,
      // German
      /vielen\s+dank\s+f[üu]rs?\s+zuschauen[.!]?/gi,
      // Arabic (subscription/like)
      /اشترك\s+في\s+القناة/g,
    ];
    let strippedBoilerplate = false;
    for (const pattern of WHISPER_BOILERPLATE) {
      if (pattern.test(text)) {
        strippedBoilerplate = true;
        text = text.replace(pattern, "");
      }
    }
    // Also strip a trailing block of characters that switches scripts
    // (Latin body + CJK/Cyrillic/Arabic tail, or vice versa). Covers
    // hallucinations we don't have a specific phrase pattern for.
    // We look at the last 60 chars; if it contains any characters
    // whose script differs from the majority script of the body,
    // and the tail is at least 4 chars long, we drop the mismatched
    // trailing span.
    (function stripScriptMismatchTail() {
      if (text.length < 40) return;
      const body = text.slice(0, Math.floor(text.length * 0.7));
      const tail = text.slice(Math.floor(text.length * 0.7));
      // CJK/Cyrillic/Arabic script detection.
      const bodyHasCjk = /[぀-ヿ一-鿿]/.test(body);
      const bodyHasCyrillic = /[Ѐ-ӿ]/.test(body);
      const bodyHasArabic = /[؀-ۿ]/.test(body);
      const tailCjkMatch = tail.match(/[぀-ヿ一-鿿][぀-ヿ一-鿿\s.。!！?？]*$/);
      const tailCyrillicMatch = tail.match(/[Ѐ-ӿ][Ѐ-ӿ\s.!?]*$/);
      const tailArabicMatch = tail.match(/[؀-ۿ][؀-ۿ\s.!?]*$/);
      if (tailCjkMatch && !bodyHasCjk && tailCjkMatch[0].length >= 3) {
        text = text.slice(0, text.length - tailCjkMatch[0].length).trim();
        strippedBoilerplate = true;
      } else if (tailCyrillicMatch && !bodyHasCyrillic && tailCyrillicMatch[0].length >= 3) {
        text = text.slice(0, text.length - tailCyrillicMatch[0].length).trim();
        strippedBoilerplate = true;
      } else if (tailArabicMatch && !bodyHasArabic && tailArabicMatch[0].length >= 3) {
        text = text.slice(0, text.length - tailArabicMatch[0].length).trim();
        strippedBoilerplate = true;
      }
    })();
    // Clean up any doubled spaces / trailing punctuation the stripping
    // left behind.
    text = text.replace(/\s+/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
    if (strippedBoilerplate) {
      console.log("transcribe_boilerplate_stripped", {
        user_id: user.id,
        final_length: text.length,
      });
    }

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
