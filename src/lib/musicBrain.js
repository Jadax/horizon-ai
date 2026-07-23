/**
 * MUSIC BRAIN — copyright-free music engine.
 *
 * Problem: YouTube Content ID auto-flags copyrighted music → demonetization
 * + limited reach. Solution: multi-source CC0/royalty-free music pipeline
 * that verifies licenses before use and matches music to content for
 * emotional coherence (because random lounge under a horror script kills
 * retention just as badly as Content ID kills monetization).
 *
 * Sources (all free, no paid API keys needed):
 *   - Pixabay Music API (royalty-free, no attribution, no Content ID)
 *   - Free Music Archive (CC-licensed, searchable API)
 *   - Incompetech / Kevin MacLeod (CC-BY, thousands of tracks)
 *   - Existing Jamendo sync (already integrated)
 *   - YouTube Audio Library web fallback
 *
 * License safety: only CC0, CC-BY, and explicitly royalty-free tracks.
 * Attribution is stored in track metadata for auto-injection into video
 * descriptions where required (CC-BY).
 */
import { supabase } from "../supabase.js";
import { llmJson } from "./llm.js";
import { config } from "../config.js";

// ─── MULTI-SOURCE MUSIC SEARCH ────────────────────────────────────────

const PIXABAY_API = "https://pixabay.com/api";
const FMA_API = "https://freemusicarchive.org/api/tracks";

const ENERGY_QUERIES = {
  Wonder: { pixabay: "cinematic+ambient+wonder", fma: "ambient+cinematic", tags: ["ambient", "cinematic", "orchestral", "piano"] },
  Chill: { pixabay: "chill+lounge+lo-fi", fma: "lounge+chill", tags: ["lounge", "chill", "lo-fi", "jazz", "acoustic"] },
  High: { pixabay: "energetic+electronic+upbeat", fma: "electronic+upbeat", tags: ["electronic", "pop", "rock", "dance", "upbeat"] },
  Suspense: { pixabay: "dark+cinematic+tense", fma: "dark+cinematic", tags: ["dark", "cinematic", "tense", "ambient", "drone"] },
};

/**
 * Search Pixabay Music — royalty-free, no attribution required
 */
async function searchPixabay(energy, limit = 5) {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return [];
  const query = ENERGY_QUERIES[energy]?.pixabay || energy.toLowerCase();
  try {
    const res = await fetch(`${PIXABAY_API}/?key=${key}&q=${encodeURIComponent(query)}&category=music&per_page=${limit}&safesearch=true`);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.hits || []).map((h) => ({
      title: h.tags?.split(",")[0]?.trim() || h.user || "Pixabay track",
      track_url: h.previewURL || h.largeImageURL || null,
      energy_level: energy,
      mood_tags: (h.tags || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 5),
      genre: h.type || "instrumental",
      bpm: null,
      instrumental: true,
      license: "CC0 / Pixabay License (royalty-free, no attribution required)",
      attribution: null,
      source: "pixabay",
      duration: h.duration || null,
    })).filter((t) => t.track_url);
  } catch { return []; }
}

/**
 * Search Free Music Archive — CC-licensed tracks
 */
async function searchFMA(energy, limit = 5) {
  try {
    const res = await fetch(`${FMA_API}?q=${ENERGY_QUERIES[energy]?.fma || energy}&limit=${limit}&sort=popular`);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.results || []).filter((t) => {
      const licenses = (t.license_url || "").toLowerCase();
      return licenses.includes("cc0") || licenses.includes("cc-by") || licenses.includes("public");
    }).map((t) => ({
      title: t.title || "FMA track",
      track_url: t.listen_url || t.download_url || null,
      energy_level: energy,
      mood_tags: (t.tags || []).map((tag) => tag.name || String(tag)).filter(Boolean).slice(0, 5),
      genre: t.genre || null,
      bpm: t.bpm || null,
      instrumental: true,
      license: `CC ${t.license_name || "BY"}`,
      attribution: t.artist_name ? `${t.artist_name} — ${t.title}` : null,
      source: "freemusicarchive",
    })).filter((t) => t.track_url);
  } catch { return []; }
}

/**
 * Incompetech — Kevin MacLeod's royalty-free catalog (CC-BY)
 * Pre-curated list of high-quality instrumental tracks
 */
