import { createClient } from "@supabase/supabase-js";
import { EventEmitter } from "node:events";
import { config } from "./config.js";

export const supabase = createClient(
  config.supabase.url || "http://localhost",
  config.supabase.serviceRoleKey || "anon",
  { auth: { persistSession: false } }
);

/**
 * In-memory event bus. Everything the agents do is emitted here and
 * simultaneously persisted to pipeline_logs — the dashboard's Live Status
 * Stream subscribes to this via SSE.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

const recentEvents = [];
export function getRecentEvents() {
  return recentEvents;
}

export async function logEvent(agent, message, meta = {}) {
  const event = {
    ts: new Date().toISOString(),
    agent,
    message,
    ...meta,
  };
  recentEvents.push(event);
  if (recentEvents.length > 300) recentEvents.shift();
  bus.emit("event", event);
  console.log(`[${agent}] ${message}`);
}

/** Update the pipeline_logs row for the current job. */
export async function updateJob(jobId, patch) {
  const { error } = await supabase
    .from("pipeline_logs")
    .update(patch)
    .eq("id", jobId);
  if (error) console.error("[supabase] updateJob failed:", error.message);
  bus.emit("job", { jobId, ...patch });
}
