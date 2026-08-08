import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ffmpeg from 'ffmpeg-static';
import { execFileAsync, buildSrt, uploadRenderArtifact } from './utils.js';

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

// Niche-specific visual presets (color grading + accent colors). Each grade is
// a full film-look filter chain (single pass applied AFTER concat, so the grade
// hits the video but never the caption text). Colors are warm-lifted shadows +
// golden highlights for cozy/pet niches, cool+cyan for tech, teal-orange for
// travel, punchy+vignetted for entertainment/gaming, desaturated cinematic for
// motivation, bright-clean for food. Vignette angle: smaller = subtler.
const COLOR_PRESETS = {
  neon_tech: {
    colorFilter: 'eq=contrast=1.15:saturation=1.12:brightness=-0.05,colorbalance=bs=0.04:gs=0.02:rs=-0.02,vignette=PI/4.5',
    captionColor: 'yellow',
    accentColor: '&H00FFD700', // electric blue
  },
  teal_gold: {
    colorFilter: 'eq=contrast=1.12:saturation=1.2:brightness=0.02,colorbalance=bs=0.06:gs=-0.03:rh=0.05:bh=-0.03,vignette=PI/5',
    captionColor: 'cream',
    accentColor: '&H0000FFD7', // warm gold
  },
  red_yellow: {
    colorFilter: 'eq=contrast=1.18:saturation=1.3:brightness=0.01,vignette=PI/4.5',
    captionColor: 'yellow',
    accentColor: '&H0000FFFF', // bright yellow
  },
  purple_crimson: {
    colorFilter: 'eq=contrast=1.14:saturation=1.12:brightness=-0.03,colorbalance=bs=0.05:bh=-0.02:rh=0.04,vignette=PI/3.5',
    captionColor: 'pink',
    accentColor: '&H00E74C3C', // crimson
  },
  coral_emerald: {
    colorFilter: 'eq=contrast=1.1:saturation=1.18:brightness=0.03,colorbalance=rh=0.04:bh=0.02',
    captionColor: 'mint',
    accentColor: '&H00FF6B6B', // coral
  },
  warm_gold: {
    // Cozy golden-hour look (pets/Leo): lifted warm shadows, golden highlights,
    // gentle vignette — reads "hug in video form", never clinical.
    colorFilter: 'eq=contrast=1.06:saturation=1.08:brightness=0.04,colorbalance=rs=0.03:gs=0.03:rh=0.06:gh=0.03:bh=-0.02,vignette=PI/5',
    captionColor: 'cream',
    accentColor: '&H00FFD700', // gold
  },
  bright_clean: {
    // Food/wholesome: bright, crisp, slightly warm, zero moodiness.
    colorFilter: 'eq=contrast=1.05:saturation=1.12:brightness=0.05',
    captionColor: 'white',
    accentColor: '&H00FFFFFF',
  },
  moody_cinematic: {
    // Motivation/reflective: desaturated, medium-contrast S-curve, dark corners.
    colorFilter: 'eq=contrast=1.12:saturation=0.85:brightness=-0.02,curves=preset=medium_contrast,vignette=PI/3',
    captionColor: 'white',
    accentColor: '&H00D4AF37', // muted gold
  },
  classic_white: {
    colorFilter: null,
    captionColor: 'white',
    accentColor: '&H00FFFFFF', // white
  },
};

