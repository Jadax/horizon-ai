/**
 * Shared retry wrapper for OpenAI calls that run in a loop (once per
 * keyword, once per video candidate, etc.) — any one of those loops can
 * legitimately exhaust a tokens-per-minute limit under real usage, and
 * without this a single 429 anywhere in the loop killed the entire
 * pipeline run, discarding every keyword/candidate already processed.
 */
export async function withRetry(fn, { maxAttempts = 4, jobId, label = "OpenAI call" } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err?.status !== 429 || attempt === maxAttempts) throw err;
      const retryAfter = Number(err.headers?.get?.("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000 + 250
        : Math.min(30000, 1000 * 2 ** attempt);
      console.warn(`[${label}] Rate limited (attempt ${attempt}/${maxAttempts}) — waiting ${Math.round(waitMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}
