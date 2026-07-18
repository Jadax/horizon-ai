/**
 * VIRAL SCORING ENGINE — Advanced virality prediction for video content
 * 
 * Multi-faceted scoring system incorporating:
 * 1. Engagement velocity analysis
 * 2. Emotional resonance (LLM-based)
 * 3. Retention potential
 * 4. Novelty detection
 * 5. Pattern interrupt strength
 * 6. Platform optimization
 * 7. Competitive saturation
 */
import OpenAI from "openai";
import { config } from "../config.js";
import { supabase, logEvent } from "../supabase.js";

const openai = new OpenAI({ apiKey: config.openaiKey });

// Cache for emotional resonance
const emotionalResonanceCache = new Map();

export async function scoreVideoForVirality(video, niche, options = {}) {
    const scores = {
        engagementVelocity: 0,
        emotionalResonance: 0,
        retentionPotential: 0,
        noveltyScore: 0,
        patternInterruptStrength: 0,
        platformOptimization: 0,
        competitiveSaturation: 0,
        overall: 0,
        breakdown: {},
        reasoning: [],
        _usage: { tokens: 0 },
    };

    try {
        // 1. Engagement Velocity
        const now = Date.now();
        const ageHours = video.pubDate ? (now - video.pubDate) / (1000 * 60 * 60) : 24;
        const viewsPerHour = video.views / Math.max(1, ageHours);
        const likesPerHour = video.likes / Math.max(1, ageHours);
        
        scores.engagementVelocity = Math.min(10, (viewsPerHour / 1000) * 10);
        scores.breakdown.engagementVelocity = scores.engagementVelocity;
        if (scores.engagementVelocity > 7) {
            scores.reasoning.push(`🔥 High engagement velocity: ${Math.round(viewsPerHour)} views/hour`);
        }

        // 2. Emotional Resonance (LLM analysis with caching)
        try {
            const cacheKey = `${video.title}|${(video.description || video.selftext || "").slice(0, 200)}`;
            let emotionalAnalysis;
            
            if (emotionalResonanceCache.has(cacheKey)) {
                emotionalAnalysis = emotionalResonanceCache.get(cacheKey);
            } else {
                emotionalAnalysis = await analyzeEmotionalResonance(
                    video.title, 
                    video.description || video.selftext || ""
                );
                emotionalResonanceCache.set(cacheKey, emotionalAnalysis);
                if (emotionalResonanceCache.size > 100) {
                    const firstKey = emotionalResonanceCache.keys().next().value;
                    emotionalResonanceCache.delete(firstKey);
                }
            }
            
            scores.emotionalResonance = emotionalAnalysis.score;
            scores.breakdown.emotionalResonance = emotionalAnalysis.score;
            if (emotionalAnalysis.triggerWords.length) {
                scores.reasoning.push(`💥 Emotional triggers: ${emotionalAnalysis.triggerWords.join(", ")}`);
            }
            scores._usage.tokens += emotionalAnalysis._usage?.tokens || 0;
        } catch (e) {
            scores.emotionalResonance = 5;
        }

        // 3. Retention Potential
        scores.retentionPotential = calculateRetentionPotential(video.title);
        scores.breakdown.retentionPotential = scores.retentionPotential;
        if (scores.retentionPotential > 7) {
            scores.reasoning.push(`🎯 Strong hook potential: ${Math.round(scores.retentionPotential * 10)}%`);
        }

        // 4. Novelty Score
        scores.noveltyScore = await calculateNoveltyScore(video.title, niche);
        scores.breakdown.noveltyScore = scores.noveltyScore;
        if (scores.noveltyScore < 3) {
            scores.reasoning.push(`⚠️ Low novelty: topic already covered in this niche`);
        }

        // 5. Pattern Interrupt Strength
        scores.patternInterruptStrength = calculatePatternInterrupt(video.title);
        scores.breakdown.patternInterruptStrength = scores.patternInterruptStrength;
        if (scores.patternInterruptStrength > 7) {
            scores.reasoning.push(`⚡ Strong pattern interrupt: "${video.title.slice(0, 40)}..."`);
        }

        // 6. Platform Optimization
        scores.platformOptimization = calculatePlatformOptimization(video);
        scores.breakdown.platformOptimization = scores.platformOptimization;

        // 7. Competitive Saturation (capped at 3 keywords)
        scores.competitiveSaturation = await analyzeCompetitiveSaturation(video.title, niche);
        scores.breakdown.competitiveSaturation = scores.competitiveSaturation;

        // Weighted overall score
        const weights = {
            engagementVelocity: 0.25,
            emotionalResonance: 0.20,
            retentionPotential: 0.20,
            noveltyScore: 0.15,
            patternInterruptStrength: 0.10,
            platformOptimization: 0.05,
            competitiveSaturation: 0.05,
        };

        scores.overall = Object.keys(weights).reduce((total, key) => {
            return total + (scores[key] || 0) * weights[key];
        }, 0);

        scores.overall = Math.min(10, Math.max(1, scores.overall));

        return scores;
    } catch (error) {
        console.error("[viralScoring] Error:", error.message);
        return {
            ...scores,
            overall: 5,
            reasoning: ["⚠️ Fallback scoring due to error", error.message],
        };
    }
}

