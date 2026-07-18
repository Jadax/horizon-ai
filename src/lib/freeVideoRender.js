import axios from 'axios';
import { config } from '../config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ffmpeg from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const RENDER_API_URL = config.renderApiUrl || 'http://localhost:3000';
const ENGINE = config.renderEngine || 'render-api';

function toAssTimestamp(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

/** One `ass=file` filter carries every caption, instead of chaining one
 * drawtext filter per caption — see the call site for why. `{` and `}` are
 * ASS override-tag delimiters (e.g. `{\b1}` for bold); stripped from
 * caption text since spoken narration/word-clip text never legitimately
 * needs them and leaving them in would either silently vanish or, worse,
 * accidentally form a real override tag. */
function buildAssSubtitles(captions) {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginV',
    'Style: Default,Arial,64,&H00FFFFFF,&H00000000,&H00000000,1,1,3,1,2,140',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Text',
  ].join('\n');
  const lines = captions.map((cap) => {
    const text = String(cap.text || '').replace(/[{}]/g, '').replace(/\n/g, ' ');
    return `Dialogue: 0,${toAssTimestamp(cap.start)},${toAssTimestamp(cap.end)},Default,${text}`;
  });
  return header + '\n' + lines.join('\n') + '\n';
}

export async function renderVideo(payload, jobId) {
  switch (ENGINE) {
    case 'render-api':
      return await renderWithAPI(payload, jobId);
    case 'shottower':
      return await renderWithShottower(payload, jobId);
    default:
      return await renderWithFFmpeg(payload, jobId);
  }
}

async function renderWithAPI(payload, jobId) {
  try {
    // juppfy/render-video-api's actual contract (per its README — this repo's
    // integration was never verified against it end-to-end, so treat this as
    // a best-effort mapping from its one documented example, not a confirmed
    // working payload): POST /v1/render, header x-api-key, and a
    // {backgrounds:[{type,src,fit}], audios:[{src}], output:{quality}} shape —
    // not the /api/render + {backgrounds,audio,duration,output:{format,...}}
    // shape this previously sent, which would 404 even with a valid API key.
    if (!config.renderApiKey) {
      throw new Error('RENDER_API_KEY is not configured — render-video-api requires registering and generating one through its own dashboard, see .env.example');
    }
    const backgroundUrl = payload.backgroundVideo || payload.backgrounds?.[0]?.url;
    const apiPayload = {
      canvas: { fps: 30 },
      backgrounds: backgroundUrl ? [{ type: 'video', src: backgroundUrl, fit: 'cover' }] : [],
      audios: payload.audioUrl ? [{ src: payload.audioUrl }] : [],
      output: { quality: '1080p' },
    };
    const response = await axios.post(`${RENDER_API_URL}/v1/render`, apiPayload, {
      headers: { 'x-api-key': config.renderApiKey },
      timeout: 300000,
    });
    return {
      renderId: response.data.id,
      url: response.data.url,
      status: 'done',
    };
  } catch (error) {
    console.error('[Render API] Error:', error.message);
    return await renderWithFFmpeg(payload, jobId);
  }
}

async function renderWithShottower(payload, jobId) {
  try {
    const backgrounds = payload.backgrounds || (payload.backgroundVideo ? [{ url: payload.backgroundVideo, duration: payload.duration }] : []);
    const shottowerPayload = {
      timeline: {
        background: '#000000',
        tracks: [
          {
            clips: backgrounds.map(b => ({
              asset: { type: 'video', src: b.url },
              start: 0,
              length: b.duration || 5,
            }))
          },
          {
            clips: payload.captions?.map(c => ({
              asset: { type: 'text', text: c.text },
              start: c.start,
              length: c.end - c.start,
            })) || []
          }
        ]
      },
      output: {
        format: 'mp4',
        resolution: 'hd',
        aspectRatio: '9:16',
        fps: 30,
      }
    };
    const response = await axios.post(`${RENDER_API_URL}/v1/render`, shottowerPayload, {
      timeout: 300000,
    });
    return {
      renderId: response.data.response.id,
      url: response.data.response.url,
      status: 'done',
    };
  } catch (error) {
    console.error('[shottower] Error:', error.message);
    return await renderWithFFmpeg(payload, jobId);
  }
}

