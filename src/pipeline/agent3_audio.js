import { config } from "../config.js";
import { supabase, logEvent } from "../supabase.js";
import { synthesizeSpeech } from "../lib/freeTTS.js";
import { verifyContentIdSafety } from "../lib/musicBrain.js";
import OpenAI, { toFile } from "openai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpeg from "ffmpeg-static";

const execFileAsync = promisify(execFile);
const openai = new OpenAI({ apiKey: config.openaiKey });

// gpt-4o-mini-tts stops generating early on longer inputs often enough that
// a production run burned all 3 whole-script retries in a row (106-word
// script, ~44 words of audio each time). Short inputs don't exhibit it, so
// scripts are synthesized as sentence-grouped chunks and concatenated —
// each chunk is comfortably inside the reliable range.
const TTS_CHUNK_MAX_CHARS = 280;

function splitScriptForTTS(script) {
    const sentences = String(script).match(/[^.!?]+[.!?]*\s*/g) || [String(script)];
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
    await logEvent("Agent 3", `Synthesizing voiceover using free TTS (${config.ttsEngine || 'chatterbox'})...`, { jobId });

    try {
        // Escalation ladder: chunked synthesis twice (chunking alone removes
        // the early-stop failure mode on long inputs), then gTTS for the
        // whole script as the engine of last resort — robotic beats a dead
        // run, and the alignment gate still verifies whatever comes out.
        const chunks = splitScriptForTTS(script);
        let audioBuffer, words;
        for (let attempt = 1; ; attempt++) {
            if (attempt >= 3) {
                await logEvent("Agent 3", `Falling back to gtts for this run (primary engine kept returning incomplete audio)`, { jobId, level: "warn" });
                audioBuffer = await synthesizeSpeech(script, voiceId, { speed: 1.0, lang: 'en', engine: 'gtts' });
            } else {
                const parts = [];
                for (const chunk of chunks) {
                    // options.engine lets a caller pin a specific engine (e.g.
                    // Leo pinning the cloned ElevenLabs voice) without
                    // changing the global TTS_ENGINE default.
                    parts.push(await synthesizeSpeech(chunk, voiceId, { speed: 1.0, lang: 'en', engine: options.engine }));
                }
                audioBuffer = await concatAudioBuffers(parts);
                audioBuffer = await removeSilence(audioBuffer);
            }
            try {
                words = await alignGeneratedSpeech(audioBuffer, script, jobId);
                break;
            } catch (err) {
                if (!/audio incomplete/i.test(err.message) || attempt >= 3) throw err;
                await logEvent("Agent 3", `TTS returned incomplete audio (attempt ${attempt}/3, ${chunks.length} chunk(s)) — retrying`, { jobId, level: "warn" });
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
            `Voiceover ready: ${Math.round(duration)}s, ${words.length} word timestamps (FREE: ${config.ttsEngine || 'chatterbox'})`,
            { jobId }
        );
        return { voiceoverUrl: data.publicUrl, words, duration, syncPrecisionMs: config.subtitleSyncPrecisionMs };
    } catch (error) {
        await logEvent("Agent 3", `TTS failed: ${error.message}`, { jobId, level: "error" });
        throw error;
    }
}

/**
 * Free alignment path: Gemini's audio understanding produces per-word
 * timestamps (verified live: 17/17 words with correct text and monotonic
 * times on a known clip). Used first when a Gemini key exists; OpenAI
 * whisper-1 remains the fallback so alignment survives a Gemini outage.
 */
async function alignWithGemini(audioBuffer, script) {
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${config.geminiKey}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [
                    { text: `Transcribe this audio with per-word timestamps. Return JSON only: {"words":[{"word":"...","start":0.0,"end":0.4},...]} with start/end in seconds, covering every spoken word in order. For reference, the intended script was: ${script.slice(0, 500)}` },
                    { inlineData: { mimeType: "audio/mp3", data: audioBuffer.toString("base64") } },
                ] }],
                generationConfig: { responseMimeType: "application/json", temperature: 0 },
            }),
            signal: AbortSignal.timeout(120000),
        }
    );
    const json = await res.json();
    if (json.error) throw new Error(`Gemini align: ${json.error.message?.slice(0, 120)}`);
    const parsed = JSON.parse(json.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
    const words = (parsed.words || [])
        .map((w) => ({ word: String(w.word || "").trim(), start: Number(w.start), end: Number(w.end) }))
        .filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
    // Monotonicity + coverage sanity — a hallucinated timeline fails here
    // and falls through to whisper.
    for (let i = 1; i < words.length; i++) {
        if (words[i].start < words[i - 1].start - 0.05) throw new Error("Gemini align: non-monotonic timestamps");
    }
    const expected = script.split(/\s+/).filter(Boolean).length;
    if (!words.length || words.length / expected < 0.8) {
        throw new Error(`Gemini align: coverage too low (${words.length}/${expected})`);
    }
    return words;
}

