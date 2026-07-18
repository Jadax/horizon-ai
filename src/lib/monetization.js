/**
 * MONETIZATION ENGINE — Affiliate matching and revenue tracking
 * 
 * Features:
 * - Auto-detect products relevant to video content
 * - Insert affiliate links in descriptions
 * - Track revenue from real YouTube stats via performanceTracker
 */
import { config } from "../config.js";
import { supabase, logEvent } from "../supabase.js";

// Single source of truth for banned words
export const BANNED_WORDS = [
  "delve", "delving", "testament", "moreover", "furthermore", "tapestry",
  "boasts", "navigate the", "the landscape of", "gaming landscape", "realm",
  "elevate", "unleash", "unlock the", "game-changer", "in today's world",
  "in the world of", "when it comes to", "it's worth noting",
  "it's important to note", "dive into", "dive deep", "underscore",
  "underscores", "bustling", "vibrant", "myriad", "plethora", "robust",
  "seamless", "cutting-edge", "unprecedented",
];

/**
 * Match affiliate products based on keywords
 * Confidence is derived from keyword overlap, not random
 */
export function matchAffiliateProducts(title, description, niche) {
    const keywords = extractKeywords(title, description);
    const products = [];

    // Product categories by niche with confidence weights
    const nicheProductMap = {
        'Gaming/Lore': [
            { name: 'gaming chair', weight: 3 },
            { name: 'gaming headset', weight: 2 },
            { name: 'gaming keyboard', weight: 2 },
            { name: 'game key', weight: 1 },
            { name: 'gaming pc', weight: 1 },
        ],
        'Aesthetic': [
            { name: 'camera', weight: 3 },
            { name: 'phone case', weight: 2 },
            { name: 'art print', weight: 2 },
            { name: 'home decor', weight: 1 },
            { name: 'wall art', weight: 1 },
        ],
        'Psychology': [
            { name: 'book', weight: 3 },
            { name: 'journal', weight: 2 },
            { name: 'meditation app', weight: 2 },
            { name: 'self help', weight: 1 },
        ],
        'Travel': [
            { name: 'travel bag', weight: 3 },
            { name: 'camera', weight: 2 },
            { name: 'drone', weight: 2 },
            { name: 'backpack', weight: 2 },
            { name: 'suitcase', weight: 1 },
        ],
        'Food': [
            { name: 'kitchen knife', weight: 3 },
            { name: 'cookbook', weight: 2 },
            { name: 'air fryer', weight: 2 },
            { name: 'baking pan', weight: 1 },
            { name: 'spice set', weight: 1 },
        ],
        'Finance': [
            { name: 'stock app', weight: 3 },
            { name: 'crypto wallet', weight: 2 },
            { name: 'investment book', weight: 2 },
            { name: 'budget planner', weight: 1 },
        ],
        'Technology': [
            { name: 'smartphone', weight: 3 },
            { name: 'laptop', weight: 2 },
            { name: 'smartwatch', weight: 2 },
            { name: 'headphones', weight: 1 },
            { name: 'usb c cable', weight: 1 },
        ],
        'Viral': [
            { name: 'phone', weight: 3 },
            { name: 'gadget', weight: 2 },
            { name: 'accessory', weight: 1 },
        ],
        'News India': [
            { name: 'news app', weight: 3 },
            { name: 'mobile phone', weight: 2 },
            { name: 'data plan', weight: 1 },
        ],
        'Mindful/Calm': [
            { name: 'yoga mat', weight: 3 },
            { name: 'meditation cushion', weight: 2 },
            { name: 'sleep mask', weight: 2 },
            { name: 'essential oil', weight: 1 },
        ],
    };

    const nicheProducts = nicheProductMap[niche] || [{ name: 'product', weight: 1 }];
    
    for (const product of nicheProducts) {
        // Calculate confidence based on keyword overlap
        let matchCount = 0;
        const productWords = product.name.toLowerCase().split(' ');
        for (const word of productWords) {
            if (keywords.some(k => k.includes(word) || word.includes(k))) {
                matchCount++;
            }
        }
        
        const confidence = Math.min(1, (matchCount / Math.max(1, productWords.length)) * 0.8 + 0.2);
        
        if (confidence > 0.3) {
            products.push({
                name: product.name,
                category: niche,
                confidence: confidence,
                affiliateLink: generateAffiliateLink(product.name),
                weight: product.weight,
            });
        }
    }

    // Sort by confidence * weight, take top 3
    return products
        .sort((a, b) => (b.confidence * b.weight) - (a.confidence * a.weight))
        .slice(0, 3);
}

