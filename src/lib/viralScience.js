/**
 * VIRAL SCIENCE — distilled, RESEARCH-BACKED constants actually consumed by
 * the pipeline. Only four exports survive review (everything else in this
 * file's history — retention arcs, platform rules, posting windows,
 * thumbnail strategies... — had zero importers and was deleted in v3.16.0;
 * the reference research now lives in docs/creator-ops-playbook.md):
 *
 *   agent2_scriptwriter.js → HOOK_TEMPLATES, NICHE_VIRAL_PATTERNS, WPM_BY_NICHE
 *   run.js                 → VOICE_BY_NICHE
 */

// ─── HOOK TEMPLATES BY NICHE ─────────────────────────────────────────

export const HOOK_TEMPLATES = {
  universal: [
    { pattern: "curiosity_gap", template: "{subject} — but {unexpected twist}", example: "This cat — but he thinks he's a dog" },
    { pattern: "number_hook", template: "{number} {things} {action}", example: "3 signs your cat secretly hates you" },
    { pattern: "contrarian", template: "Stop {common action}. Here's why.", example: "Stop feeding your cat dry food. Here's why." },
    { pattern: "pov", template: "POV: {relatable situation}", example: "POV: you're a cat at 3am" },
    { pattern: "emotional", template: "I can't believe {thing}...", example: "I can't believe what my cat just did..." },
    { pattern: "question", template: "Did you know {surprising fact}?", example: "Did you know cats can make 100 different sounds?" },
    { pattern: "shock_value", template: "{person/thing} just {dramatic action}", example: "This cat just figured out how to open doors" },
    { pattern: "identity", template: "If you {trait}, you need to {action}", example: "If you own a cat, you need to see this" },
    { pattern: "before_after", template: "{context}: before vs after {event}", example: "My cat: before vs after seeing a cucumber" },
    { pattern: "challenge", template: "Try not to {reaction} when {trigger}", example: "Try not to smile when you see this" },
  ],
  pet: [
    { pattern: "pov_cat", template: "POV: you're a cat who {action}", example: "POV: you're a cat who's never been fed (ever)" },
    { pattern: "caught_in", template: "CAUGHT IN 4K: {action}", example: "CAUGHT IN 4K: The moment he realized" },
    { pattern: "zoomies", template: "{time} zoomies hit different", example: "3am zoomies hit different" },
    { pattern: "judgement", template: "The judgement is {adjective}", example: "The judgement is REAL" },
    { pattern: "purrsonality", template: "Every cat has a {trait}. Mine:", example: "Every cat has a secret talent. Mine:" },
    { pattern: "wait_for_it", template: "Wait for the {moment}...", example: "Wait for the slow blink..." },
    { pattern: "cozy_vibe", template: "Nothing beats {cozy situation}", example: "Nothing beats a rainy nap day" },
  ],
  finance: [
    { pattern: "money_stakes", template: "${amount} mistake most {people} make", example: "$50,000 mistake most investors make" },
    { pattern: "insider_secret", template: "What they don't tell you about {topic}", example: "What banks don't tell you about savings" },
    { pattern: "rule_of_thumb", template: "The {number}% rule of {topic}", example: "The 4% rule of retirement" },
    { pattern: "warning", template: "If you {action}, {consequence}", example: "If you keep cash in savings, you're losing money" },
  ],
  tech: [
    { pattern: "hidden_feature", template: "{number} {product} features nobody uses", example: "7 iPhone features nobody uses" },
    { pattern: "vs_comparison", template: "{thingA} vs {thingB}: the real difference", example: "OLED vs Mini-LED: the real difference" },
    { pattern: "productivity_hack", template: "This {tool} saved me {time}", example: "This app saved me 10 hours a week" },
  ],
  gaming: [
    { pattern: "secret_tech", template: "The {mechanic} nobody talks about", example: "The movement tech nobody talks about" },
    { pattern: "insane_clip", template: "Watch until {point}...", example: "Watch until the 0.2 second reaction..." },
    { pattern: "lore_drop", template: "The dark truth about {character/event}", example: "The dark truth about Melina" },
  ],
  news: [
    { pattern: "breaking_context", template: "BREAKING: {fact} — here's what it means", example: "BREAKING: Fed rate cut — here's what changes" },
    { pattern: "consequence", template: "Because of {event}, {consequence}", example: "Because of this bill, your internet could change" },
  ],
};

