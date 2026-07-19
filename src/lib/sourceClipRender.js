import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpeg from "ffmpeg-static";
import { supabase } from "../supabase.js";

const execFileAsync = promisify(execFile);

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

function captionCues(words, maxWords = 3) {
  const cues = [];
  for (let i = 0; i < words.length; i += maxWords) {
    const chunk = words.slice(i, i + maxWords);
    if (!chunk.length) continue;
    cues.push({ start: chunk[0].start, end: chunk.at(-1).end, text: chunk.map((word) => word.word).join(" ").toUpperCase() });
  }
  return cues;
}

function buildSrt(cues) {
  return cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join("\n");
}

function escapeDrawtext(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "’").replace(/%/g, "\\%");
}

async function uploadArtifact(storagePath, body, contentType) {
  const { error } = await supabase.storage.from("renders").upload(storagePath, body, { contentType, upsert: true });
  if (error) throw new Error(`Clip artifact upload failed: ${error.message}`);
  return supabase.storage.from("renders").getPublicUrl(storagePath).data.publicUrl;
}

export async function renderSourceClip({ sourceBuffer, clip, words = [], clipJobId, index }) {
  const id = randomUUID();
  const input = path.join(tmpdir(), `horizon-source-${id}.mp4`);
  const output = path.join(tmpdir(), `horizon-clip-${id}.mp4`);
  const subtitleFile = path.join(tmpdir(), `horizon-clip-${id}.srt`);
  const relativeWords = words
    .filter((word) => word.end > clip.start && word.start < clip.end)
    .map((word) => ({ word: word.word, start: Math.max(0, word.start - clip.start), end: Math.min(clip.end - clip.start, word.end - clip.start) }))
    .filter((word) => word.end > word.start);
  const srt = buildSrt(captionCues(relativeWords));
  const duration = Number((clip.end - clip.start).toFixed(3));

  try {
    await writeFile(input, sourceBuffer);
    await writeFile(subtitleFile, srt, "utf8");
    let videoFilter = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30";
    if (clip.mode === "action") {
      const effectStart = Math.max(0, Number(clip.peakOffset || 0) - 0.2);
      const effectEnd = Math.min(duration, effectStart + 1.2);
      videoFilter += `,scale=w='if(between(t,${effectStart},${effectEnd}),1188,1080)':h='if(between(t,${effectStart},${effectEnd}),2112,1920)':eval=frame,crop=1080:1920,drawtext=text='${escapeDrawtext(clip.title)}':fontcolor=white:fontsize=86:borderw=6:bordercolor=black:x=(w-text_w)/2:y=h*0.18:enable='between(t,${effectStart},${effectEnd})'`;
    }
    if (relativeWords.length) {
      const subtitlePath = subtitleFile.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "’");
      videoFilter += `,subtitles='${subtitlePath}':force_style='FontSize=20,PrimaryColour=&H00FFFFFF,Outline=3,Alignment=2,MarginV=140'`;
    }
    await execFileAsync(ffmpeg, [
      "-y", "-ss", String(clip.start), "-t", String(duration), "-i", input,
      "-vf", videoFilter, "-map", "0:v:0", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-c:a", "aac", "-b:a", "160k",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", output,
    ], { timeout: 300000 });
    await execFileAsync(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"], { timeout: 300000 });
    const video = await readFile(output);
    if (video.length < 10_000) throw new Error("Rendered clip is unexpectedly small");
    const basePath = `clips/${clipJobId}/${index + 1}`;
    const [videoUrl, subtitleUrl] = await Promise.all([
      uploadArtifact(`${basePath}.mp4`, video, "video/mp4"),
      uploadArtifact(`${basePath}.srt`, Buffer.from(srt, "utf8"), "application/x-subrip"),
    ]);
    return { videoUrl, subtitleUrl, durationSec: Math.round(duration), resolution: "1080x1920", syncPrecisionMs: 50 };
  } finally {
    await unlink(input).catch(() => {});
    await unlink(output).catch(() => {});
    await unlink(subtitleFile).catch(() => {});
  }
}
