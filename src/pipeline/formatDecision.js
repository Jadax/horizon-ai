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
 * judgment call can. Runs on Gemini flash-lite (a classification/judgment
 * task, not creative writing) to keep it cheap — see run.js for how its
 * output feeds into Agent 2/3/4's actual generation.
 */
import { logEvent } from "../supabase.js";
import { llmJson } from "../lib/llm.js";


const FORMAT_SYSTEM = `You direct the presentation format for a short-form
video pipeline. You receive a topic, the niche's allowed duration range,
and whether word-clip mode is stylistically available for this niche.
Decide, for THIS SPECIFIC TOPIC, not generically for the niche:

ALGORITHM DATA (YouTube Shorts 2026, verified benchmarks):
- Decision is TWO-STAGE: ~0.3s subconscious (visual frame only) then ~3s
  conscious commitment; 65% of viewers decide within 3s. The first frame must
  have motion or on-screen text at 0.4s — the render layer burns the script's
  opening (or LLM hook_text) as frame-1 headline text, so make those words land.
- Viral Shorts (5,000-video study) get first on-screen text at ~0.4s and first
  hard cut at ~0.9s; curiosity-gap closure lands by ~8s.
- 30-45 seconds is the 2026 sweet spot — sub-15s no longer clears the watch-time
  bar. Loops count toward >100% retention.
- Swipe-away is a gate: under 40% in the first 2s expands distribution.
- 50-60% of viewers who drop off do so in the first 3 seconds.
- The 0.2-second rule: no audio gap >0.2s in the first 3s, >0.4s after —
  density is a retention lever (audio is silenced/tightened downstream)
- Loop endings (connecting last sentence to first) unlock 100%+ retention
- Target: 70-85%+ average percentage viewed; shares >1% are top-positive.

DURATION RULES:
- DEFAULT to 30-45 seconds (the 2026 viral sweet spot; sub-15s underperforms)
- Use 35-45 seconds for explainer content with explicit payoff
- NEVER exceed 50 seconds — retention drops off dramatically
- A one-fact hook should target 18-25 seconds (lean, punchy)
- A story with twist should target 22-30 seconds (enough room to breathe)

SPOKEN DENSITY:
- Shorts run 160-180 wpm: dense, every syllable earns the next.
- A 15s topic ≈ 45-55 words; 30s ≈ 75-90 words; 45s ≈ 110-130 words.
- Dead air and throat-clearing are swipe triggers — pick short durations
  for thin topics instead of padding them out to hit the range max.

NICHE-SPECIFIC VISUAL TACTICS (MKBHD/Fireship/Two Minute Papers level):

TECH / EXPLAINED:
- Dark mode aesthetic: dark backgrounds with vibrant neon accents
- Code snippet overlays (terminal-style text boxes)
- Split-screen comparisons (before/after, old vs new)
- Progress bars, loading animations as visual metaphors
- Electric blue (#00D4FF) + neon green (#00FF88) accent colors
- Puck voice for energetic delivery
- Music: bass-heavy electronic, 110-128 BPM

TRAVEL:
- Cinematic color grading: teal shadows + warm golden highlights
- Split-screen before/after destinations
- Speed ramping (slow-mo → fast → slow for dramatic reveals)
- Semi-transparent dark text boxes for readability
- Destination name cards with flag emojis
- Warm gold (#FFD700) + deep teal (#008080) palette
- Music: upbeat acoustic + ambient, 100-120 BPM

ENTERTAINMENT / VIRAL:
- MrBeast-style pacing: 12-20 cuts per minute
- Kinetic typography (words fly in, scale, bounce)
- Bold impact colors: red (#FF0000) + yellow (#FFE600)
- Face zoom-in on reactions (stock or generated)
- Countdown overlays for urgency
- Sound effects: whoosh transitions, bass drops, dings
- Music: bass-heavy electronic, 120-130 BPM

GAMING / LORE:
- Dark moody backgrounds with dramatic lighting
- Game UI mockups (health bars, inventories, skill trees)
- Character silhouettes and concept art style
- Purple (#9B59B6) + crimson (#E74C3C) accent colors
- Fenrir voice for authoritative tone
- Music: orchestral + electronic hybrid, 90-110 BPM

PET:
- Bright, saturated colors (high contrast)
- Cozy warm lighting (golden hour aesthetic)
- Emoji pop-ins and SFX text overlays
- Before/after transformations
- Emerald (#2ECC71) + coral (#FF6B6B) palette
- Kore voice for friendly delivery
- Music: playful acoustic + upbeat, 100-120 BPM

1. word_clip_mode: true if the topic is a single sharp moment/stat/quote
   that lands harder as giant on-screen words than as flowing narration.
   false if it's a story, explanation, or anything needing cause-and-effect
   sentences to make sense (lore, a recipe, a multi-step explanation).
2. target_duration_seconds: a specific number within [MIN,MAX], but ALWAYS
   prefer the LOWER end of the range. The data is clear: shorter = higher
   retention = more algorithmic boost. Only go above 30s if the topic
   genuinely demands it for comprehension.
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
6. color_preset: pick one of "neon_tech", "teal_gold", "red_yellow", "purple_crimson", "coral_emerald", "warm_gold", "bright_clean", "moody_cinematic", or "classic_white" to set the visual identity. Match the niche's registered look (see the per-niche tactics below) unless the topic's emotional register genuinely demands another: pets/cozy → warm_gold, tech → neon_tech, travel → teal_gold, entertainment/viral → red_yellow, gaming → purple_crimson, food → bright_clean, motivation/reflective → moody_cinematic.
7. reasoning: one sentence explaining all of the above together.

Respond ONLY with JSON:
{"word_clip_mode": true/false, "target_duration_seconds": number,
 "footage_mood": ["keyword1","keyword2",...],
  "music_energy": "High"|"Suspense"|"Chill"|"Wonder",
  "music_brief":{"moods":["tense"],"genres":["ambient"],"bpm":[75,95]},
  "color_preset": "neon_tech",
  "reasoning": "..."}`;

export async function decideFormat(niche, topic, jobId) {
  const minSeconds = niche.target_duration_min_seconds || 25;
  const maxSeconds = niche.target_duration_max_seconds || 45;
  const wordClipAvailable = niche.editing_style_preset?.wordClipMode !== false; // most niches CAN do either

  await logEvent("Format Engine", `Deciding presentation for "${topic.title.slice(0, 60)}"…`, { jobId });

  try {
    const res = await llmJson({
      tier: "fast",
      temperature: 0.3,
      label: "formatDecision",
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

    const decision = JSON.parse(res.content);
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
    // Apply niche-specific color preset (neon_tech, teal_gold, red_yellow, etc.)
    const validPresets = ["neon_tech", "teal_gold", "red_yellow", "purple_crimson", "coral_emerald", "warm_gold", "bright_clean", "moody_cinematic", "classic_white"];
    if (!validPresets.includes(decision.color_preset)) {
      decision.color_preset = "classic_white";
    }
    decision._usage = { tokens: res.tokens || 0 };

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
      color_preset: "classic_white",
      reasoning: "Fallback to niche defaults (format decision call failed)",
      _usage: { tokens: 0 },
    };
  }
}