function buildAssSubtitles(captions, overlays = [], style = {}, sparkleOverlays = false) {
  // Per-niche caption color: supports both named presets (cream/yellow/...)
  // and raw hex like "#10B981" / "10B981" — converted to ASS &HAABBGGRR so
  // dashboard-set caption colors actually reach the render.
  const toAssColor = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    return `&H00${b.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${r.toString(16).padStart(2, "0")}`.toUpperCase();
  };
  const primary = CAPTION_COLORS[style.color] || toAssColor(style.color) || CAPTION_COLORS.white;
  // Caption size follows the Blitzcut spec (1080x1920): standard/educational
  // 60-75px, hype 75-95px, hard max 100px, minimum readable 48px. The old
  // flat default of 100 sat at the hard max for EVERY niche — per-niche
  // values are set by agent4; this only enforces the spec's bounds.
  const fontsize = Math.min(100, Math.max(48, Number(style.fontsize) || 72));
  // Vertical safe-zone (stolen from browser-use/video-use render.py:41-56):
  // TikTok/IG Reels/Shorts UIs cover the bottom ~25-30% of a 1080x1920
  // frame, so captions must sit at least ~25% up. MarginV 500 ≈ 26% from the
  // bottom — the old 280 put the baseline right under the platform's own
  // caption bar. `caption.box` opts a niche into the solid-background-box
  // caption look (BorderStyle=3) that solves readability over busy footage.
  const boxMode = !!style.box;
  const backColour = boxMode ? (toAssColor(style.background) || "&HFF000000") : "&H80000000";
  const borderStyle = boxMode ? 3 : 1;
  // Per-niche caption texture (Hormozi/Submagic/typography research): the font
  // family stays Arial (custom fonts can't resolve on Railway's ffmpeg-static
  // build — no fontconfig), so the niche's feel comes from outline weight,
  // drop shadow, boldness and letter-spacing instead. Pets/cozy = soft thin
  // stroke + soft shadow; motivation = hairline + no shadow; tech/finance =
  // thick black stroke; gaming = heaviest. A dashboard-set outline/shadow/
  // spacing/bold wins over the table.
  const TEXTURE = {
    warm: { outline: 3, shadow: 4, bold: 1, spacing: 0 },
    rounded: { outline: 3, shadow: 4, bold: 1, spacing: 0 },
    minimal: { outline: 2, shadow: 2, bold: 0, spacing: 1 },
    geometric: { outline: 5, shadow: 2, bold: 1, spacing: 1 },
    impact: { outline: 6, shadow: 3, bold: 1, spacing: 0 },
    documentary: { outline: 3, shadow: 2, bold: 0, spacing: 1 },
  };
  const texture = TEXTURE[style.style] || { outline: 5, shadow: 2, bold: 1, spacing: 1 };
  const outline = Number(style.outline) || texture.outline;
  const shadow = Number(style.shadow) || texture.shadow;
  const bold = style.bold === undefined ? texture.bold : Number(style.bold);
  const spacing = Number(style.spacing) || texture.spacing;
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginV, Spacing',
    `Style: Default,Arial,${fontsize},${primary},&H00000000,${backColour},${bold},${borderStyle},${outline},${shadow},2,500,${spacing}`,
    // Hook: bold, big, warm golden, center-top, thick outline — scroll-stopping
    'Style: Hook,Arial,116,&H0000CCFF,&H00000000,&H80000000,1,1,7,3,8,300,2',
    // SFX pop-in styles — bright colorful cat sounds
    'Style: SFX_pink,Arial,72,&H00FF69B4,&H00000000,&H80000000,1,1,4,2,5,200,1',
    'Style: SFX_cyan,Arial,72,&H00FFFF00,&H00000000,&H80000000,1,1,4,2,5,200,1',
    'Style: SFX_yellow,Arial,72,&H0000CCFF,&H00000000,&H80000000,1,1,4,2,5,200,1',
    'Style: SFX_green,Arial,72,&H0000FF88,&H00000000,&H80000000,1,1,4,2,5,200,1',
    // Emoji pop-in — big centered emoji burst
    'Style: EmojiPop,Arial,96,&H00FFFFFF,&H00000000,&H00000000,0,1,2,0,5,100,0',
    'Style: Emoji,Arial,120,&H00FFFFFF,&H00000000,&H80000000,1,1,3,2,5,240,1',
    'Style: NumberPunch,Arial,140,&H0000FFFF,&H00000000,&H80000000,1,1,5,2,5,180,1',
    'Style: POV,Arial,56,&H00D6F4FF,&H00000000,&H80000000,1,1,4,2,8,120,1',
    'Style: Sparkle,Arial,28,&H00FFFFFF,&H00000000,&H00000000,0,1,1,0,5,0,0',
    // === NICHE-SPECIFIC STYLES ===
    // Tech: Terminal/code aesthetic — monospace, green-on-dark, code snippet look
    'Style: Tech_Code,Arial,68,&H0000FF88,&H00000000,&H80000000,1,1,4,2,5,200,1',
    'Style: Tech_Highlight,Arial,80,&H00FFD700,&H00000000,&H80000000,1,1,5,2,5,220,1',
    // Travel: Destination cards — semi-transparent box, warm gold
    'Style: Travel_Dest,Arial,72,&H0000D7FF,&H00000000,&H80000000,1,1,5,2,5,240,1',
    'Style: Travel_Price,Arial,88,&H0000CCFF,&H00000000,&H80000000,1,1,6,2,5,260,1',
    // Entertainment: Kinetic typography — bold, impact, bounce animation
    'Style: Kinetic,Arial,96,&H0000FFFF,&H00000000,&H80000000,1,1,6,3,5,200,1',
    'Style: Kinetic_Red,Arial,104,&H000000FF,&H00000000,&H80000000,1,1,6,3,5,200,1',
    // Gaming: Lore drop — mystic purple, ornate feel
    'Style: Lore_Drop,Arial,80,&H00E74C3C,&H00000000,&H80000000,1,1,5,2,5,220,1',
    'Style: Lore_Reveal,Arial,76,&H009B59B6,&H00000000,&H80000000,1,1,5,2,5,220,1',
    // Pet: Playful — coral, rounded feel, bouncy
    'Style: Pet_Reaction,Arial,84,&H00FF6B6B,&H00000000,&H80000000,1,1,5,2,5,200,1',
    'Style: Pet_Cute,Arial,76,&H002ECC71,&H00000000,&H80000000,1,1,4,2,5,220,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Text',
  ].join('\n');
  const clean = (t) => String(t || '').replace(/[{}]/g, '').replace(/\\N/g, ' ').replace(/\n/g, ' ').replace(/\\fad\([^)]*\)/gi, '').replace(/\\fscx\d+/gi, '').replace(/\\fscy\d+/gi, '').replace(/\\frz[\d.]+/gi, '').replace(/\\blur[\d.]+/gi, '').replace(/\\[a-z]+\([^)]*\)/gi, '').replace(/\\[a-z]+/gi, '');

  // PUNCH-CARD caption style (stolen from clipforge's 爆款 phrase-cards +
  // ShortsGenerator): split each caption into short 2-3 word "cards" on
  // natural punctuation/word boundaries, staggered so they pop in sequence like
  // rapid callouts — the scroll-stopping phrase-card cadence the viral
  // word-clip niche runs on. Total timing stays inside the original caption
  // window (so audio sync is preserved); pure ASS event generation using the
  // existing Default style, no filterchain risk.
  if (style.style === "punch") {
    const out = [];
    for (const cap of captions) {
      const text = String(cap.text || "").trim();
      if (!text) continue;
      const words = text.split(/\s+/).filter(Boolean);
      const cards = [];
      let buf = [];
      for (const w of words) {
        buf.push(w);
        if (buf.length >= 3 || /[,.;!?]$/.test(w)) {
          cards.push(buf.join(" "));
          buf = [];
        }
      }
      if (buf.length) cards.push(buf.join(" "));
      const span = Math.max(0.08, (cap.end - cap.start) / Math.max(1, cards.length));
      cards.forEach((card, i) => {
        const s = cap.start + i * span;
        out.push({ start: +s.toFixed(3), end: +(s + span).toFixed(3), text: card });
      });
    }
    captions = out;
  }
  // MrBeast-style emphasis: key numbers, prices, percentages, and big
  // figures pop in bright yellow inside otherwise white/cream captions so
  // the eye lands on the one number that matters. Applied AFTER clean()
  // (which strips braces) so the ASS override tags below survive.
  const emphasizeNumbers = (t) =>
    String(t).replace(
      /(?:\$|€|£|₹)?\s?\d[\d,]*(?:\.\d+)?\s?(?:%|K|M|B|m|b|k)?/g,
      (m) => (/\d/.test(m) ? `{\\c&H0000FFFF}${m}{\\r}` : m)
    );
  // LLM-selected keyword emphasis (Submagic/OpusClip/Hormozi steal): agent2
  // emits the 3-6 words that carry the script's value; each is recolored to
  // the niche's highlight yellow when it appears in a caption, so one word
  // per phrase pops instead of every number. Wrapped AFTER clean() so the
  // override tags survive.
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const emphasizeWords = (t) => {
    let out = String(t);
    for (const w of style.emphasis || []) {
      const word = String(w).trim();
      if (!word) continue;
      const re = new RegExp(`(^|\\s)(${escapeRe(word)})(?=[\\s.!?,;]|$)`, "i");
      out = out.replace(re, `$1{\\c&H0000FFFF}${word}{\\r}`);
    }
    return out;
  };
  const styleCaption = (t) => emphasizeWords(emphasizeNumbers(clean(t)));

  // Map color_preset to niche-specific overlay styles
  const nicheOverlayStyle = {
    neon_tech: 'Tech_Code',
    teal_gold: 'Travel_Dest',
    red_yellow: 'Kinetic',
    purple_crimson: 'Lore_Drop',
    coral_emerald: 'Pet_Reaction',
    warm_gold: 'Pet_Cute',
    bright_clean: 'Hook',
    moody_cinematic: 'Hook',
    classic_white: 'Hook',
  };
  const defaultOverlayStyle = nicheOverlayStyle[style.color_preset] || 'Hook';
  
  const lines = [
    ...captions.map((cap) => `Dialogue: 0,${toAssTimestamp(cap.start)},${toAssTimestamp(cap.end)},Default,${primary === '&H0000FFFF' ? clean(cap.text) : styleCaption(cap.text)}`),
    ...overlays.map((o) => {
      const s = o.style || defaultOverlayStyle;
      // Niche-specific animations
      let fade = '';
      if (s.startsWith('SFX_')) fade = '\\fad(150,200)\\fscx120\\fscy120';
      else if (s === 'EmojiPop') fade = '\\fad(100,150)\\fscx150\\fscy150';
      else if (s === 'Hook') fade = '\\fad(300,200)';
      // Tech: code typing effect
      else if (s === 'Tech_Code' || s === 'Tech_Highlight') fade = '\\fad(200,150)';
      // Travel: destination card slide-in
      else if (s === 'Travel_Dest' || s === 'Travel_Price') fade = '\\fad(250,200)\\frz3';
      // Entertainment: kinetic bounce
      else if (s === 'Kinetic' || s === 'Kinetic_Red') fade = '\\fad(150,200)\\fscx110\\fscy110';
      // Gaming: lore reveal glow
      else if (s === 'Lore_Drop' || s === 'Lore_Reveal') fade = '\\fad(300,250)\\blur2';
      // Pet: playful pop
      else if (s === 'Pet_Reaction' || s === 'Pet_Cute') fade = '\\fad(180,200)\\fscx115\\fscy115';
      else fade = '\\fad(200,200)';
      return `Dialogue: 1,${toAssTimestamp(o.start)},${toAssTimestamp(o.end)},${s},${fade}${clean(o.text)}`;
    }),
  ];

  return header + '\n' + lines.join('\n') + '\n';
}