// Which Gemini voice matches each niche's proven voice style. The Vāṇī
// 30-video field test: Horror=deep/breathy (+22% AVD), Facts=fast/neutral
// (+18%), Motivation=authoritative/bold (+30%), News=news-neutral (+12%).
// Map from niche_name to one of the 12 Gemini prebuilt voices (see
// freeTTS.js GEMINI_VOICES); falls back to the niche's voice_profile_id.
export const VOICE_BY_NICHE = {
  Aesthetic: "Zephyr",           // soft cinematic wonder
  Explained: "Charon",           // curious storyteller
  Finance: "Fenrir",             // authoritative bold numbers
  Food: "Kore",                  // warm inviting host
  "Gaming/Lore": "Fenrir",       // epic deep lore narrator
  Leo: "Kore",                   // warm playful (already set)
  "Mindful/Calm": "Kore",        // gentle reassuring
  News: "Fenrir",                // urgent broadcast authority
  "News India": "Fenrir",
  Psychology: "Charon",          // calm analytical
  Technology: "Puck",            // energetic fast explainer
  Travel: "Orus",                // warm wanderlust
  Viral: "Puck",                 // high-energy punchy
};

// Per-niche spoken density: Shorts run fast (170 wpm) so more info lands
// per second; slow cinematic niches breathe (140 wpm). Injected into
// agent2's word-count math via editing_style_preset.wpm (dashboard-set
// override wins over this table).
export const WPM_BY_NICHE = {
  Aesthetic: 140,
  Explained: 150,
  Finance: 165,
  Food: 145,
  "Gaming/Lore": 165,
  Leo: 145,
  "Mindful/Calm": 140,
  News: 170,
  "News India": 170,
  Psychology: 150,
  Technology: 165,
  Travel: 150,
  Viral: 170,
};

// ─── NICHE VIRAL PATTERNS ─────────────────────────────────────────────

export const NICHE_VIRAL_PATTERNS = {
  Pet: {
    topFormats: ["compilation", "pov_narrative", "single_moment_loop"],
    musicMood: ["chill", "cozy", "lofi", "warm"],
    captionColors: ["cream", "pink", "white"],
    textStyle: "warm and playful, POV perspective, emoji at payoff moments",
    sfxTiming: "boing at jump scares, pop at head tilts, slide at transitions",
    hookStrategy: "Curiosity + emotion — make them NEED to see what happens next",
    growthLevers: [
      "Cross-post identical content to YT+IG+TT = 3x reach from one video",
      "Reply to comments with video = engagement loop",
      "Pin your best-performing short as channel trailer",
      "Use same sound across multiple videos to build sound recognition",
    ],
  },
  Finance: {
    topFormats: ["data_reveal", "consequence_warning", "rule_of_thumb"],
    musicMood: ["tense", "driven", "minimal"],
    captionColors: ["sky", "mint"],
    textStyle: "bold numbers, clear data visualization, authoritative but casual",
    hookStrategy: "Specific dollar amount + personal consequence",
    growthLevers: [
      "Long-form deep dives linked from shorts = RPM 50-100x higher",
      "Email newsletter mention in every description = owned audience",
      "Affiliate links in first pinned comment (before link shows in mobile)",
    ],
  },
  Gaming: {
    topFormats: ["clip_highlight", "secret_tech", "lore_breakdown"],
    musicMood: ["high", "epic", "suspense"],
    captionColors: ["yellow", "sky"],
    textStyle: "fast, kinetic text, matching game UI aesthetic, arrow annotations",
    hookStrategy: "Impossible clip first, then context. 'This should not be possible.'",
  },
  Technology: {
    topFormats: ["comparison", "hidden_feature", "productivity_hack"],
    musicMood: ["minimal", "driven", "futuristic"],
    captionColors: ["mint", "sky"],
    textStyle: "clean, minimal, tech-forward, number-heavy",
    hookStrategy: "Everyday product + hidden capability = instant curiosity",
  },
};