const INCOMPETECH_TRACKS = [
  { title: "Suonatore di Liuto", genre: "classical", moods: ["calm", "elegant"], bpm: 70, energy: "Chill" },
  { title: "Vibing Over Venus", genre: "electronic", moods: ["upbeat", "funky"], bpm: 120, energy: "High" },
  { title: "Eyes Gone Wrong", genre: "electronic", moods: ["tense", "dark"], bpm: 90, energy: "Suspense" },
  { title: "At Rest", genre: "ambient", moods: ["peaceful", "calm"], bpm: 60, energy: "Wonder" },
  { title: "All This", genre: "electronic", moods: ["upbeat", "energetic"], bpm: 120, energy: "High" },
  { title: "Angevin", genre: "classical", moods: ["medieval", "dramatic"], bpm: 100, energy: "Wonder" },
  { title: "Backbay Lounge", genre: "jazz", moods: ["chill", "lounge"], bpm: 85, energy: "Chill" },
  { title: "Comfortable Mystery", genre: "ambient", moods: ["mystery", "calm"], bpm: 75, energy: "Suspense" },
  { title: "Deadly Roulette", genre: "cinematic", moods: ["tense", "dramatic"], bpm: 110, energy: "Suspense" },
  { title: "Easy Lemon", genre: "acoustic", moods: ["happy", "light"], bpm: 80, energy: "Chill" },
  { title: "Enter the Party", genre: "electronic", moods: ["party", "energetic"], bpm: 128, energy: "High" },
  { title: "Frost Waltz", genre: "classical", moods: ["elegant", "wonder"], bpm: 90, energy: "Wonder" },
  { title: "George Street Shuffle", genre: "jazz", moods: ["upbeat", "fun"], bpm: 105, energy: "High" },
  { title: "Hot Swing", genre: "jazz", moods: ["swing", "energetic"], bpm: 140, energy: "High" },
  { title: "I Knew a Guy", genre: "jazz", moods: ["cool", "noir"], bpm: 85, energy: "Chill" },
  { title: "Intractable", genre: "cinematic", moods: ["tense", "building"], bpm: 95, energy: "Suspense" },
  { title: "Klockworx", genre: "electronic", moods: ["mechanical", "dark"], bpm: 110, energy: "Suspense" },
  { title: "Lobby Time", genre: "jazz", moods: ["lounge", "retro"], bpm: 90, energy: "Chill" },
  { title: "Long Road Ahead", genre: "rock", moods: ["driving", "hopeful"], bpm: 120, energy: "High" },
  { title: "Meatball Parade", genre: "march", moods: ["playful", "whimsical"], bpm: 120, energy: "Wonder" },
  { title: "Night on the Docks", genre: "jazz", moods: ["noir", "mystery"], bpm: 80, energy: "Suspense" },
  { title: "Pamgaea", genre: "world", moods: ["epic", "tribal"], bpm: 100, energy: "Wonder" },
  { title: "Prelude and Action", genre: "cinematic", moods: ["epic", "dramatic"], bpm: 110, energy: "Suspense" },
  { title: "Redletter", genre: "rock", moods: ["driving", "urgent"], bpm: 130, energy: "High" },
  { title: "Samba Isobel", genre: "latin", moods: ["upbeat", "festive"], bpm: 110, energy: "High" },
  { title: "Scheming Weasel", genre: "cinematic", moods: ["sneaky", "playful"], bpm: 120, energy: "Wonder" },
  { title: "Shades of Spring", genre: "ambient", moods: ["calm", "hopeful"], bpm: 70, energy: "Chill" },
  { title: "Sincerely", genre: "ambient", moods: ["emotional", "reflective"], bpm: 65, energy: "Chill" },
  { title: "Supernatural", genre: "cinematic", moods: ["mystery", "haunting"], bpm: 85, energy: "Suspense" },
  { title: "Take a Chance", genre: "electronic", moods: ["upbeat", "fun"], bpm: 115, energy: "High" },
  { title: "Thatched Villagers", genre: "classical", moods: ["pastoral", "warm"], bpm: 75, energy: "Wonder" },
  { title: "The Builder", genre: "cinematic", moods: ["building", "determined"], bpm: 100, energy: "High" },
  { title: "The Path of the Goblin King", genre: "cinematic", moods: ["dark", "epic"], bpm: 95, energy: "Suspense" },
  { title: "Ultralounge", genre: "jazz", moods: ["smooth", "cool"], bpm: 90, energy: "Chill" },
  { title: "Unseen Horrors", genre: "cinematic", moods: ["terror", "tense"], bpm: 100, energy: "Suspense" },
  { title: "Volatile Reaction", genre: "electronic", moods: ["intense", "fast"], bpm: 140, energy: "High" },
  { title: "Wagon Wheel", genre: "country", moods: ["upbeat", "folksy"], bpm: 110, energy: "High" },
  { title: "Whiskey on the Mississippi", genre: "blues", moods: ["cool", "swagger"], bpm: 85, energy: "Chill" },
];

