import axios from 'axios';
import { config } from '../config.js';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ffmpeg from 'ffmpeg-static';
import { execFileAsync, buildSrt, srtTime, uploadRenderArtifact } from './utils.js';

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
// Per-niche caption color themes (ASS colors are &HAABBGGRR). "Not just
// white print": each niche can pick its identity color via
// editing_style_preset.caption.color, flowing here as payload.captionStyle.
const CAPTION_COLORS = {
  white: '&H00FFFFFF',
  cream: '&H00D6F4FF',   // warm cream — Leo's cozy look
  yellow: '&H0000FFFF',
  mint: '&H00B4F0C8',
  sky: '&H00F8CD8C',
  pink: '&H00C8B4FF',
};

function buildAssSubtitles(captions, overlays = [], style = {}) {
  const primary = CAPTION_COLORS[style.color] || CAPTION_COLORS.white;
  const fontsize = Number(style.fontsize) || 80;
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    // Default: big bold themed color, heavy black outline, bottom-center.
    // Hook: comic-style yellow, thick outline, top-center.
    // Emoji: huge center-burst for payoff moments.
    // NumberPunch: massive yellow center for data reveals.
    // POV: smaller cream text at top for POV-style captions.
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginV, Spacing',
    `Style: Default,Arial,${fontsize},${primary},&H00000000,&H80000000,1,1,5,2,2,220,1`,
    'Style: Hook,Arial,104,&H0000FFFF,&H00000000,&H80000000,1,1,7,3,8,240,1',
    'Style: Emoji,Arial,120,&H00FFFFFF,&H00000000,&H80000000,1,1,3,2,5,240,1',
    'Style: NumberPunch,Arial,140,&H0000FFFF,&H00000000,&H80000000,1,1,5,2,5,180,1',
    'Style: POV,Arial,56,&H00D6F4FF,&H00000000,&H80000000,1,1,4,2,8,120,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Text',
  ].join('\n');
  const clean = (t) => String(t || '').replace(/[{}]/g, '').replace(/\n/g, ' ');
  const lines = [
    ...captions.map((cap) => `Dialogue: 0,${toAssTimestamp(cap.start)},${toAssTimestamp(cap.end)},Default,${clean(cap.text)}`),
    ...overlays.map((o) => `Dialogue: 1,${toAssTimestamp(o.start)},${toAssTimestamp(o.end)},Hook,${clean(o.text)}`),
  ];
  return header + '\n' + lines.join('\n') + '\n';
}

