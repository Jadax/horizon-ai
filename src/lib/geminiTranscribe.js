/**
 * GEMINI AUDIO TRANSCRIPTION — one shared word-timestamp transcriber.
 *
 * Was duplicated in agent3_audio.js (voiceover alignment) and
 * agent6_clipper.js (clip transcription): same hand-rolled fetch, same
 * prompt, same parse/filter pipeline. Worse, each copy had its own bug —
 * agent6 labeled raw ≤20MB video buffers as "audio/mp3" (Gemini rejects or
 * mistranscribes container data), and neither path rotated API keys, so a
 * single throttled key killed runs that llmJson-based calls would have
 * survived. This module is the single source: callers pass real mp3 audio.
 */
import { config } from "../config.js";
import { geminiKeys } from "./llm.js";

const TRANSCRIBE_PROMPT =
  'Transcribe this audio with per-word timestamps. Return JSON only: {"words":[{"word":"...","start":0.0,"end":0.4},...]} with start/end in seconds, covering every spoken word in order.';

/**
 * Transcribe an mp3 buffer into [{word, start, end}] with per-word
 * timestamps. Rotates every configured Gemini key before failing.
 * @param {Buffer} audioBuffer mp3-encoded audio
 * @param {object} [opts]
 * @param {string} [opts.referenceScript] optional script hint improves
 *   homophone disambiguation (sent truncated)
 * @returns {Promise<Array<{word:string,start:number,end:number}>>}
 */
export async function transcribeWords(audioBuffer, { referenceScript = null } = {}) {
  if (!audioBuffer?.byteLength) throw new Error("transcribeWords: empty audio buffer");
  const keys = geminiKeys();
  if (!keys.length) throw new Error("GEMINI_API_KEY not set — cannot transcribe");

  const body = {
    contents: [{ parts: [
      { text: referenceScript
        ? `${TRANSCRIBE_PROMPT} For reference, the intended script was: ${referenceScript.slice(0, 500)}`
        : TRANSCRIBE_PROMPT },
      { inlineData: { mimeType: "audio/mp3", data: audioBuffer.toString("base64") } },
    ] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  };

  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${keys[i]}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        }
      );
      const json = await res.json();
      if (json.error) throw new Error(`Gemini transcribe: ${json.error.message?.slice(0, 120)}`);
      const parsed = JSON.parse(json.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
      return (parsed.words || [])
        .map((w) => ({ word: String(w.word || "").trim(), start: Number(w.start), end: Number(w.end) }))
        .filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
    } catch (err) {
      lastErr = err;
      console.warn(`[transcribe] key ${i + 1}/${keys.length}: ${err.message} — trying next`);
    }
  }
  throw lastErr || new Error("transcribeWords: all keys failed");
}

/** Convert any media buffer to mono 16 kHz mp3 via ffmpeg — the format the
 * transcription endpoint expects. Used for BOTH large uploads and small
 * ones: sending a raw .mp4/.webm container as "audio/mp3" used to be the
 * silent killer of small-file clip jobs. */
export async function toTranscribableMp3(buffer, ffmpegPath) {
  // Lazy imports keep this module dependency-light at load time.
  const { writeFile, readFile, unlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const inFile = path.join(tmpdir(), `horizon-audio-in-${randomUUID()}`);
  const outFile = path.join(tmpdir(), `horizon-audio-${randomUUID()}.mp3`);
  try {
    await writeFile(inFile, buffer);
    await execFileAsync(
      ffmpegPath,
      ["-y", "-i", inFile, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", outFile],
      { timeout: 300000 }
    );
    return await readFile(outFile);
  } finally {
    await unlink(inFile).catch(() => {});
    await unlink(outFile).catch(() => {});
  }
}
