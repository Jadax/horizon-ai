/**
 * LLM ROUTER — one JSON-chat entry point for every text-only model call in
 * the pipeline, so provider/cost decisions live here instead of in six
 * agents. Routing (verified live against this project's actual keys):
 *   1. Gemini "gemini-flash-latest" (free tier) — strongest free option,
 *      but intermittently throttled with "high demand".
 *   2. Gemini "gemini-flash-lite-latest" (free tier) — reliably available.
 *   3. OpenAI (gpt-4o for tier "smart", gpt-4o-mini for "fast") — paid
 *      fallback so a Gemini outage never kills a run.
 * Vision calls (image inputs) stay on OpenAI directly — they're cheap and
 * Gemini's inline-image plumbing isn't worth the extra failure surface.
 */
import OpenAI from "openai";
import { config } from "../config.js";
import { withRetry } from "./openaiRetry.js";

const openai = new OpenAI({ apiKey: config.openaiKey });

const GEMINI_MODELS = { smart: "gemini-flash-latest", fast: "gemini-flash-lite-latest" };
const OPENAI_MODELS = { smart: "gpt-4o", fast: "gpt-4o-mini" };

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

async function geminiJson(model, messages, temperature) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiKey}`;
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
  return { content: text, tokens: json.usageMetadata?.totalTokenCount || 0, provider: `gemini/${model}` };
}

/**
 * Vision call: one prompt + one or more images (as {mimeType, base64} or
 * URLs, which get fetched). Gemini free tier first, gpt-4o-mini fallback.
 * Returns plain text.
 */
export async function llmVision({ prompt, images, label = "vision", maxTokens = 300 }) {
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
  if (config.geminiKey) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODELS.fast}:generateContent?key=${config.geminiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, ...resolved.map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.base64 } }))] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
        }),
        signal: AbortSignal.timeout(60000),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message?.slice(0, 120));
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
      if (!text.trim()) throw new Error("empty vision response");
      return { content: text, provider: `gemini/${GEMINI_MODELS.fast}` };
    } catch (err) {
      console.warn(`[${label}] Gemini vision failed (${err.message}) — falling back to OpenAI`);
    }
  }
  const res = await withRetry(
    () => openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: maxTokens,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...resolved.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mimeType};base64,${i.base64}` } })),
        ],
      }],
    }),
    { label }
  );
  return { content: res.choices[0].message.content, provider: "openai/gpt-4o-mini" };
}

/**
 * JSON chat completion. `messages` uses the OpenAI role/content shape;
 * returns { content, tokens, provider } where content is a JSON string.
 */
export async function llmJson({ messages, temperature = 0.7, tier = "smart", label = "llm" }) {
  if (config.geminiKey) {
    for (const model of [GEMINI_MODELS[tier], GEMINI_MODELS.fast]) {
      try {
        return await geminiJson(model, messages, temperature);
      } catch (err) {
        console.warn(`[${label}] ${err.message} — trying next provider`);
      }
    }
  }
  const res = await withRetry(
    () => openai.chat.completions.create({
      model: OPENAI_MODELS[tier] || OPENAI_MODELS.smart,
      temperature,
      response_format: { type: "json_object" },
      messages,
    }),
    { label }
  );
  return {
    content: res.choices[0].message.content,
    tokens: res.usage?.total_tokens || 0,
    provider: `openai/${OPENAI_MODELS[tier]}`,
  };
}