async function renderWithFFmpeg(payload, jobId) {
  const tmpDir = tmpdir();
  const outputFile = path.join(tmpDir, `horizon-${randomUUID()}.mp4`);
  const audioFile = path.join(tmpDir, `horizon-audio-${randomUUID()}.mp3`);
  const totalDuration = payload.duration || 60;

  // Stitches the FULL cut sequence (video and/or still-image clips) into
  // one video via ffmpeg's concat filter, instead of only ever using the
  // first background clip — buildEditPayload() now passes the whole
  // sequence as backgroundClips; fall back to a single clip or solid color
  // for callers/payloads that don't have it.
  let clips = Array.isArray(payload.backgroundClips) && payload.backgroundClips.length
    ? payload.backgroundClips
    : payload.backgroundVideo
    ? [{ url: payload.backgroundVideo, type: 'video', duration: totalDuration }]
    : [];
  if (!clips.length) {
    clips = [{ url: null, type: 'color', duration: totalDuration }];
  }
  let assFile = null;

  try {
    if (payload.audioUrl) {
      const audioRes = await fetch(payload.audioUrl);
      const audioBuffer = await audioRes.arrayBuffer();
      await writeFile(audioFile, Buffer.from(audioBuffer));
    }

    // Built as an argv array and run via execFile (no shell) instead of a
    // shell command string — captions are AI-generated, ultimately sourced
    // from RSS/Reddit topic content, so interpolating them into a shell
    // string (the previous approach) risked shell metacharacter injection.
    const args = ['-y'];
    for (const clip of clips) {
      const clipDuration = Math.max(0.5, clip.duration || 4);
      if (clip.type === 'image') {
        args.push('-loop', '1', '-t', String(clipDuration), '-i', clip.url);
      } else if (clip.type === 'color' || !clip.url) {
        args.push('-f', 'lavfi', '-i', `color=c=black:s=1080x1920:d=${clipDuration}`);
      } else {
        // Input-level -ss/-t trims before decoding (fast, and avoids
        // downloading/decoding the whole remote file for a short cut).
        args.push('-ss', String(clip.start || 0), '-t', String(clipDuration), '-i', clip.url);
      }
    }
    const audioInputIndex = clips.length;
    if (payload.audioUrl) {
      args.push('-i', audioFile);
    }

    // Normalize every background input to the same size/fps/timebase
    // before concatenating — concat requires matching stream properties,
    // and inputs here can be a mix of stock video and generated stills.
    const legs = clips.map((_, i) =>
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,setpts=PTS-STARTPTS[v${i}]`
    );
    const concatInputs = clips.map((_, i) => `[v${i}]`).join('');
    let filterComplex = [...legs, `${concatInputs}concat=n=${clips.length}:v=1:a=0[vcat]`].join(';');

    // Chaining one drawtext filter per caption (textfile= per caption, as a
    // previous fix attempted) works for a handful of captions but breaks on
    // real word-clip-mode scripts, which can chain 80-90+ drawtext stages
    // in one filter_complex — reproduced this exact "No such filter:
    // 'drawtext'" failure locally at that scale even with zero text-
    // escaping issues (textfile= already eliminates those), so the chain
    // length/count itself is what ffmpeg's parser (at least the 7.0.2
    // static build Railway runs) chokes on, not the text content.
    // Switched to ONE `ass` subtitle filter carrying every caption's timing
    // — this is what libass (already compiled into this build) exists for,
    // scales to any caption count, and was verified against a real
    // rendered frame with apostrophes/colons/commas in the text.
    if (payload.captions && payload.captions.length) {
      assFile = path.join(tmpDir, `horizon-captions-${randomUUID()}.ass`);
      await writeFile(assFile, buildAssSubtitles(payload.captions));
      const assPath = assFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, '’');
      filterComplex += `;[vcat]ass='${assPath}'[vout]`;
    } else {
      filterComplex += ';[vcat]null[vout]';
    }
    args.push('-filter_complex', filterComplex);

    args.push('-map', '[vout]');
    if (payload.audioUrl) {
      args.push('-map', `${audioInputIndex}:a`);
    }
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-t', String(totalDuration), '-pix_fmt', 'yuv420p', outputFile);

    await execFileAsync(ffmpeg, args, { timeout: 300000 });

    const video = await import('node:fs/promises').then(fs => fs.readFile(outputFile));
    await unlink(outputFile).catch(() => {});
    if (payload.audioUrl) {
      await unlink(audioFile).catch(() => {});
    }
    if (assFile) await unlink(assFile).catch(() => {});

    const url = `data:video/mp4;base64,${video.toString('base64')}`;
    return {
      renderId: `ffmpeg-${randomUUID()}`,
      url: url,
      status: 'done',
    };
  } catch (error) {
    console.error('[FFmpeg] Error:', error.message);
    await unlink(outputFile).catch(() => {});
    if (payload.audioUrl) {
      await unlink(audioFile).catch(() => {});
    }
    if (assFile) await unlink(assFile).catch(() => {});
    throw error;
  }
}

export async function checkRenderEngine() {
  // Only 'render-api'/'shottower' are external services worth an HTTP health
  // check — the default 'ffmpeg' engine runs in-process via the bundled
  // ffmpeg-static binary, so "is it healthy" means "does the binary run",
  // not "does something answer on renderApiUrl" (nothing ever does, by
  // design, and this previously reported the working default as "Down").
  if (ENGINE === 'render-api' || ENGINE === 'shottower') {
    try {
      const response = await axios.get(`${RENDER_API_URL}/health`, { timeout: 5000 });
      return response.status === 200;
    } catch {
      return false;
    }
  }
  try {
    await execFileAsync(ffmpeg, ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}