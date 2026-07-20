/**
 * MUSIC LIBRARY SYNC — pulls CC-licensed tracks from Jamendo's official API
 * into the Supabase music_library, tagged by the energy levels the pipeline
 * already picks from (Wonder/Chill/High/Suspense).
 *
 * Why Jamendo: Pixabay Music, Bensound, and Uppbeat have no official APIs —
 * their catalogs are website-download only, so "automatically source from
 * them" would mean scraping. Jamendo is the one big catalog with a real,
 * free API (client_id from https://devportal.jamendo.com — free signup).
 * Only ccby/ccby-sa tracks are taken (commercial use allowed with
 * attribution; the artist credit is stored so descriptions can carry it).
 *
 * Usage: JAMENDO_CLIENT_ID=xxx npm run music:sync
 * One-time alternative: download tracks manually from Pixabay/Uppbeat and
 * insert rows into music_library yourself — the pipeline doesn't care where
 * a track came from, only its energy_level/mood_tags/track_url.
 */
import { config } from "../config.js";
import { supabase } from "../supabase.js";

const ENERGY_QUERIES = {
  Wonder: { tags: "ambient+cinematic", speed: "low" },
  Chill: { tags: "lounge+chillout", speed: "low" },
  High: { tags: "energetic+electronic", speed: "high" },
  Suspense: { tags: "dark+cinematic", speed: "medium" },
};
const TRACKS_PER_ENERGY = 5;

export async function syncJamendoMusic() {
  const clientId = process.env.JAMENDO_CLIENT_ID;
  if (!clientId) {
    console.error("JAMENDO_CLIENT_ID is not set. Get a free one at https://devportal.jamendo.com, then run: JAMENDO_CLIENT_ID=xxx npm run music:sync");
    process.exit(1);
  }
  for (const [energy, q] of Object.entries(ENERGY_QUERIES)) {
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${clientId}&format=json&limit=${TRACKS_PER_ENERGY}` +
      `&fuzzytags=${q.tags}&speed=${q.speed}&include=licenses&audioformat=mp32&ccsa=true&ccnd=false&ccnc=false&order=popularity_total`;
    const res = await fetch(url);
    if (!res.ok) { console.error(`${energy}: Jamendo HTTP ${res.status}`); continue; }
    const json = await res.json();
    for (const track of json.results || []) {
      if (!track.audio) continue;
      const audioRes = await fetch(track.audio);
      if (!audioRes.ok) continue;
      const buffer = Buffer.from(await audioRes.arrayBuffer());
      const path = `music/jamendo-${track.id}.mp3`;
      const { error: upErr } = await supabase.storage.from("renders").upload(path, buffer, { contentType: "audio/mpeg", upsert: true });
      if (upErr) { console.error(`${track.name}: upload failed — ${upErr.message}`); continue; }
      const { data } = supabase.storage.from("renders").getPublicUrl(path);
      const { error: dbErr } = await supabase.from("music_library").upsert({
        title: `${track.name} — ${track.artist_name} (CC, Jamendo)`,
        energy_level: energy,
        mood_tags: q.tags.split("+"),
        track_url: data.publicUrl,
        genre: q.tags.split("+")[0],
        instrumental: true,
      }, { onConflict: "title" });
      console.log(dbErr ? `${track.name}: DB insert failed — ${dbErr.message}` : `${energy}: added "${track.name}" by ${track.artist_name}`);
    }
  }
  console.log("Music sync complete.");
}

if (process.argv[1]?.endsWith("musicSync.js")) {
  syncJamendoMusic().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
