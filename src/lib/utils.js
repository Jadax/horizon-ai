/**
 * SHARED UTILITIES — one source of truth for common operations used
 * across the lib/ and pipeline/ modules. Reduces duplication and ensures
 * consistent behavior throughout the codebase.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { supabase } from "../supabase.js";

/** Promisified ffmpeg exec — use everywhere instead of re-defining. */
export const execFileAsync = promisify(execFile);

/** Normalize a topic title into a canonical dedup/grouping key. */
export function normalizeTopicKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .slice(0, 5)
    .join(" ");
}

/** Convert seconds to SRT timestamp: HH:MM:SS,mmm */
export function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/** Assemble SRT file body from caption array. */
export function buildSrt(captions) {
  return captions
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${String(c.text || "").replace(/\n/g, " ")}\n`)
    .join("\n");
}

/** Upload a buffer/file to Supabase "renders" storage and return public URL. */
export async function uploadRenderArtifact(storagePath, body, contentType) {
  const { error } = await supabase.storage.from("renders").upload(storagePath, body, { contentType, upsert: true });
  if (error) throw new Error(`Render upload failed: ${error.message}`);
  return supabase.storage.from("renders").getPublicUrl(storagePath).data.publicUrl;
}

/** Banned AI-pattern words — import this, don't hardcode a copy. */
export const BANNED_WORDS = [
  "delve", "delving", "testament", "moreover", "furthermore", "tapestry",
  "boasts", "navigate the", "the landscape of", "gaming landscape", "realm",
  "elevate", "unleash", "unlock the", "game-changer", "in today's world",
  "in the world of", "when it comes to", "it's worth noting",
  "it's important to note", "dive into", "dive deep", "underscore",
  "underscores", "bustling", "myriad", "plethora", "cutting-edge",
  "unprecedented", "vibrant", "seamless", "robust", "insane",
];
