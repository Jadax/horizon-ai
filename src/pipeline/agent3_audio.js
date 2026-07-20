import { config } from "../config.js";
import { supabase, logEvent } from "../supabase.js";
import { synthesizeSpeech } from "../lib/freeTTS.js";
import OpenAI, { toFile } from "openai";

const openai = new OpenAI({ apiKey: config.openaiKey });

export async function synthesizeVoiceover(script, voiceId, jobId, expectedMaxSeconds = 58) {
    await logEvent("Agent 3", `Synthesizing voiceover using free TTS (${config.ttsEngine || 'chatterbox'})...`, { jobId });

    try {
        // gpt-4o-mini-tts is a generative audio model and occasionally stops
        // early on longer inputs, producing audio missing a chunk of the
        // script (observed in production: 39/78 words heard, while the same
        // script synthesized fine on the next call). The alignment step's
        // transcript check detects exactly this, so treat "audio incomplete"
        // as a re-synthesis trigger rather than a run-killing failure.
        let audioBuffer, words;
        for (let attempt = 1; ; attempt++) {
            audioBuffer = await synthesizeSpeech(script, voiceId, {
                speed: 1.0,
                lang: 'en',
            });
            try {
                words = await alignGeneratedSpeech(audioBuffer, script, jobId);
                break;
            } catch (err) {
                if (!/audio incomplete/i.test(err.message) || attempt >= 3) throw err;
                await logEvent("Agent 3", `TTS returned incomplete audio (attempt ${attempt}/3) — re-synthesizing`, { jobId, level: "warn" });
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

export async function alignGeneratedSpeech(audioBuffer, script, jobId) {
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
    const wantedMoods = (brief.moods || []).map((v) => String(v).toLowerCase());
    const wantedGenres = (brief.genres || []).map((v) => String(v).toLowerCase());
    const [bpmLow, bpmHigh] = Array.isArray(brief.bpm) ? brief.bpm.map(Number) : [0, Infinity];
    const scoreTrack = (track) => {
        const moods = Array.isArray(track.mood_tags) ? track.mood_tags.map((v) => String(v).toLowerCase()) : [];
        const genre = String(track.genre || "").toLowerCase();
        let score = 0;
        score += wantedMoods.filter((mood) => moods.includes(mood)).length * 4;
        score += wantedGenres.some((wanted) => genre.includes(wanted)) ? 3 : 0;
        score += Number.isFinite(Number(track.bpm)) && Number(track.bpm) >= bpmLow && Number(track.bpm) <= bpmHigh ? 2 : 0;
        score += track.instrumental === true ? 1 : 0;
        return score + Math.random() * 0.25;
    };
    const track = data
        .map((candidate) => ({ candidate, score: scoreTrack(candidate) }))
        .sort((a, b) => b.score - a.score)[0].candidate;
    await logEvent(
        "Agent 3",
        `Music: "${track.title || "untitled"}" (${energyLevel})`,
        { jobId }
    );
    return track;
}
