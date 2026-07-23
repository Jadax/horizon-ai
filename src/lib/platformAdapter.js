import { config } from "../config.js";
import { estimateRevenue, matchAffiliateProducts } from "./monetization.js";
import { PLATFORM_RULES, NICHE_VIRAL_PATTERNS } from "./viralScience.js";

const YOUTUBE_CATEGORIES = {
  finance: "Education",
  technology: "Science & Technology",
  gaming: "Gaming",
  history: "Education",
  news: "News & Politics",
  food: "Howto & Style",
};

function terms(...values) {
  return [...new Set(values.join(" ").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word.length > 2))];
}

function youtubeTags({ niche, title, tags }) {
  const roots = terms(niche, title, ...(tags || []));
  const modifiers = ["explained", "facts", "story", "analysis", "guide", "shorts", "video", "today", "tips", "insights"];
  const candidates = [...roots, ...(tags || [])];
  for (const root of roots) {
    for (const modifier of modifiers) candidates.push(`${root} ${modifier}`);
  }
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) candidates.push(`${roots[i]} ${roots[j]}`);
  }
  const output = [];
  let characters = 0;
  const unique = [...new Set(candidates.map(String).map((value) => value.trim()).filter(Boolean))]
    .sort((a, b) => a.length - b.length);
  for (const tag of unique) {
    if (output.length >= 60) break;
    const added = tag.length + (output.length ? 1 : 0);
    if (characters + added > 500) continue;
    output.push(tag);
    characters += added;
  }
  return output;
}

export function buildPublishPackage({
  jobId,
  niche,
  videoUrl,
  subtitleUrl,
  syncPrecisionMs,
  duration,
  title,
  description,
  tags,
  thumbnailUrl,
  coverVariants,
  qualityReport,
  platforms = config.publishPlatforms,
  monetizationEnabled = Boolean(config.affiliate.trackingId),
}) {
  if (!qualityReport?.technical_pass || Number(qualityReport.overall_score) < config.contentQualityThreshold) {
    throw new Error("Cannot build publish package before all mandatory quality gates pass");
  }
  if (!subtitleUrl || Number(syncPrecisionMs) > config.subtitleSyncPrecisionMs) {
    throw new Error("Cannot build publish package without subtitles synchronized to 50ms or better");
  }

  const hashtags = terms(niche, ...(tags || [])).slice(0, 8).map((tag) => `#${tag.replace(/\s+/g, "")}`);
  const viralPattern = NICHE_VIRAL_PATTERNS[niche] || {};
  const affiliates = monetizationEnabled && config.affiliate.trackingId ? matchAffiliateProducts(title, description, niche) : [];
  const insertionPoint = Math.max(0, Math.min(Math.round(duration * 0.65), Math.max(0, Math.round(duration) - 1)));
  const variants = {};

  if (platforms.includes("youtube")) {
    variants.youtube = {
      title: title.slice(0, 100),
      tags: youtubeTags({ niche, title, tags }),
      category: Object.entries(YOUTUBE_CATEGORIES).find(([key]) => niche.toLowerCase().includes(key))?.[1] || "Entertainment",
      description: `${description.slice(0, 500)}\n\n${hashtags.slice(0, 3).join(" ")}`.trim(),
      madeForKids: false,
      selfDeclaredMadeForKids: false,
      // Growth optimization: first comment is the most visible on mobile
      pinnedComment: affiliates.length ? `🔗 ${affiliates.map(a => a.name + ": " + a.affiliateLink).join(" | ")}` : null,
    };
  }
  if (platforms.includes("tiktok")) {
    variants.tiktok = {
      audio_recommendation: "original voiceover",
      effects: ["caption emphasis", "hook punch-in", "semantic cuts"],
      hashtags: [...hashtags, ...trendingHashtags("tiktok", niche)].slice(0, 5),
      // TikTok discovery: first 3 hashtags get the most weight
      caption: `${title.slice(0, 120)}\n.\n.\n.\n${hashtags.slice(0, 5).join(" ")}`,
    };
  }
  if (platforms.includes("instagram")) {
    variants.instagram = {
      cover_variants: (coverVariants || []).slice(0, 3),
      caption: `${title}\n\n${description.slice(0, 300)}\n.\n.\n.\n${hashtags.slice(0, 10).join(" ")}`,
      altText: `${niche} short video: ${title.slice(0, 100)}`,
    };
    if (variants.instagram.cover_variants.length !== 3) throw new Error("Instagram package requires exactly three cover variants");
  }
  if (platforms.includes("linkedin")) {
    variants.linkedin = {
      title: title.slice(0, 120),
      post_text: `${description}\n\n${hashtags.slice(0, 3).join(" ")}`.slice(0, 3000),
    };
  }

  return {
    video: { url: videoUrl, resolution: "1080x1920", duration_sec: Math.round(duration) },
    subtitles: { url: subtitleUrl, sync_precision_ms: syncPrecisionMs },
    metadata: { title, description, hashtags, thumbnail: thumbnailUrl },
    platform_variants: variants,
    quality_report: qualityReport,
    monetization: {
      affiliate_links: affiliates.map((product) => ({ product: product.name, url: product.affiliateLink, insertion_point_sec: insertionPoint })),
      estimated_rpm: estimateRevenue(1000, "youtube", niche),
    },
    job_id: jobId,
  };
}

export function createPublishTargets(publishPackage, platforms = config.publishPlatforms) {
  return platforms.map((platform) => ({
    platform,
    mode: platform === "youtube" ? "direct" : "package",
    status: "package_ready",
    package: {
      video: publishPackage.video,
      subtitles: publishPackage.subtitles,
      metadata: publishPackage.metadata,
      variant: publishPackage.platform_variants[platform] || {},
      monetization: publishPackage.monetization,
    },
  }));
}

// Trending hashtag pools — rotated per platform for freshness
function trendingHashtags(platform, niche) {
  const seasonal = currentSeasonalHashtags();
  const nichePool = {
    Pet: { tiktok: ["#cattok", "#pettok", "#catsoftiktok", "#kittensoftiktok", "#fyp"], instagram: ["#catsofinstagram", "#petstagram", "#catlife", "#meow"] },
    Finance: { tiktok: ["#finance", "#moneytok", "#investing", "#wealth"], instagram: ["#finance", "#investing", "#money"] },
    Technology: { tiktok: ["#techtok", "#technology", "#gadgets", "#future"], instagram: ["#technology", "#tech", "#innovation"] },
    Gaming: { tiktok: ["#gaming", "#gametok", "#gamer", "#gamingontiktok"], instagram: ["#gaming", "#gamer", "#videogames"] },
    News: { tiktok: ["#news", "#breakingnews", "#explained"], instagram: ["#news", "#breakingnews"] },
    Food: { tiktok: ["#foodtok", "#recipe", "#cooking", "#foodie"], instagram: ["#food", "#foodie", "#instafood"] },
  };
  const pool = nichePool[niche]?.[platform] || nichePool[niche]?.instagram || [];
  return [...new Set([...pool, ...seasonal])].slice(0, 5).map(t => t.startsWith("#") ? t : `#${t}`);
}

function currentSeasonalHashtags() {
  const now = new Date();
  const month = now.getMonth();
  if (month === 11 || month === 0) return ["#christmas", "#newyear", "#holiday"];
  if (month >= 5 && month <= 7) return ["#summer", "#summervibes", "#sun"];
  if (month >= 8 && month <= 10) return ["#fall", "#autumn", "#cozy"];
  return [];
}