async function analyzeEmotionalResonance(title, description) {
    const text = `${title}\n${description}`.slice(0, 2000);
    
    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
            {
                role: "system",
                content: `Analyze this content for emotional resonance and viral potential.
                Score 1-10 on: emotional impact, shareability, and ability to trigger strong reactions.
                Return JSON: {"score": number, "triggerWords": string[], "dominantEmotion": string}`
            },
            {
                role: "user",
                content: text,
            },
        ],
    });

    try {
        const result = JSON.parse(response.choices[0].message.content);
        return {
            score: Math.min(10, Math.max(1, result.score || 5)),
            triggerWords: result.triggerWords || [],
            dominantEmotion: result.dominantEmotion || "neutral",
            _usage: { tokens: response.usage?.total_tokens || 0 },
        };
    } catch {
        return { score: 5, triggerWords: [], dominantEmotion: "neutral", _usage: { tokens: 0 } };
    }
}

function calculateRetentionPotential(title) {
    const hookIndicators = [
        /\b(how to|why|what if|the truth about|i tried|this is why|the reason|secret|hidden)\b/i,
        /\b(\d+ (ways|reasons|tricks|hacks|facts|signs|secrets))\b/i,
        /\b(never|always|must|shouldn't|actually|finally|just)\b/i,
        /\b(insane|crazy|unbelievable|shocking|game-changing|mind-blowing)\b/i,
        /\?/
    ];

    let score = 3;
    let matched = 0;

    for (const pattern of hookIndicators) {
        if (pattern.test(title)) {
            matched++;
            score += 1.5;
        }
    }

    if (/\d+/.test(title)) score += 1.0;
    if (/\b(now|today|immediately|breaking|just in)\b/i.test(title)) score += 0.5;

    return Math.min(10, score);
}

async function calculateNoveltyScore(title, niche) {
    const topicKey = title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).slice(0, 5).join(" ");
    
    const { data: recentVideos, error } = await supabase
        .from("pipeline_logs")
        .select("title")
        .eq("niche", niche)
        .eq("status", "Scheduled")
        .gte("created_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
        .limit(20);

    if (error || !recentVideos?.length) return 10;

    let overlap = 0;
    for (const video of recentVideos) {
        const videoKey = (video.title || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).slice(0, 5).join(" ");
        const words1 = new Set(topicKey.split(" "));
        const words2 = new Set(videoKey.split(" "));
        const intersection = new Set([...words1].filter(x => words2.has(x)));
        if (intersection.size > 1) overlap++;
    }

    return Math.max(1, 10 - (overlap * 3));
}

function calculatePatternInterrupt(title) {
    let score = 3;
    
    if (/^(why|how|what|when|where|who|is|are|do|does|did|can|could|would|should|will|if)/i.test(title)) {
        score += 2;
    }
    
    if (/but|however|actually|the truth|the real/i.test(title)) {
        score += 2;
    }
    
    if (/insane|crazy|unbelievable|shocking|finally|just happened|breaking/i.test(title)) {
        score += 2;
    }

    if (/you|your|we|our|i|my/i.test(title)) {
        score += 1;
    }

    return Math.min(10, score);
}

async function analyzeCompetitiveSaturation(title, niche) {
    const keywords = title.toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, 3);
    if (keywords.length === 0) return 5;

    let matchCount = 0;
    for (const keyword of keywords) {
        const { count, error } = await supabase
            .from("pipeline_logs")
            .select("id", { count: "exact", head: true })
            .eq("niche", niche)
            .ilike("title", `%${keyword}%`);
        
        if (!error && count) {
            matchCount += count;
        }
    }

    return Math.max(1, 10 - Math.min(10, matchCount));
}

function calculatePlatformOptimization(video) {
    let score = 5;
    
    if (video.duration && video.duration < 60) score += 2;
    else if (video.duration && video.duration < 180) score += 1;
    
    if (video.platform === "tiktok" || video.platform === "youtube" || video.platform === "instagram") {
        score += 1;
    }

    return Math.min(10, score);
}

export function quickVideoFilter(video, minDuration = 5, maxDuration = 180) {
    if (typeof video.duration !== "number" || Number.isNaN(video.duration)) {
        return { passed: false, reason: "No duration data available (metadata fetch skipped or failed)" };
    }
    if (video.duration < minDuration || video.duration > maxDuration) {
        return { passed: false, reason: `Duration ${video.duration}s outside acceptable range` };
    }

    if (video.views && video.views < 100) {
        return { passed: false, reason: "Too few views for viral potential" };
    }

    if (!video.title || video.title.length < 5) {
        return { passed: false, reason: "Title too short or missing" };
    }

    return { passed: true };
}