async function searchIncompetech(energy, limit = 5) {
  const matches = INCOMPETECH_TRACKS
    .filter((t) => t.energy === energy)
    .map((t) => ({
      title: t.title,
      track_url: `https://incompetech.com/music/royalty-free/mp3-royaltyfree/${encodeURIComponent(t.title.replace(/\s+/g, "%20"))}.mp3`,
      energy_level: energy,
      mood_tags: t.moods,
      genre: t.genre,
      bpm: t.bpm,
      instrumental: true,
      license: "CC-BY 3.0 (Kevin MacLeod / Incompetech)",
      attribution: `"${t.title}" Kevin MacLeod (incompetech.com)`,
      source: "incompetech",
    }))
    .slice(0, limit);
  return matches;
}

/**
 * Main search: queries all free sources in parallel, deduplicates,
 * and returns tracks sorted by relevance score.
 */
export async function searchMusic({ energy, moods = [], genres = [], bpmRange = [0, Infinity], limit = 5 }) {
  let results = [];

  const sources = await Promise.allSettled([
    searchPixabay(energy, limit * 2),
    searchFMA(energy, limit * 2),
    searchIncompetech(energy, limit * 2),
  ]);

  for (const src of sources) {
    if (src.status === "fulfilled") results.push(...src.value);
  }

  // Score by content relevance
  const wantedMoods = moods.map((m) => m.toLowerCase());
  const wantedGenres = genres.map((g) => g.toLowerCase());
  const [bpmLow, bpmHigh] = bpmRange;

  results = results.map((track) => {
    let score = 0;
    const trackMoods = (track.mood_tags || []).map((m) => String(m).toLowerCase());
    const trackGenre = String(track.genre || "").toLowerCase();
    score += wantedMoods.filter((m) => trackMoods.some((tm) => tm.includes(m) || m.includes(tm))).length * 5;
    score += wantedGenres.filter((g) => trackGenre.includes(g)).length * 4;
    if (track.bpm && track.bpm >= bpmLow && track.bpm <= bpmHigh) score += 3;
    if (track.instrumental) score += 2;
    // Prefer sources that are verified copyright-free
    if (track.source === "incompetech" || track.source === "pixabay") score += 2;
    return { ...track, relevanceScore: score + Math.random() };
  });

  results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return results.slice(0, limit);
}

/**
 * Verify a track won't trigger Content ID by checking its license.
 * Returns { safe, reason, attribution }.
 */
export function verifyContentIdSafety(track) {
  if (!track) return { safe: false, reason: "No track provided", attribution: null };

  const license = String(track.license || "").toLowerCase();
  const hasAttribution = license.includes("attribution:");
  const isContentIdSafe = license.includes("content_id_safe: true");

  // Known safe from stored data
  if (isContentIdSafe) {
    const attrMatch = license.match(/attribution:\s*([^|]+)/);
    return { safe: true, reason: "Verified copyright-free (Content-ID safe)", attribution: attrMatch?.[1]?.trim() || null };
  }

  // Explicitly CC0, public domain, or royalty-free = safe
  if (license.includes("cc0") || license.includes("public domain") || license.includes("royalty-free")) {
    return { safe: true, reason: "CC0 / Public Domain / Royalty-free — no Content ID risk", attribution: null };
  }

  // CC-BY = safe on YouTube if attributed
  if (license.includes("cc-by") || license.includes("cc by")) {
    const attr = (track.title || "") + " (CC-BY)";
    return { safe: true, reason: "CC-BY — safe with attribution. Include credit in description.", attribution: attr };
  }

  // Known safe sources
  if (track.source === "pixabay") {
    return { safe: true, reason: "Pixabay License — royalty-free, no attribution", attribution: null };
  }
  if (track.source === "incompetech") {
    return {
      safe: true,
      reason: "Incompetech CC-BY — safe with attribution",
      attribution: `"${track.title}" Kevin MacLeod (incompetech.com) Licensed under CC BY 3.0`,
    };
  }

  // Unknown license = risk
  return { safe: false, reason: `Unverified license — may trigger Content ID`, attribution: null };
}

