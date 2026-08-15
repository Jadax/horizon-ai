/**
 * SFX SYNC — stock sfx_library with one-shot sound effects so agent4's
 * hook/payoff stingers finally have ammo. Mirrors musicSync's pattern:
 * nothing here is required for a render to work (pickSfx degrades to a
 * no-op on an empty library), but a stinger on the hook + payoff is a
 * real retention lever and previously sfx_library was always empty because
 * no seeder existed. Run: npm run sfx:sync
 *
 * Source: Pixabay Sound Effects API (free tier, same PIXABAY_API_KEY as the
 * footage search — no new key, no paid dep). All returned sounds are
 * "Pixabay License" royalty-free, no attribution required, Content-ID safe.
 */
import { supabase } from "../supabase.js";
import { config } from "../config.js";

const SFX_API = "https://pixabay.com/api/sfx/";

// Tags are the exact keys agent4_shotstack.js feeds pickSfx, so syncing
// these fills the exact slots the renderer is already looking for.
const TAGS = ["hook", "pop", "ding", "impact", "payoff", "chime", "whoosh", "riser", "stinger", "click", "boing", "zap", "glitch", "swish"];

async function fetchTag(tag, perPage = 8) {
  if (!config.pixabayKey) return [];
  try {
    const res = await fetch(`${SFX_API}?key=${config.pixabayKey}&q=${encodeURIComponent(tag)}&per_page=${perPage}`);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.hits || [])
      .filter((h) => h.audio)
      .map((h) => ({
        title: (h.tags || h.username || "").split(",")[0]?.trim() || `${tag} sfx`,
        track_url: h.audio,
        tags: [tag, ...(h.tags || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 3)],
        license: "Pixabay License (royalty-free, no attribution required)",
        duration: h.duration || null,
        download_count: h.download_count || 0,
      }));
  } catch {
    return [];
  }
}

export async function syncSfxLibrary() {
  console.log("SFX sync: pulling one-shot sound effects from Pixabay...\n");
  let added = 0;
  let skipped = 0;

  for (const tag of TAGS) {
    const hits = await fetchTag(tag);
    for (const hit of hits) {
      // sfx_library has no unique constraint — dedupe manually like musicSync.
      const { data: existing } = await supabase
        .from("sfx_library")
        .select("id")
        .eq("title", hit.title)
        .maybeSingle();
      if (existing) {
        skipped++;
        continue;
      }
      const { error } = await supabase.from("sfx_library").insert(hit);
      if (!error) {
        added++;
        console.log(`  ✓ "${hit.title}" [${tag}]`);
      }
    }
    await new Promise((r) => setTimeout(r, 300)); // free-tier pacing
  }

  console.log(`\nDone. Added ${added} SFX (${skipped} already present).`);
  return added;
}

if (process.argv[1]?.endsWith("sfxSync.js")) {
  syncSfxLibrary().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