export async function alignGeneratedSpeech(audioBuffer, script, jobId) {
    if (config.geminiKey) {
        try {
            return await alignWithGemini(audioBuffer, script);
        } catch (err) {
            await logEvent("Agent 3", `Gemini alignment failed (${err.message}) — falling back to whisper`, { jobId, level: "warn" });
        }
    }
    const file = await toFile(audioBuffer, "voiceover.mp3");
    const transcription = await openai.audio.transcriptions.create({
        file,
        model: "whisper-1",
        response_format: "verbose_json",
        timestamp_granularities: ["word", "segment"],
        prompt: script.slice(0, 220),
    });
    const words = (transcription.words || []).map((word) => ({
        word: String(word.word || "").trim(),
        start: Number(Number(word.start).toFixed(3)),
        end: Number(Number(word.end).toFixed(3)),
    })).filter((word) => word.word && word.end > word.start);
    const expected = script.split(/\s+/).filter(Boolean).length;
    if (words.length / expected >= 0.9) return words;

    // Whisper's word-level timestamps silently omit words even when the
    // transcript text is complete (reproduced locally: the word "Real" was in
    // transcript.text but absent from transcription.words) — and word-clip
    // scripts made of dozens of staccato 2-4 word sentences make the word
    // list especially sparse, which used to fail an entire production run at
    // 34/67 here. The transcript TEXT is the honest signal of what was
    // actually spoken; when it confirms the audio is complete, rebuild the
    // missing timings from the segment-level timestamps (which are reliable)
    // by spacing each segment's words across its span, weighted by length.
    const transcriptWords = String(transcription.text || "").split(/\s+/).filter(Boolean);
    if (transcriptWords.length / expected < 0.7) {
        throw new Error(`TTS audio incomplete: transcript heard only ${transcriptWords.length}/${expected} script words`);
    }
    const segments = (transcription.segments || []).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
    if (!segments.length) {
        throw new Error(`TTS alignment coverage too low (${words.length}/${expected} word timestamps, no segments to rebuild from)`);
    }
    const rebuilt = [];
    for (const segment of segments) {
        const segWords = String(segment.text || "").split(/\s+/).filter(Boolean);
        if (!segWords.length) continue;
        const totalChars = segWords.reduce((sum, w) => sum + w.length, 0) || 1;
        let cursor = segment.start;
        const span = segment.end - segment.start;
        for (const w of segWords) {
            const dur = span * (w.length / totalChars);
            rebuilt.push({
                word: w,
                start: Number(cursor.toFixed(3)),
                end: Number((cursor + dur).toFixed(3)),
            });
            cursor += dur;
        }
    }
    if (rebuilt.length / expected < 0.7) {
        throw new Error(`TTS alignment coverage too low even after segment rebuild (${rebuilt.length}/${expected} words)`);
    }
    await logEvent(
        "Agent 3",
        `Whisper word timestamps were sparse (${words.length}/${expected}) — rebuilt ${rebuilt.length} timings from segment boundaries`,
        { jobId, level: "warn" }
    );
    return rebuilt;
}

export async function pickMusic(energyLevel, jobId, brief = {}) {
    const { data, error } = await supabase
        .from("music_library")
        .select("*")
        .eq("energy_level", energyLevel);
    if (error || !data?.length) {
        await logEvent("Agent 3", `No ${energyLevel} track in music_library — rendering without music`, {
            jobId,
            level: "warn",
        });
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
