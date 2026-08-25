import { config } from "../config.js";
import { execFileAsync as sharedExec, parseFfmpegDuration } from "../lib/utils.js";
import { supabase, logEvent } from "../supabase.js";
import { synthesizeSpeech } from "../lib/freeTTS.js";
import { verifyContentIdSafety, pickCopyrightFreeMusic } from "../lib/musicBrain.js";
import { transcribeWords } from "../lib/geminiTranscribe.js";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpeg from "ffmpeg-static";

const execFileAsync = sharedExec;

// Gemini TTS has a per-request character ceiling well below a whole script,
// and a truncated synthesis used to burn whole-script retries. Chunking by
// sentence keeps every request comfortably inside the reliable range, and
// the chunks are concatenated into one voiceover track afterwards. The
// Devanagari danda (।) is a sentence terminator too — without it a whole
// Hindi script became one >280-char chunk and defeated the ceiling.
const TTS_CHUNK_MAX_CHARS = 280;

function splitScriptForTTS(script) {
    const sentences = String(script).match(/[^.!?।]+[.!?।]*\s*/g) || [String(script)];
    const chunks = [];
    let current = "";
    for (const sentence of sentences) {
        if (current && (current + sentence).length > TTS_CHUNK_MAX_CHARS) {
            chunks.push(current.trim());
            current = sentence;
        } else {
            current += sentence;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

async function concatAudioBuffers(buffers) {
    if (buffers.length === 1) return buffers[0];
    const tmpDir = tmpdir();
    const partFiles = [];
    const listFile = path.join(tmpDir, `horizon-ttslist-${randomUUID()}.txt`);
    const outFile = path.join(tmpDir, `horizon-ttscat-${randomUUID()}.mp3`);
    try {
        for (const buffer of buffers) {
            const partFile = path.join(tmpDir, `horizon-ttspart-${randomUUID()}.mp3`);
            await writeFile(partFile, buffer);
            partFiles.push(partFile);
        }
        await writeFile(listFile, partFiles.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
        // Re-encode rather than -c copy: chunk MP3s can differ in encoder
        // delay/padding, and copy-concat produces audible clicks at joins.
        await execFileAsync(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c:a", "libmp3lame", "-q:a", "2", outFile], { timeout: 120000 });
        return await readFile(outFile);
    } finally {
        for (const f of [...partFiles, listFile, outFile]) await unlink(f).catch(() => {});
    }
}

async function removeSilence(audioBuffer) {
    const tmpDir = tmpdir();
    const inFile = path.join(tmpDir, `horizon-silin-${randomUUID()}.mp3`);
    const outFile = path.join(tmpDir, `horizon-silout-${randomUUID()}.mp3`);
    try {
        await writeFile(inFile, audioBuffer);
        // silenceremove: trim leading silence (0.1s), remove internal silence
        // gaps >0.5s by compressing them to 0.3s, keep speech intact.
        await execFileAsync(ffmpeg, [
            "-y", "-i", inFile,
            "-af", "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB:stop_periods=-1:stop_duration=0.5:stop_threshold=-50dB:window=0.02",
            "-c:a", "libmp3lame", "-q:a", "2", outFile
        ], { timeout: 60000 });
        return await readFile(outFile);
    } catch {
        return audioBuffer;
    } finally {
        await unlink(inFile).catch(() => {});
        await unlink(outFile).catch(() => {});
    }
}

export async function synthesizeVoiceover(script, voiceId, jobId, expectedMaxSeconds = 58, options = {}) {
    const lang = options.lang || "en";
    await logEvent("Agent 3", `Synthesizing voiceover using free TTS (${config.ttsEngine})...`, { jobId });

    try {
        // Escalation ladder: chunked synthesis twice (chunking alone removes
        // the early-stop failure mode on long inputs), then gTTS for the
        // whole script as the engine of last resort — robotic beats a dead
        // run. Attempts 1-2 align STRICTLY (no proportional-timing rescue):
        // if the primary engine truncated the audio, strict alignment is
        // what notices, and the old code's retry condition matched an error
        // string nothing ever threw, so attempts 2-3 were unreachable dead
        // code and truncated audio sailed through with fake even timing.
        const chunks = splitScriptForTTS(script);
        let audioBuffer, words;
        for (let attempt = 1; ; attempt++) {
            if (attempt >= 3) {
                await logEvent("Agent 3", `Falling back to gtts for this run (primary engine kept failing alignment)`, { jobId, level: "warn" });
                audioBuffer = await synthesizeSpeech(script, voiceId, { speed: 1.0, lang, engine: 'gtts' });
            } else {
                const parts = [];
                for (const chunk of chunks) {
                    // options.engine lets a caller pin a specific engine (e.g.
                    // Leo pinning the cloned ElevenLabs voice) without
                    // changing the global TTS_ENGINE default.
                    parts.push(await synthesizeSpeech(chunk, voiceId, { speed: 1.0, lang, engine: options.engine }));
                }
                audioBuffer = await concatAudioBuffers(parts);
                audioBuffer = await removeSilence(audioBuffer);
            }
            try {
                words = await alignGeneratedSpeech(audioBuffer, script, jobId, { strict: attempt < 3 });
                break;
            } catch (err) {
                if (attempt >= 3) throw err;
                await logEvent("Agent 3", `TTS output failed verification (attempt ${attempt}/3, ${chunks.length} chunk(s)): ${err.message} — retrying`, { jobId, level: "warn" });
            }
        }
        if (!words.length) throw new Error("TTS alignment produced no word timestamps");
        const duration = words[words.length - 1].end;

        const path = `voiceovers/${jobId}.mp3`;
        const { error } = await supabase.storage
            .from("renders")
            .upload(path, audioBuffer, { contentType: "audio/mpeg", upsert: true });
        if (error) throw new Error(`Voiceover upload failed: ${error.message}`);

        const { data } = supabase.storage.from("renders").getPublicUrl(path);
        if (duration > expectedMaxSeconds) {
            await logEvent(
                "Agent 3",
                `⚠ Voiceover is ${Math.round(duration)}s — longer than target`,
                { jobId, level: "warn" }
            );
        }

    await logEvent(
        "Agent 3",
        `Voiceover ready: ${Math.round(duration)}s, ${words.length} word timestamps (FREE: ${config.ttsEngine})`,
        { jobId }
    );
        return { voiceoverUrl: data.publicUrl, words, duration, syncPrecisionMs: config.subtitleSyncPrecisionMs };
    } catch (error) {
        await logEvent("Agent 3", `TTS failed: ${error.message}`, { jobId, level: "error" });
        throw error;
    }
}

/**
 * Word-level alignment via Gemini's native audio understanding.
 * Gemini-only — no Whisper/OpenAI fallback. Routes through the shared
 * lib/geminiTranscribe.js (key rotation + one prompt definition) instead of
 * its own hand-rolled fetch.
 */
async function alignWithGemini(audioBuffer, script) {
    const words = await transcribeWords(audioBuffer, { referenceScript: script });
    for (let i = 1; i < words.length; i++) {
        if (words[i].start < words[i - 1].start - 0.05) throw new Error("Gemini align: non-monotonic timestamps");
    }
    const expected = script.split(/\s+/).filter(Boolean).length;
    if (!words.length || words.length / expected < 0.7) {
        throw new Error(`Gemini align: coverage too low (${words.length}/${expected})`);
    }
    return words;
}

async function probeAudioDuration(audioBuffer) {
  const tmp = path.join(tmpdir(), `horizon-align-${randomUUID()}.mp3`);
  try {
    await writeFile(tmp, audioBuffer);
    try {
      const { stderr } = await execFileAsync(ffmpeg, ["-i", tmp], { timeout: 20000 });
      return parseDuration(stderr);
    } catch (err) {
      // ffmpeg -i without output exits non-zero but prints metadata to stderr
      return parseDuration(err.stderr || "");
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

const parseDuration = parseFfmpegDuration;

/**
 * Evenly-paced word timing fallback (stolen from Fully-Automated-YouTube-Channel
 * create_videos.py:64-67,201-209): when real alignment fails, split the script
 * into words and spread them proportionally across the measured audio
 * duration. Visually acceptable (4-word-style chunks) and costs zero API
 * calls — keeps the render alive instead of failing the whole run.
 */
async function proportionalFallback(script, audioBuffer) {
  const duration = await probeAudioDuration(audioBuffer);
  if (!duration) return null;
  const words = String(script || "").split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const perWord = duration / words.length;
  return words.map((word, i) => ({
    word,
    start: Number((i * perWord).toFixed(3)),
    end: Number(((i + 1) * perWord).toFixed(3)),
  }));
}

export async function alignGeneratedSpeech(audioBuffer, script, jobId, { strict = false } = {}) {
  try {
    return await alignWithGemini(audioBuffer, script);
  } catch (err) {
    // strict mode (TTS escalation ladder): never rescue with evenly-spread
    // fake timing — the ladder needs the failure to escalate to gTTS.
    // Proportional timing is only acceptable as a last resort AFTER the
    // final engine attempt.
    if (strict) throw err;
    const fallback = await proportionalFallback(script, audioBuffer).catch(() => null);
    if (fallback) {
      await logEvent("Agent 3", `Audio alignment failed (${err.message}) — using proportional word timing`, { jobId, level: "warn" });
      return fallback;
    }
    await logEvent("Agent 3", `Audio alignment failed: ${err.message}`, { jobId, level: "error" });
    throw err;
  }
}

export async function pickMusic(energyLevel, jobId, brief = {}) {
    const { data, error } = await supabase
        .from("music_library")
        .select("*")
        .eq("energy_level", energyLevel);
    if (error || !data?.length) {
        await logEvent("Agent 3", `No ${energyLevel} track in music_library — querying live copyright-free sources (Pixabay/FMA/Incompetech)`, {
            jobId,
            level: "warn",
        });
        // Music-brain fallback: when the library is empty for this energy
        // level, go hit the multi-source engine live and bank the winner into
        // the library so the next run is served from cache. Script + niche are
        // threaded through so the Gemini relevance pass can actually judge
        // emotional fit instead of falling back to its neutral 5.
        const found = await pickCopyrightFreeMusic({
            energy: energyLevel,
            moods: brief.moods || [],
            genres: brief.genres || [],
            bpm: Array.isArray(brief.bpm) ? brief.bpm : [60, 140],
            script: brief.script || "",
            niche: brief.niche || "",
            jobId,
        }).catch((e) => {
            logEvent("Agent 3", `Live music search failed: ${e.message}`, { jobId, level: "warn" });
            return null;
        });
        if (found) {
            await supabase
                .from("music_library")
                .insert({
                    title: found.title,
                    track_url: found.track_url,
                    energy_level: energyLevel,
                    mood_tags: [...(found.mood_tags || []), `source:${found.source}`],
                    genre: found.genre,
                    bpm: found.bpm,
                    instrumental: true,
                    license: `${found.license} | content_id_safe: ${found.contentIdSafe}`,
                })
                .then(() => {})
                .catch(() => {});
            return found;
        }
        await logEvent("Agent 3", `No ${energyLevel} music found anywhere — rendering without music`, { jobId, level: "warn" });
        return null;
    }

    // Score: mood match + genre match + BPM range + instrumental + Content-ID safety
    const wantedMoods = (brief.moods || []).map((v) => String(v).toLowerCase());
    const wantedGenres = (brief.genres || []).map((v) => String(v).toLowerCase());
    const [bpmLow, bpmHigh] = Array.isArray(brief.bpm) ? brief.bpm.map(Number) : [0, Infinity];

    const scored = data.map((track) => {
        const moods = Array.isArray(track.mood_tags) ? track.mood_tags.map((v) => String(v).toLowerCase()) : [];
        const genre = String(track.genre || "").toLowerCase();
        let score = 0;
        score += wantedMoods.filter((mood) => moods.includes(mood)).length * 4;
        score += wantedGenres.some((wanted) => genre.includes(wanted)) ? 3 : 0;
        score += Number.isFinite(Number(track.bpm)) && Number(track.bpm) >= bpmLow && Number(track.bpm) <= bpmHigh ? 2 : 0;
        score += track.instrumental === true ? 1 : 0;

        // Content ID safety bonus: safe tracks get +5, unknown license gets +0
        const safety = verifyContentIdSafety({ license: track.license, source: track.source, title: track.title });
        score += safety.safe ? 5 : 0;

        return { track, score: score + Math.random() * 0.25, safe: safety.safe, attribution: safety.attribution };
    });

    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0];

    // Warn if the best match has Content ID risk
    if (!winner.safe) {
        await logEvent("Agent 3",
            `Music warning: "${winner.track.title || "untitled"}" has unverified license — may trigger Content ID`,
            { jobId, level: "warn" }
        );
    }

    await logEvent(
        "Agent 3",
        `Music: "${winner.track.title || "untitled"}" (${energyLevel}${winner.safe ? ", Content-ID safe" : ""})`,
        { jobId }
    );

    // Attach attribution for auto-injection into the video description
    const result = { ...winner.track };
    if (winner.attribution) {
        result.attribution_text = winner.attribution;
    }
    return result;
}

/**
 * Pick a one-shot SFX from sfx_library by tag (e.g. "hook", "payoff", "pop").
 * Mirrors pickMusic's graceful degradation: an empty/unconfigured sfx_library
 * returns null and the render simply gets no SFX layer. Tries each tag in
 * order and returns the first match; tolerant of the exact URL column name.
 */
export async function pickSfx(tags = [], jobId = null) {
    for (const tag of tags) {
        try {
            const { data, error } = await supabase.from("sfx_library").select("*").contains("tags", [tag]).limit(10);
            if (error || !data?.length) continue;
            const row = data[Math.floor(Math.random() * data.length)];
            const url = row.track_url || row.url || row.sfx_url || row.audio_url || null;
            if (!url) continue;
            await logEvent("Agent 3", `SFX: "${row.title || row.name || tag}" (${tag})`, { jobId });
            return { ...row, url };
        } catch {
            continue;
        }
    }
    return null;
}
