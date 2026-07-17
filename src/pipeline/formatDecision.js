/**
 * FORMAT DECISION ENGINE — sits between Agent 1 (harvest) and Agent 2
 * (scriptwriting). This is the piece that answers "how should THIS
 * specific topic be presented" rather than using one fixed setting for an
 * entire niche.
 *
 * WHAT IT DECIDES, PER TOPIC:
 *   - word_clip_mode: is this topic punchier as giant single-word cards
 *     (a sharp meme moment, a shocking single stat) or does it need
 *     flowing narration (a story with cause-and-effect, lore, a recipe)?
 *   - target_duration_seconds: where within the niche's allowed range does
 *     THIS topic actually need to sit? A one-line shocking fact doesn't
 *     need 90 seconds just because Gaming/Lore allows it; a genuinely
 *     layered lore story might want the full range even in a niche whose
 *     default is short.
 *   - footage_mood: which subset of the niche's footage keywords actually
 *     fits this topic's emotional register (tense vs. wonder vs. cozy),
 *     re-prioritized for Agent 1's footage search rather than picked
 *     uniformly at random.
 *
 * WHY THIS EXISTS: the ask behind it was "no human input needed, but make
 * every decision serve the product goal of premier-quality, viral-shaped
 * output" — a single static preset per niche can't do that; a per-topic
 * judgment call can. Runs on gpt-4o-mini (a classification/judgment task,
 * not creative writing) to keep this cheap — see run.js for how its output
 * feeds into Agent 2/3/4's actual generation.
 */
import OpenAI from "openai";
import { config } from "../config.js";
import { logEvent } from "../supabase.js";

const openai = new OpenAI({ apiKey: config.openaiKey });

const FORMAT_SYSTEM = `You direct the presentation format for a short-form
video pipeline. You receive a topic, the niche's allowed duration range,
and whether word-clip mode is stylistically available for this niche.
Decide, for THIS SPECIFIC TOPIC, not generically for the niche:

1. word_clip_mode: true if the topic is a single sharp moment/stat/quote
   that lands harder as giant on-screen words than as flowing narration.
   false if it's a story, explanation, or anything needing cause-and-effect
   sentences to make sense (lore, a recipe, a multi-step explanation).
2. target_duration_seconds: a specific number within [MIN,MAX]. Don't
   default to the max just because it's allowed — pick what the topic
   actually needs to land well. A one-fact hook might want MIN; a layered
   story might want MAX.
3. footage_mood: pick 4-6 keywords from the AVAILABLE_KEYWORDS list that
   best match this specific topic's emotional register (e.g. a tense
   gaming-drama topic wants darker/moodier keywords than a wholesome one).
4. music_energy: pick exactly one of "High","Suspense","Chill","Wonder" —
   whichever actually fits THIS topic's emotional register, not just the
   niche's usual default. A somber or reflective story in an otherwise
   high-energy niche should still get "Chill" or "Suspense" if that's what
   actually fits; a triumphant or exciting story in a normally calm niche
   can get "High" or "Wonder". Mismatched music undercuts otherwise good
   narration, so take this as seriously as the other choices.
5. music_brief: 2-4 mood tags, 1-3 instrumental genres, and a BPM range that
   match the emotional arc. Prefer instrumental music beneath narration.
6. reasoning: one sentence explaining all of the above together.

Respond ONLY with JSON:
{"word_clip_mode": true/false, "target_duration_seconds": number,
 "footage_mood": ["keyword1","keyword2",...],
  "music_energy": "High"|"Suspense"|"Chill"|"Wonder",
  "music_brief":{"moods":["tense"],"genres":["ambient"],"bpm":[75,95]},
  "reasoning": "..."}`;

export async function decideFormat(niche, topic, jobId) {
  const minSeconds = niche.target_duration_min_seconds || 25;
  const maxSeconds = niche.target_duration_max_seconds || 45;
  const wordClipAvailable = niche.editing_style_preset?.wordClipMode !== false; // most niches CAN do either

  await logEvent("Format Engine", `Deciding presentation for "${topic.title.slice(0, 60)}"…`, { jobId });

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: FORMAT_SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            niche: niche.niche_name,
            topic: topic.title,
            context: (topic.selftext || "").slice(0, 400),
            MIN: minSeconds,
            MAX: maxSeconds,
            word_clip_available: wordClipAvailable,
            AVAILABLE_KEYWORDS: niche.footage_keywords,
          }),
        },
      ],
    });

    const decision = JSON.parse(res.choices[0].message.content);
    decision.target_duration_seconds = Math.max(
      minSeconds,
      Math.min(maxSeconds, Math.round(decision.target_duration_seconds || minSeconds))
    );
    if (!wordClipAvailable) decision.word_clip_mode = false;
    if (!Array.isArray(decision.footage_mood) || !decision.footage_mood.length) {
      decision.footage_mood = niche.footage_keywords.slice(0, 5);
    }
    const validEnergies = ["High", "Suspense", "Chill", "Wonder"];
    if (!validEnergies.includes(decision.music_energy)) {
      decision.music_energy = niche.editing_style_preset?.music_energy || "Chill";
    }
    const musicBrief = decision.music_brief || {};
    decision.music_brief = {
      moods: Array.isArray(musicBrief.moods) ? musicBrief.moods.slice(0, 4) : [decision.music_energy.toLowerCase()],
      genres: Array.isArray(musicBrief.genres) ? musicBrief.genres.slice(0, 3) : [],
      bpm: Array.isArray(musicBrief.bpm) && musicBrief.bpm.length === 2 ? musicBrief.bpm.map(Number) : [70, 120],
    };
    decision._usage = { tokens: res.usage?.total_tokens || 0 };

    await logEvent(
      "Format Engine",
      `Decision: ${decision.word_clip_mode ? "word-clip" : "narrated"}, ${decision.target_duration_seconds}s — ${decision.reasoning}`,
      { jobId }
    );
    return decision;
  } catch (err) {
    // Fail safe to the niche's static defaults rather than blocking the run
    await logEvent("Format Engine", `Decision failed, using niche defaults: ${err.message}`, { jobId, level: "warn" });
    return {
      word_clip_mode: Boolean(niche.editing_style_preset?.wordClipMode),
      target_duration_seconds: Math.round((minSeconds + maxSeconds) / 2),
      footage_mood: niche.footage_keywords.slice(0, 5),
      music_energy: niche.editing_style_preset?.music_energy || "Chill",
      music_brief: { moods: [niche.editing_style_preset?.music_energy?.toLowerCase() || "chill"], genres: [], bpm: [70, 120] },
      reasoning: "Fallback to niche defaults (format decision call failed)",
      _usage: { tokens: 0 },
    };
  }
}
