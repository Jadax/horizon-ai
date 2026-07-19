import { config } from "../config.js";
import { supabase, logEvent } from "../supabase.js";
import { synthesizeSpeech } from "../lib/freeTTS.js";
import OpenAI, { toFile } from "openai";

const openai = new OpenAI({ apiKey: config.openaiKey });

export async function synthesizeVoiceover(script, voiceId, jobId, expectedMaxSeconds = 58) {
    await logEvent("Agent 3", `Synthesizing voiceover using free TTS (${config.ttsEngine || 'chatterbox'})...`, { jobId });

    try {
        const audioBuffer = await synthesizeSpeech(script, voiceId, {
            speed: 1.0,
            lang: 'en',
        });

        const words = await alignGeneratedSpeech(audioBuffer, script);
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

async function alignGeneratedSpeech(audioBuffer, script) {
    const file = await toFile(audioBuffer, "voiceover.mp3");
    const transcription = await openai.audio.transcriptions.create({
        file,
        model: "whisper-1",
        response_format: "verbose_json",
        timestamp_granularities: ["word"],
        prompt: script.slice(0, 220),
    });
    const words = (transcription.words || []).map((word) => ({
        word: String(word.word || "").trim(),
        start: Number(Number(word.start).toFixed(3)),
        end: Number(Number(word.end).toFixed(3)),
    })).filter((word) => word.word && word.end > word.start);
    const expected = script.split(/\s+/).filter(Boolean).length;
    if (words.length / expected < 0.9) throw new Error(`TTS alignment coverage too low (${words.length}/${expected} words)`);
    return words;
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