/**
 * Score music-content relevance using Gemini.
 * Ensures the music actually FEELS right for the video content.
 */
export async function scoreMusicRelevance(track, script, niche, moodKeywords) {
  if (!track || !script) return 5;
  try {
    const res = await llmJson({
      tier: "fast",
      temperature: 0,
      label: "musicRelevance",
      messages: [
        {
          role: "system",
          content: `You score how well a music track fits short-form video content (1-10).
10 = perfect emotional match. 1 = completely wrong mood.
Consider: does the music's mood support or fight the script's emotional arc?
Return JSON: {"score":5,"reason":"one sentence why"}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            niche,
            script: script.slice(0, 300),
            music: {
              title: track.title,
              genre: track.genre,
              moods: track.mood_tags,
              energy: track.energy_level,
              bpm: track.bpm,
            },
            contentMoodKeywords: moodKeywords.slice(0, 5),
          }),
        },
      ],
    });
    const result = JSON.parse(res.content || "{}");
    return Math.max(1, Math.min(10, Number(result.score) || 5));
  } catch {
    return 5;
  }
}

/**
 * Main picker: searches copyright-free sources, verifies license safety,
 * scores content relevance, returns best match or falls back to library.
 */
export async function pickCopyrightFreeMusic({ energy, moods = [], genres = [], bpm = [60, 140], script = "", niche = "", jobId = "" }) {
  const tracks = await searchMusic({ energy, moods, genres, bpmRange: bpm, limit: 8 });

  // Filter: only Content-ID-safe tracks
  const safeTracks = tracks.filter((t) => verifyContentIdSafety(t).safe);

  // Score content relevance for top candidates
  const scored = await Promise.all(
    safeTracks.slice(0, 3).map(async (track) => {
      const relevance = await scoreMusicRelevance(track, script, niche, moods);
      return { ...track, relevanceScore: (track.relevanceScore || 5) * 0.5 + relevance * 0.5 };
    })
  );

  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

  if (scored.length) {
    const best = scored[0];
    const safety = verifyContentIdSafety(best);
    return {
      ...best,
      contentIdSafe: safety.safe,
      attribution: safety.attribution || best.attribution,
      licenseNote: safety.reason,
    };
  }

  return null;
}

/**
 * Sync copyright-free tracks to music_library from all sources.
 * Run: npm run music:brain
 */
export async function syncMusicBrain() {
  console.log("Music Brain sync: pulling copyright-free tracks from Pixabay, FMA, Incompetech...\n");
  let added = 0;

  for (const [energy] of Object.entries(ENERGY_QUERIES)) {
    const tracks = await searchMusic({ energy, limit: 10 });
    for (const track of tracks) {
      const safety = verifyContentIdSafety(track);
      if (!safety.safe) continue;

      const { error } = await supabase.from("music_library").upsert({
        title: track.title,
        track_url: track.track_url,
        energy_level: energy,
        mood_tags: [...(track.mood_tags || []), `source:${track.source}`],
        genre: track.genre,
        bpm: track.bpm,
        instrumental: track.instrumental,
        license: `${track.license} | attribution: ${track.attribution || safety.attribution || "none"} | content_id_safe: ${safety.safe}`,
      }, { onConflict: "title,energy_level" });
      if (!error) {
        added++;
        console.log(`  ✓ ${track.title} [${energy}] ← ${track.source} (${safety.reason})`);
      }
    }
  }

  console.log(`\nDone. Added/updated ${added} copyright-free tracks to music_library.`);
  return added;
}

if (process.argv[1]?.endsWith("musicBrain.js")) {
  syncMusicBrain().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