export { buildAssSubtitles };

export async function renderVideo(payload, jobId) {
  // The local renderer is the only engine implementing the complete 2.0
  // contract: grounded cuts, captions, SRT, covers, and persistent output.
  
  // Apply niche-specific color preset if provided
  if (payload.color_preset && COLOR_PRESETS[payload.color_preset]) {
    const preset = COLOR_PRESETS[payload.color_preset];
    if (!payload.colorFilter && preset.colorFilter) {
      payload.colorFilter = preset.colorFilter;
    }
    if (!payload.captionStyle?.color && preset.captionColor) {
      payload.captionStyle = { ...payload.captionStyle, color: preset.captionColor };
    }
  }
  
  return await renderWithFFmpeg(payload, jobId);
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
  const sfxFiles = [];

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

    // SFX layer (playbook spec: sparse one-shot sounds at -6 to -10 dB under
    // the voiceover, placed at key visual moments — agent4 sends hook/payoff
    // timings). Mirrors the music download/mix; no-ops when sfx is absent or
    // a fetch fails, so an unstocked sfx_library never breaks a render.
    const sfx = Array.isArray(payload.sfx)
      ? payload.sfx.filter((s) => s?.url && Number.isFinite(Number(s.start))).slice(0, 4)
      : [];
    let sfxChain = '';
    if (sfx.length) {
      let sfxIndex = clips.length + (payload.audioUrl ? 1 : 0) + (payload.musicUrl ? 1 : 0);
      const sfxFilters = [];
      for (const s of sfx) {
        const sfxFile = path.join(tmpDir, `horizon-sfx-${randomUUID()}.audio`);
        const sfxRes = await fetch(s.url);
        if (!sfxRes.ok) continue;
        await writeFile(sfxFile, Buffer.from(await sfxRes.arrayBuffer()));
        args.push('-i', sfxFile);
        sfxFiles.push(sfxFile);
        // -9 dB default (spec range -6 to -10 dB), placed at its timeline moment
        const volume = Number(s.volume) || 0.35;
        const delayMs = Math.max(0, Math.round(Number(s.start) * 1000));
        sfxFilters.push(`[${sfxIndex}:a]volume=${volume},adelay=${delayMs}:all=1[sfx${sfxFilters.length}]`);
        sfxIndex++;
      }
      sfxChain = sfxFilters.length ? `;${sfxFilters.join(';')}` : '';
    }

    // Purr bed (pet content, opt-in via payload.purr): a procedurally
    // synthesized low harmonic stack (37/74/111 Hz) amplitude-modulated at a
    // real cat-purr rate (~4.5 Hz), mixed softly under the music as "cozy
    // warmth". Only generated when music is present — a purr bed with no
    // music under it would read as a mechanical buzz.
    let purrFile = null;
    let purrLabel = '';
    if (payload.purr && payload.musicUrl) {
      purrFile = path.join(tmpDir, `horizon-purr-${randomUUID()}.wav`);
      const purrExpr = "(0.11*sin(2*PI*37*t)+0.055*sin(2*PI*74*t)+0.027*sin(2*PI*111*t))*(0.7+0.3*sin(2*PI*4.5*t))";
      await execFileAsync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `aevalsrc=${purrExpr}:s=44100:d=${Number(totalDuration) + 1}`, '-c:a', 'pcm_s16le', purrFile], { timeout: 30000 });
      args.push('-i', purrFile);
      const purrIndex = clips.length + (payload.audioUrl ? 1 : 0) + (payload.musicUrl ? 1 : 0) + sfxFiles.length;
      purrLabel = `[${purrIndex}:a]volume=0.55,lowpass=f=220[purr]`;
    }

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
      // Blur-fill reframe (opt-in via payload.blurFill): blurred full-frame
      // background with the fitted subject centered on top — keeps wide
      // 16:9 stock/clip subjects fully visible instead of center-cropping
      // them. Harmless for already-vertical sources (subject fills the frame).
      if (payload.blurFill) {
        return `[${i}:v]split[b${i}][f${i}];[b${i}]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:2,eq=brightness=-0.12:saturation=1.05[bg${i}];[f${i}]scale=1080:1920:force_original_aspect_ratio=decrease[fg${i}];[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,setpts=PTS-STARTPTS[v${i}]`;
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
      // Pass color_preset through to buildAssSubtitles for niche-specific overlay styles
      const styleWithPreset = { ...payload.captionStyle, color_preset: payload.color_preset };
      await writeFile(assFile, buildAssSubtitles(payload.captions || [], payload.overlays || [], styleWithPreset, payload.sparkleOverlays));
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
    const warmEq = payload.warmAudio ? ',equalizer=f=200:t=q:w=1.0:g=3,equalizer=f=4000:t=q:w=1.0:g=-2' : '';
    // Resolve the [sfxN] labels produced above so the amix below can include them
    const sfxLabels = sfxChain ? (sfxChain.match(/\[sfx\d\]/g) || []).join('') : '';
    const sfxCount = sfxLabels ? sfxLabels.match(/\[sfx\d\]/g).length : 0;

    if (payload.audioUrl && payload.musicUrl) {
      // Sidechain compression is driven by the authoritative narration audio,
      // so ducking follows actual speech rather than estimated script timing.
      // Music sits at -14 dB pre-duck (spec: -10 to -15 dB under the VO) with
      // a 2s fade-in and a 3s fade-out over the tail (AUDIO_RULES musicTiming).
      const fadeOutStart = Math.max(0, Number(totalDuration) - 3).toFixed(2);
      filterComplex += `;[${audioInputIndex}:a]aresample=async=1${warmEq},asplit=2[voice_mix][voice_key];[${musicInputIndex}:a]volume=0.20,afade=t=in:d=2,afade=t=out:st=${fadeOutStart}:d=3[music];[music][voice_key]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=250[ducked]`;
      filterComplex += srcAudio ? `;${srcAudio}` : '';
      filterComplex += sfxChain;
      if (purrLabel) filterComplex += `;${purrLabel}`;
      filterComplex += `;[voice_mix][ducked]${srcAudio ? '[srcaud]' : ''}${sfxLabels}${purrLabel ? '[purr]' : ''}amix=inputs=${2 + (srcAudio ? 1 : 0) + sfxCount + (purrLabel ? 1 : 0)}:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;
    } else if (payload.audioUrl) {
      // No music bed — voice + (optional source audio) + SFX, still normalized
      filterComplex += `;[${audioInputIndex}:a]aresample=async=1${warmEq}[voice_mix]`;
      filterComplex += srcAudio ? `;${srcAudio}` : '';
      filterComplex += sfxChain;
      filterComplex += `;[voice_mix]${srcAudio ? '[srcaud]' : ''}${sfxLabels}amix=inputs=${1 + (srcAudio ? 1 : 0) + sfxCount}:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;
    } else if (payload.musicUrl) {
      // Music-only bed (vibes-first compilations with no voiceover): music at
      // near-full level + optional source audio + purr bed. This case used to
      // fall through with NO filter at all — the music input was fetched but
      // never referenced, producing a silent render.
      const fadeOutStart = Math.max(0, Number(totalDuration) - 3).toFixed(2);
      filterComplex += `;[${musicInputIndex}:a]volume=0.85,afade=t=in:d=1,afade=t=out:st=${fadeOutStart}:d=3[music]`;
      filterComplex += srcAudio ? `;${srcAudio}` : '';
      if (purrLabel) filterComplex += `;${purrLabel}`;
      filterComplex += `;[music]${srcAudio ? '[srcaud]' : ''}${purrLabel ? '[purr]' : ''}amix=inputs=${1 + (srcAudio ? 1 : 0) + (purrLabel ? 1 : 0)}:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;
    }
    args.push('-filter_complex', filterComplex);

    args.push('-map', '[vout]');
    if (payload.audioUrl || payload.musicUrl) {
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
    if (purrFile) await unlink(purrFile).catch(() => {});
    for (const f of sfxFiles) await unlink(f).catch(() => {});
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
    if (purrFile) await unlink(purrFile).catch(() => {});
    for (const f of sfxFiles) await unlink(f).catch(() => {});
    if (assFile) await unlink(assFile).catch(() => {});
    await Promise.all(thumbnailFiles.map((file) => unlink(file).catch(() => {})));
    throw error;
  } finally {
    await Promise.all(thumbnailFiles.map((file) => unlink(file).catch(() => {})));
  }
}

export async function checkRenderEngine() {
  try {
    await execFileAsync(ffmpeg, ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
