/**
 * AUDIO PEAK DETECTION — for source video that has little or no spoken
 * dialogue (gameplay footage, sports clips, reaction compilations). There's
 * no transcript to find a "hook" in, so Agent 6 falls back to this: extract
 * a mono low-rate PCM track with ffmpeg, compute short-window RMS loudness,
 * and treat sustained loud moments (kill sounds, crowd reactions, explosion
 * SFX, a streamer's reaction) as highlight-worthy — the same signal real
 * highlight-detection tools use as a proxy for "something exciting just
 * happened" when no other event data is available.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);

const SAMPLE_RATE = 4000; // low rate is plenty for envelope/loudness detection, keeps the buffer tiny
const WINDOW_SECONDS = 0.5;

/**
 * Returns { start, end } highlight windows ranked by peak loudness, each
 * expanded around its peak with a short pre-roll (so the setup is visible,
 * not just the payoff) and a longer post-roll (the reaction/aftermath).
 */
export async function detectAudioPeaks(videoBuffer, { maxClips = 8, preRoll = 4, postRoll = 10, minGapSeconds = 15 } = {}) {
  const tmpIn = path.join(tmpdir(), `horizon-clip-src-${randomUUID()}.mp4`);
  await writeFile(tmpIn, videoBuffer);

  let pcm;
  try {
    const { stdout } = await execFileAsync(
      ffmpegPath,
      ["-i", tmpIn, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"],
      { encoding: "buffer", maxBuffer: 200 * 1024 * 1024 }
    );
    pcm = stdout;
  } finally {
    await unlink(tmpIn).catch(() => {});
  }

  if (!pcm || pcm.length < SAMPLE_RATE * 2) return { peaks: [], duration: 0 };

  const samplesPerWindow = Math.floor(SAMPLE_RATE * WINDOW_SECONDS);
  const totalSamples = Math.floor(pcm.length / 2);
  const totalWindows = Math.floor(totalSamples / samplesPerWindow);
  const rms = new Float64Array(totalWindows);

  for (let w = 0; w < totalWindows; w++) {
    let sumSquares = 0;
    const base = w * samplesPerWindow;
    for (let i = 0; i < samplesPerWindow; i++) {
      const sample = pcm.readInt16LE((base + i) * 2);
      sumSquares += sample * sample;
    }
    rms[w] = Math.sqrt(sumSquares / samplesPerWindow);
  }

  const mean = rms.reduce((a, b) => a + b, 0) / (rms.length || 1);
  const variance = rms.reduce((a, b) => a + (b - mean) ** 2, 0) / (rms.length || 1);
  const stddev = Math.sqrt(variance);
  const threshold = mean + 1.5 * stddev;

  // Local-maxima peak picking above threshold, then greedily keep the
  // loudest peaks that are at least minGapSeconds apart so highlight
  // windows don't overlap or cluster on one long loud stretch.
  const candidates = [];
  for (let w = 1; w < totalWindows - 1; w++) {
    if (rms[w] > threshold && rms[w] >= rms[w - 1] && rms[w] >= rms[w + 1]) {
      candidates.push({ time: w * WINDOW_SECONDS, intensity: rms[w] });
    }
  }
  candidates.sort((a, b) => b.intensity - a.intensity);

  const duration = totalWindows * WINDOW_SECONDS;
  const chosen = [];
  for (const c of candidates) {
    if (chosen.length >= maxClips) break;
    if (chosen.some((p) => Math.abs(p.time - c.time) < minGapSeconds)) continue;
    chosen.push(c);
  }
  chosen.sort((a, b) => a.time - b.time);

  const peaks = chosen.map((c) => ({
    peakTime: c.time,
    start: Math.max(0, c.time - preRoll),
    end: Math.min(duration, c.time + postRoll),
    intensity: Number((c.intensity / (mean || 1)).toFixed(2)), // relative loudness vs. the video's baseline
  }));

  return { peaks, duration };
}
