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
        // Tuned for natural human warmth rather than a flat, obviously-
        // synthetic read: stability in the 60-67% band avoids both cold
        // monotony (too high) and unstable warble (too low); clarity
        // locked 80-85% keeps articulation crisp without sounding
        // over-processed; a mild style exaggeration (15-25%) lets the
        // narrator naturally stress dramatic syllables instead of reading
        // every word at the same weight.
        voice_settings: { stability: 0.63, similarity_boost: 0.82, style: 0.2 },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`ElevenLabs → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();

  // Convert char-level alignment → word timestamps.
  // BUGFIX: previously only whitespace counted as a word boundary, so an
  // em-dash or similar punctuation GPT sometimes writes without a
  // surrounding space (e.g. "growth—no matter") merged into one caption
  // token with no space between the words. Em/en-dashes now also count as
  // boundaries, same as whitespace.
  const words = [];
  const chars = json.alignment?.characters || [];
  const starts = json.alignment?.character_start_times_seconds || [];
  const ends = json.alignment?.character_end_times_seconds || [];
  const isBoundary = (ch) => /\s/.test(ch) || ch === "—" || ch === "–";
  let current = null;
  chars.forEach((ch, i) => {
    if (isBoundary(ch)) {
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
  // Score once per candidate. Calling Math.random inside the sort comparator
  // makes comparisons non-transitive and can accidentally bury the best fit.
  const track = data
    .map((candidate) => ({ candidate, score: scoreTrack(candidate) }))
    .sort((a, b) => b.score - a.score)[0].candidate;
  await logEvent(
    "Agent 3",
    `Music: "${track.title || "untitled"}" (${energyLevel}; moods: ${(brief.moods || []).join(", ") || "any"})`,
    { jobId }
  );
  return track;
}
