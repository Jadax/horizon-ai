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
  
  try {
    if (payload.audioUrl) {
      const audioRes = await fetch(payload.audioUrl);
      const audioBuffer = await audioRes.arrayBuffer();
      await writeFile(audioFile, Buffer.from(audioBuffer));
    }

    // Built as an argv array and run via execFile (no shell) instead of a
    // shell command string — the previous version interpolated caption text
    // (AI-generated, ultimately sourced from RSS/Reddit topic content) into
    // a string passed to exec(), which spawns a real shell. Only quotes were
    // escaped, so any other shell metacharacter in generated text would have
    // been interpreted by that shell. drawtext's own filter-syntax escaping
    // (for ffmpeg's filtergraph parser, a separate concern from the shell)
    // is unchanged below.
    const args = ['-y'];
    if (payload.backgroundVideo) {
      args.push('-i', payload.backgroundVideo);
    } else {
      args.push('-f', 'lavfi', '-i', `color=c=black:s=1080x1920:d=${payload.duration || 60}`);
    }
    if (payload.audioUrl) {
      args.push('-i', audioFile);
    }

    let filterComplex = '';
    if (payload.captions && payload.captions.length) {
      filterComplex = `[0:v]`;
      for (let i = 0; i < payload.captions.length; i++) {
        const cap = payload.captions[i];
        const safeText = cap.text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
        filterComplex += `drawtext=text='${safeText}':x=(w-text_w)/2:y=h-${i * 60 + 100}:fontsize=40:fontcolor=white:shadowcolor=black:shadowx=2:shadowy=2,`;
      }
      filterComplex = filterComplex.slice(0, -1);
    }
    if (filterComplex) {
      args.push('-filter_complex', filterComplex);
    }

    args.push('-map', '0:v');
    if (payload.audioUrl) {
      args.push('-map', '1:a');
    }
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-t', String(payload.duration || 60), '-pix_fmt', 'yuv420p', outputFile);

    await execFileAsync(ffmpeg, args, { timeout: 300000 });

    const video = await import('node:fs/promises').then(fs => fs.readFile(outputFile));
    await unlink(outputFile).catch(() => {});
    if (payload.audioUrl) {
      await unlink(audioFile).catch(() => {});
    }

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
    throw error;
  }
}

export async function checkRenderEngine() {
  try {
    const response = await axios.get(`${RENDER_API_URL}/health`, { timeout: 5000 });
    return response.status === 200;
  } catch {
    return false;
  }
}