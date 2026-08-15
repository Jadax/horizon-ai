/**
 * Agent 7 routes — manual engagement pass trigger + audit ledger for the
 * dashboard's Engage section. Reads are free; replies are gated by
 * AUTO_ENGAGE (env or dashboard OPS toggle).
 */
import { Router } from "express";
import { logEvent } from "../supabase.js";
import { config } from "../config.js";
import { runEngagementPass, recentEngagement } from "../pipeline/agent7_engage.js";

const router = Router();

router.get("/engage", async (_req, res) => {
  try {
    const items = await recentEngagement({ limit: 50 });
    res.json({ items, autoEngage: config.autoEngage, maxPerPass: config.autoEngageMaxRepliesPerPass });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/engage", async (_req, res) => {
  try {
    logEvent("Agent 7", "Manual engagement pass triggered from dashboard");
    const result = await runEngagementPass({ maxRepliesPerChannel: config.autoEngageMaxRepliesPerPass });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as engageRouter };
