/**
 * LLM ROUTER — Gemini-only. Every text and vision call routes through
 * Google's free-tier Gemini models. No OpenAI dependency.
 *
 *   1. Gemini "gemini-flash-latest" (free) — strongest, intermittently throttled.
 *   2. Gemini "gemini-flash-lite-latest" (free) — reliably available.
 *
 * TIER POLICY (keep it this way — it is the token/cost/reliability contract):
 *   smart  → CREATIVE GENERATION ONLY: writeScript, clipPlanning.
 *   fast   → everything else. Classification, scoring, ranking, trimming,
 *            copy for known formats, transcription/alignment. The quality
 *            rubric in contentQuality.js was CALIBRATED on flash-lite —
 *            grading on a different model silently shifts the pass line.
 *
 * PROMPT-CACHING MODEL (Gemini implicit caching): cache keys off a stable
 * request PREFIX. Every call here puts the system message first and system
 * strings are module-level constants — never interpolate per-run data into
 * a system prompt (inject dynamic context as the user message instead), or
 * every call re-bills the full prefix.
 *
 * Each model is retried across every configured key (GEMINI_API_KEY plus
 * optional GEMINI_API_KEY_2/_3) before falling back to the next model, so
 * one key's free-tier quota running out mid-run doesn't fail the whole
 * topic — it just rotates to the next key's separate quota.
 */
import { config } from "../config.js";

const GEMINI_MODELS = { smart: "gemini-flash-latest", fast: "gemini-flash-lite-latest" };

function apiKeys() {
  return [config.geminiKey, config.geminiKey2, config.geminiKey3].filter(Boolean);
}

function toGeminiPayload(messages, temperature) {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => ({ text: m.content }));
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  return {
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
    contents: contents.length ? contents : [{ role: "user", parts: [{ text: "" }] }],
    generationConfig: { responseMimeType: "application/json", temperature: temperature ?? 0.7 },
  };
}

async function geminiJson(model, apiKey, messages, temperature) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toGeminiPayload(messages, temperature)),
    signal: AbortSignal.timeout(90000),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Gemini ${model}: ${json.error.message?.slice(0, 160)}`);
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text.trim()) throw new Error(`Gemini ${model}: empty response`);
  // responseMimeType:"application/json" is a strong hint, not a guarantee —
  // large multi-item schemas with free-text fields occasionally come back
  // truncated (hit the model's output cap) or with an unescaped character
  // breaking the structure. Validating here means a bad response triggers
  // the SAME fallback-model retry as a network/quota error, instead of every
  // individual call site having to catch its own JSON.parse exception.
  const finishReason = json.candidates?.[0]?.finishReason;
  try {
    JSON.parse(text);
  } catch {
    throw new Error(`Gemini ${model}: invalid JSON in response${finishReason === "MAX_TOKENS" ? " (truncated: hit output token limit)" : ""}`);
  }
  return { content: text, tokens: json.usageMetadata?.totalTokenCount || 0, provider: `gemini/${model}` };
}

/**
 * Vision call: one prompt + one or more images (as {mimeType, base64} or
 * URLs, which get fetched). Gemini only. Returns plain text.
 */
export async function llmVision({ prompt, images, label = "vision", maxTokens = 300 }) {
  if (!config.geminiKey) throw new Error(`[${label}] GEMINI_API_KEY not set`);
  const resolved = [];
  for (const img of images) {
    if (typeof img === "string") {
      const res = await fetch(img, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
      resolved.push({ mimeType, base64: Buffer.from(await res.arrayBuffer()).toString("base64") });
    } else {
      resolved.push(img);
    }
  }
  if (!resolved.length) throw new Error("no fetchable images");
  const keys = apiKeys();
  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODELS.fast}:generateContent?key=${keys[i]}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, ...resolved.map((im) => ({ inlineData: { mimeType: im.mimeType, data: im.base64 } }))] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
        }),
        signal: AbortSignal.timeout(60000),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message?.slice(0, 160));
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
      if (!text.trim()) throw new Error("empty vision response");
      return { content: text, tokens: json.usageMetadata?.totalTokenCount || 0, provider: `gemini/${GEMINI_MODELS.fast}` };
    } catch (err) {
      lastErr = err;
      console.warn(`[${label}] key ${i + 1}/${keys.length}: ${err.message} — trying next`);
    }
  }
  throw new Error(`[${label}] ${lastErr?.message || "all keys failed"}`);
}

/**
 * JSON chat completion. Returns { content, tokens, provider } where
 * content is a JSON string.
 */
export async function llmJson({ messages, temperature = 0.7, tier = "smart", label = "llm" }) {
  if (!config.geminiKey) throw new Error(`[${label}] GEMINI_API_KEY not set`);
  const keys = apiKeys();
  // Dedupe: for tier "fast" both entries are gemini-flash-lite-latest, and
  // the old list retried the SAME throttled model on every key before giving
  // up — doubling latency on the most-used path (every classify/scoring call).
  const models = [...new Set([GEMINI_MODELS[tier], GEMINI_MODELS.fast])];
  for (const model of models) {
    for (let i = 0; i < keys.length; i++) {
      try {
        return await geminiJson(model, keys[i], messages, temperature);
      } catch (err) {
        console.warn(`[${label}] ${model} (key ${i + 1}/${keys.length}): ${err.message} — trying next`);
      }
    }
  }
  throw new Error(`[${label}] All Gemini models/keys failed`);
}

/**
 * Audio transcription with per-word timestamps — ONE shared implementation
 * for agent3's caption alignment and agent6's clipper transcript. Was
 * duplicated as two hand-rolled fetches that both bypassed backup-key
 * rotation (a throttled primary key killed alignment/transcription even when
 * GEMINI_API_KEY_2/_3 were configured) with near-identical prompts drifting
 * apart. Rotates every configured key on flash-lite before failing.
 * Returns [{word, start, end}] with start/end in seconds.
 */
export async function transcribeAudioWords(audioBuffer, { scriptHint = "", label = "transcribe" } = {}) {
  const keys = apiKeys();
  if (!keys.length) throw new Error(`[${label}] GEMINI_API_KEY not set`);
  const prompt = `Transcribe this audio with per-word timestamps. Return JSON only: {"words":[{"word":"...","start":0.0,"end":0.4},...]} with start/end in seconds, covering every spoken word in order.${scriptHint ? ` For reference, the intended script was: ${scriptHint.slice(0, 500)}` : ""}`;
  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODELS.fast}:generateContent?key=${keys[i]}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inlineData: { mimeType: "audio/mp3", data: audioBuffer.toString("base64") } },
          ] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
        signal: AbortSignal.timeout(120000),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message?.slice(0, 120));
      const parsed = JSON.parse(json.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
      return (parsed.words || [])
        .map((w) => ({ word: String(w.word || "").trim(), start: Number(w.start), end: Number(w.end) }))
        .filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
    } catch (err) {
      lastErr = err;
      console.warn(`[${label}] key ${i + 1}/${keys.length}: ${err.message} — trying next`);
    }
  }
  throw new Error(`[${label}] ${lastErr?.message || "all keys failed"}`);
}
