import { config } from "../config.js";
import { supabase, logEvent } from "../supabase.js";
import { synthesizeSpeech } from "../lib/freeTTS.js";

export async function synthesizeVoiceover(script, voiceId, jobId, expectedMaxSeconds = 58) {
    await logEvent("Agent 3", `Synthesizing voiceover using free TTS (${config.ttsEngine || 'chatterbox'})...`, { jobId });

    try {
        const audioBuffer = await synthesizeSpeech(script, voiceId, {
            speed: 1.0,
            lang: 'en',
        });

        const duration = estimateDuration(audioBuffer);

        const path = `voiceovers/${jobId}.mp3`;
        const { error } = await supabase.storage
            .from("renders")
            .upload(path, audioBuffer, { contentType: "audio/mpeg", upsert: true });
        if (error) throw new Error(`Voiceover upload failed: ${error.message}`);

        const { data } = supabase.storage.from("renders").getPublicUrl(path);
        const words = generateWordTimestamps(script, duration);

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
        return { voiceoverUrl: data.publicUrl, words, duration };
    } catch (error) {
        await logEvent("Agent 3", `TTS failed: ${error.message}`, { jobId, level: "error" });
        throw error;
    }
}

function estimateDuration(audioBuffer) {
    const sizeMB = audioBuffer.length / (1024 * 1024);
    return Math.max(10, sizeMB * 60);
}

function generateWordTimestamps(script, duration) {
    const words = script.split(/\s+/);
    const wordsPerSecond = words.length / duration;
    const timestamps = [];
    let currentTime = 0;
    for (const word of words) {
        const wordDuration = 1 / wordsPerSecond;
        timestamps.push({
            word: word,
            start: currentTime,
            end: currentTime + wordDuration,
        });
        currentTime += wordDuration;
    }
    return timestamps;
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