function extractKeywords(title, description) {
    const text = `${title} ${description}`.toLowerCase();
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'for', 'nor', 'on', 'at', 'to', 'by', 'of', 'with'];
    const words = text.split(/\s+/)
        .filter(w => w.length > 3)
        .filter(w => !stopWords.includes(w));
    return [...new Set(words)].slice(0, 10);
}

function generateAffiliateLink(product) {
    const trackingId = config.affiliate.trackingId;
    if (!trackingId) {
        return `https://www.amazon.com/s?k=${encodeURIComponent(product)}`;
    }
    return `https://www.amazon.com/s?k=${encodeURIComponent(product)}&tag=${trackingId}`;
}

/**
 * Track revenue from a video - called by performanceTracker when real stats arrive
 */
export async function trackRevenue(jobId, platform, revenue, views = 0, clicks = 0, conversions = 0) {
    const { error } = await supabase
        .from('monetization')
        .insert({
            pipeline_log_id: jobId,
            platform,
            revenue,
            views,
            clicks,
            conversions,
            recorded_at: new Date().toISOString(),
        });

    if (error) {
        console.error('[monetization] Failed to track revenue:', error.message);
        return false;
    }

    await logEvent('Monetization', `💰 Tracked ${platform} revenue: $${revenue.toFixed(2)} (${views} views)`, { jobId });
    return true;
}

/**
 * Calculate estimated revenue from video metrics
 */
export function estimateRevenue(views, platform, niche) {
    const rpmMap = {
        'youtube': {
            'Finance': 300,
            'Technology': 200,
            'Business': 180,
            'Health/Wellness': 150,
            'Education': 100,
            'Gaming/Lore': 40,
            'Aesthetic': 50,
            'Psychology': 60,
            'Travel': 70,
            'Food': 80,
            'Viral': 30,
            'News India': 20,
            'Mindful/Calm': 40,
            'default': 40,
        },
        'instagram': { 'default': 50 },
        'facebook': { 'default': 30 },
        'tiktok': { 'default': 20 },
    };

    let rpm = rpmMap[platform]?.default || 20;
    for (const [nicheKey, value] of Object.entries(rpmMap[platform] || {})) {
        if (niche.includes(nicheKey)) {
            rpm = value;
            break;
        }
    }

    return (views / 1000) * rpm;
}

/**
 * Get top-performing affiliate products (uses real affiliate_revenue data)
 */
export async function getTopAffiliateProducts(niche, limit = 10) {
    const { data, error } = await supabase
        .from('pipeline_logs')
        .select('affiliate_products, affiliate_revenue')
        .eq('niche', niche)
        .not('affiliate_products', 'is', null)
        .order('affiliate_revenue', { ascending: false })
        .limit(limit);

    if (error || !data) return [];

    const productPerformance = {};
    for (const row of data) {
        const products = row.affiliate_products || [];
        for (const product of products) {
            const key = product.name || product;
            if (!productPerformance[key]) {
                productPerformance[key] = { revenue: 0, count: 0 };
            }
            productPerformance[key].revenue += row.affiliate_revenue || 0;
            productPerformance[key].count += 1;
        }
    }

    return Object.entries(productPerformance)
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .slice(0, 10)
        .map(([name, data]) => ({ name, ...data }));
}