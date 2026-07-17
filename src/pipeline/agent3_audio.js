/**
 * AGENT 3 — THE STYLE & AUDIO SYNTHESIZER
 *
 * - Sends the script to ElevenLabs /v1/text-to-speech/{voice}/with-timestamps
 *   so we get character-level timing → converted to word timestamps that
 *   drive the active-caption layer in Agent 4.
 * - Uploads the resulting MP3 to Supabase Storage (Shotstack needs a URL).
 * - Picks a background track from music_library matching the niche's
 *   configured energy level.
 * - Language: the "eleven_multilingual_v2" model auto-detects language from
 *   the script text itself — no per-language voice ID needed. If a niche's
 *   `language` is "hi", Agent 2 writes the script in Hindi and this same
 *   voice profile will speak it correctly.
 */
import { config } from "../config.js";
import { supabase, logEvent } from "../supabase.js";

export async function synthesizeVoiceover(script, voiceId, jobId, expectedMaxSeconds = 58) {
  await logEvent("Agent 3", `Synthesizing voiceover (voice ${voiceId})…`, { jobId });

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "xi-api-key": config.elevenLabsKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: script,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.35 },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`ElevenLabs → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();

  // Convert char-level alignment → word timestamps
  const words = [];
  const chars = json.alignment?.characters || [];
  const starts = json.alignment?.character_start_times_seconds || [];
  const ends = json.alignment?.character_end_times_seconds || [];
  let current = null;
  chars.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (current) words.push(current);
      current = null;
    } else {
      if (!current) current = { word: "", start: starts[i], end: ends[i] };
      current.word += ch;
      current.end = ends[i];
    }
  });
  if (current) words.push(current);

  const audioBuffer = Buffer.from(json.audio_base64, "base64");
  const duration = words.length ? words[words.length - 1].end : 45;

  // SHORTS/TIKTOK LENGTH DISCIPLINE: YouTube technically allows Shorts up
  // to 3 minutes and TikTok up to 10 minutes, but the loop mechanic this
  // product is built around — and virality/retention generally — both
  // favor staying well under 60s. Script length is already constrained
  // upstream (Agent 2: ~45s normal, ~25-35s word-clip mode), so this is a
  // safety net that surfaces the problem rather than silently shipping an
  // overlong render if a script ever comes back longer than intended.
  if (duration > expectedMaxSeconds) {
    await logEvent(
      "Agent 3",
      `⚠ Voiceover is ${Math.round(duration)}s — longer than this niche's ${expectedMaxSeconds}s target. Consider tightening Agent 2's word count, or this may be intentional for a longer-form niche.`,
      { jobId, level: "warn" }
    );
  }


  // Upload to Supabase Storage so Shotstack can fetch it
  const path = `voiceovers/${jobId}.mp3`;
  const { error } = await supabase.storage
    .from("renders")
    .upload(path, audioBuffer, { contentType: "audio/mpeg", upsert: true });
  if (error) throw new Error(`Voiceover upload failed: ${error.message}`);

  const { data } = supabase.storage.from("renders").getPublicUrl(path);
  await logEvent(
    "Agent 3",
    `Voiceover ready: ${Math.round(duration)}s, ${words.length} word timestamps`,
    { jobId }
  );
  return { voiceoverUrl: data.publicUrl, words, duration };
}

export async function pickMusic(energyLevel, jobId) {
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
  const track = data[Math.floor(Math.random() * data.length)];
  await logEvent("Agent 3", `Music: "${track.title || "untitled"}" (${energyLevel})`, { jobId });
  return track;
}