export async function renderVideo(payload, jobId) {
  // The local renderer is the only engine implementing the complete 2.0
  // contract: grounded cuts, captions, SRT, covers, and persistent output.
  return await renderWithFFmpeg(payload, jobId);
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
  const musicFile = path.join(tmpDir, `horizon-music-${randomUUID()}.audio`);
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
  const thumbnailFiles = [];

  try {
    if (payload.audioUrl) {
      const audioRes = await fetch(payload.audioUrl);
      const audioBuffer = await audioRes.arrayBuffer();
      await writeFile(audioFile, Buffer.from(audioBuffer));
    }
    if (payload.musicUrl) {
      const musicRes = await fetch(payload.musicUrl);
      if (!musicRes.ok) throw new Error(`Could not fetch music: HTTP ${musicRes.status}`);
      await writeFile(musicFile, Buffer.from(await musicRes.arrayBuffer()));
    }

    // Built as an argv array and run via execFile (no shell) instead of a
    // shell command string — captions are AI-generated, ultimately sourced
    // from RSS/Reddit topic content, so interpolating them into a shell
    // string (the previous approach) risked shell metacharacter injection.
    const args = ['-y'];
    for (const clip of clips) {
      const clipDuration = Math.max(0.5, clip.duration || 4);
      if (clip.type === 'image') {
        // Single-frame input; zoompan in the filter leg below generates the
        // clip's frames from it (ken-burns motion instead of a frozen still).
        args.push('-i', clip.url);
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
    const musicInputIndex = clips.length + (payload.audioUrl ? 1 : 0);
    if (payload.musicUrl) args.push('-stream_loop', '-1', '-i', musicFile);

    // Normalize every background input to the same size/fps/timebase
    // before concatenating — concat requires matching stream properties,
    // and inputs here can be a mix of stock video and generated stills.
    // All-image sets (illustrated explainer videos) get cross-dissolves via a
    // chained xfade instead of hard concat cuts. xfade eats `fadeDur` from
    // each junction, so every clip except the last is generated `fadeDur`
    // longer — total visible duration stays exactly the sum of the intended
    // clip durations.
    const allImages = clips.every((c) => c.type === 'image') && clips.length > 1;
    const fadeDur = 0.5;

    const legs = clips.map((clip, i) => {
      const visibleDur = Math.max(0.5, clip.duration || 4);
      if (clip.type === 'image') {
        // Ken-burns: pre-scale the still to 2x target so the zoom window
        // always samples above output resolution (no softening), then let
        // zoompan generate the clip's frames. Four rotating motion patterns
        // so consecutive stills never move identically: push-in, pull-out,
        // pan-right, pan-left.
        const dur = visibleDur + (allImages && i < clips.length - 1 ? fadeDur : 0);
        const frames = Math.round(dur * 30);
        const motions = [
          `z='min(1+0.0018*on,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
          `z='max(1.2-0.0018*on,1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
          `z=1.14:x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)'`,
          `z=1.14:x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`,
        ];
        return `[${i}:v]scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,zoompan=${motions[i % 4]}:d=${frames}:s=1080x1920:fps=30,setsar=1,setpts=PTS-STARTPTS[v${i}]`;
      }
      return `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,setpts=PTS-STARTPTS[v${i}]`;
    });
    let filterComplex;
    if (allImages) {
      const joins = [];
      let prevLabel = 'v0';
      let offset = 0;
      for (let i = 1; i < clips.length; i++) {
        offset += Math.max(0.5, clips[i - 1].duration || 4);
        const outLabel = i === clips.length - 1 ? 'vcat' : `x${i}`;
        joins.push(`[${prevLabel}][v${i}]xfade=transition=fade:duration=${fadeDur}:offset=${offset.toFixed(3)}[${outLabel}]`);
        prevLabel = outLabel;
      }
      filterComplex = [...legs, ...joins].join(';');
    } else {
      const concatInputs = clips.map((_, i) => `[v${i}]`).join('');
      filterComplex = [...legs, `${concatInputs}concat=n=${clips.length}:v=1:a=0[vcat]`].join(';');
    }

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
    if ((payload.captions && payload.captions.length) || (payload.overlays && payload.overlays.length)) {
      assFile = path.join(tmpDir, `horizon-captions-${randomUUID()}.ass`);
      await writeFile(assFile, buildAssSubtitles(payload.captions || [], payload.overlays || [], payload.captionStyle || {}));
      const assPath = assFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, '\u2019');
      // Warm color grading (payload.colorFilter) is applied before subtitles
      // so the grade affects the video but not the text rendering.
      const gradeLabel = payload.colorFilter ? 'vgraded' : 'vcat';
      if (payload.colorFilter) {
        filterComplex += `;[vcat]${payload.colorFilter}[vgraded]`;
      }
      filterComplex += `;[${gradeLabel}]ass='${assPath}'[vout]`;
    } else {
      if (payload.colorFilter) {
        filterComplex += `;[vcat]${payload.colorFilter}[vout]`;
      } else {
        filterComplex += ';[vcat]null[vout]';
      }
    }
    // Final audio is loudness-normalized to -14 LUFS (what YouTube/TikTok
    // normalize to anyway) so uploads land at platform loudness instead of
    // whatever level the TTS + music mix happened to sum to.
    // payload.keepSourceAudio mixes the FIRST clip's own audio in as well —
    // pet videos live on their natural sound (meows, purrs), which every
    // clip-replacement pipeline otherwise silently discards.
    const srcAudio = payload.keepSourceAudio && clips[0]?.type === 'video' ? `[0:a]volume=0.55[srcaud]` : null;
    if (payload.audioUrl && payload.musicUrl) {
      // Sidechain compression is driven by the authoritative narration audio,
      // so ducking follows actual speech rather than estimated script timing.
      filterComplex += `;[${audioInputIndex}:a]aresample=async=1,asplit=2[voice_mix][voice_key];[${musicInputIndex}:a]volume=0.20[music];[music][voice_key]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=250[ducked]`;
      filterComplex += srcAudio
        ? `;${srcAudio};[voice_mix][ducked][srcaud]amix=inputs=3:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`
        : `;[voice_mix][ducked]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;
    } else if (payload.audioUrl) {
      filterComplex += srcAudio
        ? `;${srcAudio};[${audioInputIndex}:a][srcaud]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`
        : `;[${audioInputIndex}:a]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;
    }
    args.push('-filter_complex', filterComplex);

    args.push('-map', '[vout]');
    if (payload.audioUrl) {
      args.push('-map', '[aout]');
    }
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-t', String(totalDuration), '-pix_fmt', 'yuv420p', outputFile);

    await execFileAsync(ffmpeg, args, { timeout: 300000 });
    await execFileAsync(ffmpeg, ['-v', 'error', '-i', outputFile, '-f', 'null', '-'], { timeout: 300000 });

    const video = await import('node:fs/promises').then(fs => fs.readFile(outputFile));
    const subtitleBody = Buffer.from(buildSrt(payload.captions || []), 'utf8');
    for (const [index, fraction] of [0.15, 0.5, 0.85].entries()) {
      const thumbnailFile = path.join(tmpDir, `horizon-cover-${randomUUID()}.png`);
      thumbnailFiles.push(thumbnailFile);
      await execFileAsync(ffmpeg, ['-y', '-ss', String(totalDuration * fraction), '-i', outputFile, '-frames:v', '1', '-vf', 'scale=1080:1920', thumbnailFile], { timeout: 60000 });
    }
    const [url, subtitleUrl, ...coverVariants] = await Promise.all([
      uploadRenderArtifact(`videos/${jobId}.mp4`, video, 'video/mp4'),
      uploadRenderArtifact(`subtitles/${jobId}.srt`, subtitleBody, 'application/x-subrip'),
      ...thumbnailFiles.map(async (file, index) => uploadRenderArtifact(`covers/${jobId}-${index + 1}.png`, await import('node:fs/promises').then(fs => fs.readFile(file)), 'image/png')),
    ]);
    await unlink(outputFile).catch(() => {});
    if (payload.audioUrl) {
      await unlink(audioFile).catch(() => {});
    }
    if (payload.musicUrl) await unlink(musicFile).catch(() => {});
    if (assFile) await unlink(assFile).catch(() => {});

    return {
      renderId: `ffmpeg-${randomUUID()}`,
      url,
      subtitleUrl,
      thumbnailUrl: coverVariants[0],
      coverVariants,
      syncPrecisionMs: payload.syncPrecisionMs,
      status: 'done',
    };
  } catch (error) {
    console.error('[FFmpeg] Error:', error.message);
    await unlink(outputFile).catch(() => {});
    if (payload.audioUrl) {
      await unlink(audioFile).catch(() => {});
    }
    if (payload.musicUrl) await unlink(musicFile).catch(() => {});
    if (assFile) await unlink(assFile).catch(() => {});
    await Promise.all(thumbnailFiles.map((file) => unlink(file).catch(() => {})));
    throw error;
  } finally {
    await Promise.all(thumbnailFiles.map((file) => unlink(file).catch(() => {})));
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
