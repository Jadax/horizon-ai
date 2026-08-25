/**
 * Leo Composer — platform hashtag sets for pet content. The compilation
 * engine that used to live here was removed: the clip-library path in
 * pipeline/leo.js (processClipFromVideo) replaced it and nothing imported
 * the old builders anymore.
 */

/**
 * Generate platform-optimized hashtags for pet content.
 */
export function petHashtags(platform) {
  const base = ["#cat", "#catsoftiktok", "#kitten", "#catlover", "#meow", "#catoftheday"];
  if (platform === "youtube") return [...base, "#catsofyoutube", "#shorts", "#pets", "#funnycats", "#catvideos"];
  if (platform === "instagram") return [...base, "#catsofinstagram", "#reels", "#petsofinstagram", "#catlife", "#meow"];
  if (platform === "tiktok") return [...base, "#cattok", "#fyp", "#petsoftiktok", "#viralcats", "#catsoftiktok"];
  return base;
}
