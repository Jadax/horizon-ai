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
 * retained in process for the dashboard's Live Status Stream via SSE.
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

/** Update the pipeline_logs row for the current job.
 * Returns the update result so callers can detect failures. */
export async function updateJob(jobId, patch) {
  const { data, error } = await supabase
    .from("pipeline_logs")
    .update(patch)
    .eq("id", jobId)
    .select();
  if (error) {
    console.error("[supabase] updateJob failed:", error.message);
    return { error, data: null };
  }
  bus.emit("job", { jobId, ...patch });
  return { error: null, data };
}
