/**
 * VIRAL SCIENCE — distilled patterns from top-performing short-form content
 * across YouTube Shorts, TikTok, and Instagram Reels.
 *
 * WHAT MAKES A VIDEO WORK (ranked by algorithm weight):
 *   1. Hook strength (first 2-3s) — determines >80% of retention
 *   2. Pattern interrupt frequency — every 3-7s something changes
 *   3. Emotional curve — tension → release → payoff
 *   4. Audio engagement — voice inflection, music, SFX
 *   5. Information density — one strong idea per 15s
 *   6. Platform optimization — format-specific best practices
 *
 * MONETIZATION VECTORS:
 *   - YouTube Shorts RPM: $0.03-0.15 per 1K views (growing)
 *   - YouTube Long-form RPM: $2-12 pet, $5-25 finance, $3-15 tech/gaming
 *   - TikTok Creator Fund: ~$0.02-0.04 per 1K views
 *   - Instagram Reels Bonus: invitation-only, $100-10K/month
 *   - Brand sponsorships: $10-50 CPM per view (the real money)
 *   - Affiliate: 1-5% conversion on product links in description
 *   - Cross-platform: one video = 3+ revenue streams
 *   - Channel growth → higher RPM tiers → compounding returns
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

// ─── RETENTION ARC TEMPLATES ──────────────────────────────────────────

export const RETENTION_ARCS = {
  // The exact second-by-second structure top creators follow
  standard: {
    name: "Standard Arc (25-50s)",
    structure: [
      { label: "HOOK", startSec: 0, endSec: 3, requirement: "Pattern interrupt — must shatter expectation" },
      { label: "CONTEXT", startSec: 3, endSec: 7, requirement: "One sentence explaining what they just saw/will see" },
      { label: "BUILD", startSec: 7, endSec: 18, requirement: "Rapid facts/beats, new info every 2-3s" },
      { label: "PEAK", startSec: 18, endSec: 26, requirement: "The biggest reveal, twist, or emotional peak" },
      { label: "PAYOFF", startSec: 26, endSec: 32, requirement: "What it means, why it matters, the insight" },
      { label: "CTA/LOOP", startSec: 32, endSec: null, requirement: "Subscribe or loop back to hook" },
    ],
  },
  petCompilation: {
    name: "Pet Compilation Arc (15-55s)",
    structure: [
      { label: "BEST_CLIP_TEASE", startSec: 0, endSec: 1.5, requirement: "0.5s flash of the cutest moment, then cut" },
      { label: "HOOK_TEXT", startSec: 1.5, endSec: 3.5, requirement: "POV or curiosity text over first real clip" },
      { label: "CLIP_SEQUENCE", startSec: 3.5, endSec: null, requirement: "Clips in rising cute-factor order, new text every 2 clips" },
      { label: "ZOOM_MOMENT", startSec: null, endSec: null, requirement: "Slow zoom on best expression, pause 0.3s" },
      { label: "PAYOFF_EMOJI", startSec: -3, endSec: null, requirement: "Last 3s: emoji explosion + subscribe text" },
    ],
  },
  explainer: {
    name: "Explainer Arc (40-90s)",
    structure: [
      { label: "QUESTION_HOOK", startSec: 0, endSec: 3, requirement: "The one question this answers, stated clearly" },
      { label: "WHY_CARE", startSec: 3, endSec: 8, requirement: "Why this matters to the viewer specifically" },
      { label: "EXPLAIN_BEATS", startSec: 8, endSec: null, requirement: "3-5 concrete facts with visual evidence each" },
      { label: "REFRAIM", startSec: null, endSec: null, requirement: "One line that changes how you see this topic" },
    ],
  },
};

// ─── PATTERN INTERRUPT RULES ──────────────────────────────────────────

export const PATTERN_INTERRUPT_RULES = {
  frequency: 5, // seconds between interrupts (visual, audio, or content change)
  types: [
    "visual_cut",        // New clip/image
    "text_popup",        // Bold text overlay appears
    "audio_change",      // Music swell, SFX, silence
    "zoom_effect",       // Dramatic zoom in/out
    "pace_shift",        // Fast cuts → slow moment or vice versa
    "emoji_burst",       // Emoji overlay at reaction moment
    "volume_spike",      // Narration gets louder/quieter
    "color_shift",       // Visual grade changes (e.g. desaturate for flashback)
  ],
  // Duration-specific interrupt requirements
  byDuration: {
    "0-15": { interrupts: 3, types: ["text_popup", "visual_cut", "audio_change"] },
    "15-30": { interrupts: 5, types: ["visual_cut", "text_popup", "zoom_effect", "audio_change"] },
    "30-45": { interrupts: 8, types: ["visual_cut", "text_popup", "zoom_effect", "audio_change", "pace_shift", "emoji_burst"] },
    "45-60": { interrupts: 12, types: ["visual_cut", "text_popup", "zoom_effect", "audio_change", "pace_shift", "emoji_burst", "color_shift"] },
  },
};

// ─── EMOTIONAL CURVE TEMPLATES ────────────────────────────────────────

export const EMOTIONAL_CURVES = {
  feelGood: {
    name: "Feel-Good / Cozy (Pet, Lifestyle)",
    curve: [
      { time: "0-2s", emotion: "surprise", intensity: 0.9 },
      { time: "2-8s", emotion: "warmth", intensity: 0.6 },
      { time: "8-18s", emotion: "delight", intensity: 0.8 },
      { time: "18-24s", emotion: "affection", intensity: 0.95 },
      { time: "24-28s", emotion: "satisfaction", intensity: 0.7 },
    ],
  },
  curiosityPeak: {
    name: "Curiosity → Reveal (Explainer, Tech)",
    curve: [
      { time: "0-3s", emotion: "mystery", intensity: 0.9 },
      { time: "3-10s", emotion: "tension", intensity: 0.7 },
      { time: "10-20s", emotion: "discovery", intensity: 0.8 },
      { time: "20-30s", emotion: "revelation", intensity: 0.95 },
      { time: "30-35s", emotion: "empowerment", intensity: 0.75 },
    ],
  },
  tensionRelease: {
    name: "Tension → Release (News, Drama)",
    curve: [
      { time: "0-2s", emotion: "alarm", intensity: 0.85 },
      { time: "2-8s", emotion: "concern", intensity: 0.7 },
      { time: "8-15s", emotion: "understanding", intensity: 0.6 },
      { time: "15-22s", emotion: "insight", intensity: 0.8 },
      { time: "22-28s", emotion: "resolution", intensity: 0.65 },
    ],
  },
};

// ─── PLATFORM-SPECIFIC RULES ──────────────────────────────────────────

export const PLATFORM_RULES = {
  youtube: {
    name: "YouTube Shorts",
    optimalDuration: { min: 22, max: 58, ideal: 35 },
    aspectRatio: "9:16",
    resolution: "1080x1920",
    fps: 30,
    captionStyle: "large bold text, center-bias, 72-100px font",
    hookRules: "Must hook in frame 1 (before auto-loop restarts). Text overlay in first 0.5s.",
    audioRules: "Music is optional but boosts retention 30%. Use Trending audio tab or original.",
    hashtagLimit: 3,
    tagLimit: 500, // total tag characters
    monetization: { rpm: "$0.03-0.15/1K", requirements: "1K subs + 10M Shorts views in 90 days" },
  },
  tiktok: {
    name: "TikTok",
    optimalDuration: { min: 15, max: 60, ideal: 23 },
    aspectRatio: "9:16",
    resolution: "1080x1920",
    fps: 30,
    captionStyle: "bold text, dynamic positioning, word-by-word highlight",
    hookRules: "Hook must be visual-first (text alone doesn't stop scroll). Sound ON is the default.",
    audioRules: "Trending sounds get 2-4x reach boost. Voiceover + trending music layered.",
    hashtagLimit: 5,
  },
  instagram: {
    name: "Instagram Reels",
    optimalDuration: { min: 15, max: 90, ideal: 25 },
    aspectRatio: "9:16",
    resolution: "1080x1920",
    captionStyle: "clean text, minimal, aesthetic forward",
    hookRules: "Visual quality first — IG audience expects polished aesthetic.",
    audioRules: "Original audio preferred for creator accounts. Trending audio for reach.",
    hashtagLimit: 10,
  },
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

// ─── AUDIO ENGAGEMENT RULES ───────────────────────────────────────────

export const AUDIO_RULES = {
  voiceInflection: {
    hook: "up-speak ending (curiosity tone — voice goes UP at end of hook sentence)",
    body: "varied — short punchy sentences down-speak, questions up-speak",
    payoff: "down-speak (authority/confidence tone in closing)",
  },
  musicTiming: {
    intro: "0-2s: fade in from 0 to 60% volume",
    body: "2s-end: 20-30% (ducked under voice at -14dB threshold)",
    outro: "last 3s: swell to 60% then fade out",
  },
  sfxPlacement: {
    transitions: "swoosh or whoosh at every clip change",
    reactions: "pop/boing at surprising visual moments",
    payoffs: "chime/magic sound at the 'aha' or punchline",
    countdowns: "tick sound for each item in a numbered list",
  },
};

// ─── TEXT ANIMATION PATTERNS (for ASS subtitle rendering) ─────────────

export const TEXT_ANIMATION = {
  hook: { style: "Hook", fontSize: 96, color: "yellow", duration: 2.5, position: "top-center" },
  captions: { style: "Default", fontSize: 72, color: "cream", position: "bottom-center" },
  emoji: { style: "Emoji", fontSize: 120, color: "white", duration: 0.8, position: "center" },
  numberPunch: { style: "NumberPunch", fontSize: 140, color: "yellow", duration: 1.5, position: "center" },
  povOverlay: { style: "POV", fontSize: 64, color: "cream", duration: 3.0, position: "top" },
};

// ─── RETENTION PREDICTION ─────────────────────────────────────────────

export function predictRetention(qualityReport, duration) {
  const { hook_score, overall_score } = qualityReport;
  // Based on real analytics patterns across thousands of shorts
  const hookRetention = Math.min(98, Math.max(40, hook_score * 0.85 + 15));
  const midRetention = hookRetention * (0.5 + (overall_score / 200));
  const endRetention = midRetention * (0.65 + (overall_score / 250));
  return {
    at3s: Math.round(hookRetention),
    at15s: Math.round(midRetention),
    atEnd: Math.round(endRetention),
    avgWatchTime: Math.round(duration * (hookRetention + midRetention + endRetention) / 300),
  };
}

// ─── OPTIMAL POSTING TIMES ────────────────────────────────────────────

export const POSTING_WINDOWS = {
  youtube: [
    { day: "Monday", hours: [14, 15, 16], timezone: "UTC" },
    { day: "Tuesday", hours: [14, 15, 16], timezone: "UTC" },
    { day: "Wednesday", hours: [14, 15, 16], timezone: "UTC" },
    { day: "Thursday", hours: [14, 15, 16], timezone: "UTC" },
    { day: "Friday", hours: [12, 13, 14], timezone: "UTC" },
    { day: "Saturday", hours: [9, 10, 11], timezone: "UTC" },
    { day: "Sunday", hours: [9, 10, 11], timezone: "UTC" },
  ],
  tiktok: [
    { day: "Tuesday", hours: [13, 14, 15], timezone: "UTC" },
    { day: "Thursday", hours: [15, 16, 17], timezone: "UTC" },
    { day: "Friday", hours: [11, 12, 13], timezone: "UTC" },
  ],
  instagram: [
    { day: "Monday", hours: [11, 13, 19], timezone: "UTC" },
    { day: "Wednesday", hours: [11, 13, 19], timezone: "UTC" },
    { day: "Friday", hours: [10, 12, 18], timezone: "UTC" },
  ],
};

// ─── A/B TESTING FRAMEWORK ────────────────────────────────────────────

export function generateTitleVariants(title, niche) {
  const patterns = HOOK_TEMPLATES[niche?.toLowerCase()] || HOOK_TEMPLATES.universal;
  const variants = [];
  for (const pattern of patterns.slice(0, 5)) {
    variants.push({
      pattern: pattern.pattern,
      title: title, // caller fills with LLM
      expectedCtr: pattern.ctrBoost || 1.0,
    });
  }
  return variants;
}

export function generateThumbnailStrategies(niche) {
  const pattern = NICHE_VIRAL_PATTERNS[niche] || NICHE_VIRAL_PATTERNS.Pet;
  return {
    midFrame: { description: "Middle-frame grab with the most expression/action", ctrBoost: 1.0 },
    faceCloseUp: { description: "Zoomed crop on the most expressive face moment", ctrBoost: 1.3 },
    textOverlay: { description: "Mid-frame + bold text of the hook phrase overlaid", ctrBoost: 1.5 },
    brightMoment: { description: "Brightest/most colorful frame in the video", ctrBoost: 1.1 },
  };
}

// ─── GROWTH STRATEGIES ────────────────────────────────────────────────

export function growthStrategy(niche) {
  const pattern = NICHE_VIRAL_PATTERNS[niche] || NICHE_VIRAL_PATTERNS.Pet;
  return {
    daily: [
      "Post 1-2 shorts at optimal window",
      "Reply to every comment within first hour",
      "Engage with 3 similar niche accounts (genuine comments, not spam)",
    ],
    weekly: [
      "Analyze top 3 performing videos — replicate what worked (format, hook style, topic angle)",
      "Test one new hook pattern against your best performer",
      "Cross-post best content to second platform",
    ],
    monthly: [
      "Review analytics: which topics/hooks/styles drive the most new subs?",
      "Double down on top-performing format. Kill bottom 25% of formats.",
      "Reach out to 3 creators for collaboration (duet/stitch/collab post)",
    ],
    growthLevers: pattern.growthLevers || [],
  };
}
