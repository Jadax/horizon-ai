import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { execFileAsync, buildSrt, uploadRenderArtifact } from "./utils.js";

const execFileCb = promisify(execFile);

/**
 * HDR→SDR tone-map chain for phone footage (stolen from browser-use/video-use
 * render.py:108-131). Phone-shot source clips (Leo inbox videos are mostly
 * iPhone/Android) frequently carry PQ/HLG metadata; without this chain the
 * 8-bit render comes out washed out. zscale availability is not guaranteed on
 * every static build, so the caller retries without it on failure.
 */
const TONEMAP_CHAIN =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

function parseProbe(stderr) {
  const info = { duration: 0, hasAudio: false, hasVideo: false, transfer: "", space: "" };
  const dur = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
  if (dur) info.duration = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  info.hasVideo = /Stream #\d+:\d+.*: Video:/.test(stderr);
  info.hasAudio = /Stream #\d+:\d+.*: Audio:/.test(stderr);
  const t = /color_transfer=(\S+)/.exec(stderr);
  const s = /color_space=(\S+)/.exec(stderr);
  info.transfer = t?.[1] || "";
  info.space = s?.[1] || "";
  return info;
}

async function probeInput(file) {
  try {
    const { stderr } = await execFileCb(ffmpeg, ["-i", file], { timeout: 20000 });
    return parseProbe(stderr);
  } catch (err) {
    // ffmpeg -i without output exits non-zero but prints metadata to stderr
    return parseProbe(err.stderr || "");
  }
}

function isHdrSource(info) {
  return /(smpte2084|pq|bt2020|hlg|arib-std-b67)/i.test(`${info.transfer} ${info.space}`);
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

function escapeDrawtext(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "’").replace(/%/g, "\\%");
}

async function uploadArtifact(storagePath, body, contentType) {
  return uploadRenderArtifact(storagePath, body, contentType);
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
    const probe = await probeInput(input);
    const hdr = isHdrSource(probe);
    const baseFilter = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30";
    const buildArgs = (videoFilter) => {
      const args = [
        "-y", "-ss", String(clip.start), "-t", String(duration), "-i", input,
        "-vf", videoFilter, "-map", "0:v:0",
      ];
      if (probe.hasAudio) {
        // 30ms fades at each boundary (video-use P0-6): kills pop artifacts
        // that loudnorm tends to amplify at hard cut edges.
        const fadeOut = Math.max(0, duration - 0.03);
        args.push("-af", `afade=t=in:st=0:d=0.03,afade=t=out:st=${fadeOut.toFixed(3)}:d=0.03`);
      } else {
        // Optional first-audio-stream map: silent-video sources must not fail
        // on a missing audio map (browser-use discipline).
        args.push("-map", "0:a?:0");
      }
      args.push("-c:v", "libx264", "-preset", "fast", "-crf", "21", "-c:a", "aac", "-b:a", "160k",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", output);
      return args;
    };
    let filter = baseFilter;
    if (clip.mode === "action") {
      const effectStart = Math.max(0, Number(clip.peakOffset || 0) - 0.2);
      const effectEnd = Math.min(duration, effectStart + 1.2);
      filter += `,scale=w='if(between(t,${effectStart},${effectEnd}),1188,1080)':h='if(between(t,${effectStart},${effectEnd}),2112,1920)':eval=frame,crop=1080:1920,drawtext=text='${escapeDrawtext(clip.title)}':fontcolor=white:fontsize=86:borderw=6:bordercolor=black:x=(w-text_w)/2:y=h*0.18:enable='between(t,${effectStart},${effectEnd})'`;
    }
    if (relativeWords.length) {
      const subtitlePath = subtitleFile.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "’");
      filter += `,subtitles='${subtitlePath}':force_style='FontSize=20,PrimaryColour=&H00FFFFFF,Outline=3,Alignment=2,MarginV=140'`;
    }
    const hdrFilter = hdr ? `${TONEMAP_CHAIN},${filter}` : null;
    try {
      await execFileAsync(ffmpeg, buildArgs(hdrFilter || filter), { timeout: 300000 });
    } catch (renderErr) {
      // zscale may be missing from this ffmpeg build — retry without tonemap
      if (hdrFilter) {
        await execFileAsync(ffmpeg, buildArgs(filter), { timeout: 300000 });
      } else {
        throw renderErr;
      }
    }
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
