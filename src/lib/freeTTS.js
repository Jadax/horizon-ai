import axios from 'axios';
import { config } from '../config.js';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ffmpeg from 'ffmpeg-static';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const PRIMARY_ENGINE = config.ttsEngine || 'gtts';
const TTS_API_URL = config.ttsApiUrl || 'http://localhost:5000/tts';
const FALLBACK_ENGINE = config.ttsFallback || 'gtts';

// Railway/nixpacks and most Linux distros only expose 'python3'; Windows'
// standard installer only exposes 'python'. Resolved once and cached so
// every gTTS call doesn't pay for a failed spawn on the wrong platform.
let pythonBinPromise = null;
async function resolvePythonBin() {
  if (!pythonBinPromise) {
    pythonBinPromise = (async () => {
      for (const bin of ['python3', 'python']) {
        try {
          await execFileAsync(bin, ['--version'], { timeout: 5000 });
          return bin;
        } catch {}
      }
      return 'python3';
    })();
  }
  return pythonBinPromise;
}

export async function synthesizeSpeech(text, voiceId = null, options = {}) {
  const engine = options.engine || PRIMARY_ENGINE;
  try {
    switch (engine) {
      case 'gemini':
        return await synthesizeGeminiTTS(text, voiceId, options);
      case 'elevenlabs':
        return await synthesizeElevenLabs(text, voiceId, options);
      case 'openai':
        return await synthesizeOpenAITTS(text, voiceId, options);
      case 'gtts':
        return await synthesizeGTTS(text, options);
      case 'chatterbox':
        return await synthesizeChatterbox(text, voiceId, options);
      case 'fish-speech':
        return await synthesizeFishSpeech(text, voiceId, options);
      case 'coqui':
        return await synthesizeCoqui(text, voiceId, options);
      case 'piper':
        return await synthesizePiper(text, voiceId, options);
      default:
        console.warn(`[TTS] Unknown engine "${engine}", falling back to gTTS`);
        return await synthesizeGTTS(text, options);
    }
  } catch (error) {
    console.error(`[TTS] Engine (${engine}) failed:`, error.message);
    console.log('[TTS] Falling back to gTTS (free, no GPU)');
    return await synthesizeGTTS(text, options);
  }
}

// OpenAI's TTS voices; anything else configured as voice_profile_id (e.g. a
// leftover ElevenLabs voice ID from the paid-stack era) maps to the default.
const OPENAI_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']);
const OPENAI_TTS_INSTRUCTIONS =
  'Narrate like a sharp, casual friend telling a genuinely interesting story: conversational pace with natural variation, ' +
  'clear emphasis on the surprising words, brief pauses at sentence breaks, energetic but never salesy or breathless.';

/**
 * Gemini TTS — FREE tier (verified live: real speech, healthy levels).
 * Returns raw PCM L16/24kHz, converted to mp3 via the bundled ffmpeg so
 * every downstream consumer (upload, whisper/gemini alignment, render mix)
 * sees the same format as the other engines.
 */
const GEMINI_VOICES = new Set(['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirhoe', 'Autonoe', 'Enceladus', 'Iapetus']);
async function synthesizeGeminiTTS(text, voiceId, options) {
  if (!config.geminiKey) throw new Error('GEMINI_API_KEY is not set');
  const voice = GEMINI_VOICES.has(String(voiceId)) ? String(voiceId) : 'Iapetus';
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${config.geminiKey}`,
    {
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    },
    { timeout: 90000 }
  );
  const inline = res.data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inline?.data) throw new Error('Gemini TTS returned no audio');
  const pcm = Buffer.from(inline.data, 'base64');
  const rate = /rate=(\d+)/.exec(inline.mimeType || '')?.[1] || '24000';
  const tmpPcm = path.join(tmpdir(), `horizon-gtts-${randomUUID()}.pcm`);
  const tmpMp3 = path.join(tmpdir(), `horizon-gtts-${randomUUID()}.mp3`);
  try {
    await writeFile(tmpPcm, pcm);
    await execFileAsync(ffmpeg, ['-y', '-f', 's16le', '-ar', rate, '-ac', '1', '-i', tmpPcm, '-c:a', 'libmp3lame', '-q:a', '3', tmpMp3], { timeout: 60000 });
    return await readFile(tmpMp3);
  } finally {
    await unlink(tmpPcm).catch(() => {});
    await unlink(tmpMp3).catch(() => {});
  }
}

/**
 * ElevenLabs TTS — the slot for a CLONED personal voice (e.g. a family
 * member narrating pet videos). Requires ELEVENLABS_API_KEY (paid, ~$5/mo
 * Starter) and a voice id created via their Instant Voice Clone from a
 * 1-3 minute consented recording. Errors fall through synthesizeSpeech's
 * catch to gTTS like every other engine.
 */
async function synthesizeElevenLabs(text, voiceId, options) {
  if (!config.elevenlabsKey) throw new Error('ELEVENLABS_API_KEY is not set');
  if (!voiceId) throw new Error('ElevenLabs needs a voice id (the cloned voice)');
  const res = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.45, similarity_boost: 0.8 },
  }, {
    headers: { 'xi-api-key': config.elevenlabsKey, 'Content-Type': 'application/json' },
    responseType: 'arraybuffer',
    timeout: 60000,
  });
  return Buffer.from(res.data);
}

async function synthesizeOpenAITTS(text, voiceId, options) {
  const voice = OPENAI_VOICES.has(String(voiceId || '').toLowerCase()) ? String(voiceId).toLowerCase() : 'onyx';
  const res = await axios.post('https://api.openai.com/v1/audio/speech', {
    model: 'gpt-4o-mini-tts',
    voice,
    input: text,
    instructions: OPENAI_TTS_INSTRUCTIONS,
    response_format: 'mp3',
    speed: options.speed || 1.0,
  }, {
    headers: { Authorization: `Bearer ${config.openaiKey}` },
    responseType: 'arraybuffer',
    timeout: 60000,
  });
  return Buffer.from(res.data);
}

async function synthesizeChatterbox(text, voiceId, options) {
  const response = await axios.post(`${TTS_API_URL}/synthesize`, {
    text: text,
    voice: voiceId || 'default',
    speed: options.speed || 1.0,
  }, {
    responseType: 'arraybuffer',
    timeout: 60000,
  });
  return Buffer.from(response.data);
}

async function synthesizeFishSpeech(text, voiceId, options) {
  const response = await axios.post(`${TTS_API_URL}/v1/tts`, {
    text: text,
    voice_id: voiceId || 'default',
    speed: options.speed || 1.0,
  }, {
    responseType: 'arraybuffer',
    timeout: 60000,
  });
  return Buffer.from(response.data);
}

async function synthesizeCoqui(text, voiceId, options) {
  const response = await axios.post(`${TTS_API_URL}/api/tts`, {
    text: text,
    speaker: voiceId || 'default',
    speed: options.speed || 1.0,
  }, {
    responseType: 'arraybuffer',
    timeout: 60000,
  });
  return Buffer.from(response.data);
}

// Both TTS fallbacks below previously built shell command strings by
// interpolating the full AI-generated narration script directly into them
// (only quote characters were escaped) and ran them via exec(), which spawns
// a real shell — any other shell metacharacter the model happened to emit
// (backtick, $(), ;, |, newline) would have been interpreted by that shell.
// Rewritten to pass the script through a temp file and invoke the binaries
// via execFile() with an argument array, which never spawns a shell.

async function synthesizePiper(text, voiceId, options) {
  const tmpOut = path.join(tmpdir(), `horizon-tts-${randomUUID()}.wav`);
  const voice = voiceId || 'en_US-amy-medium';
  await new Promise((resolve, reject) => {
    const child = execFile('piper', ['--model', voice, '--output_file', tmpOut], { timeout: 30000 }, (err) => {
      if (err) reject(err); else resolve();
    });
    child.stdin.write(text);
    child.stdin.end();
  });
  const audio = await import('node:fs/promises').then(fs => fs.readFile(tmpOut));
  await unlink(tmpOut).catch(() => {});
  return audio;
}

async function synthesizeGTTS(text, options) {
  const tmpText = path.join(tmpdir(), `horizon-tts-in-${randomUUID()}.txt`);
  const tmpOut = path.join(tmpdir(), `horizon-tts-${randomUUID()}.mp3`);
  const lang = options.lang || 'en';
  await writeFile(tmpText, text, 'utf8');
  const script = "import sys\nfrom gtts import gTTS\nwith open(sys.argv[1], encoding='utf-8') as f:\n    text = f.read()\ngTTS(text, lang=sys.argv[2]).save(sys.argv[3])\n";
  try {
    const pythonBin = await resolvePythonBin();
    await execFileAsync(pythonBin, ['-c', script, tmpText, lang, tmpOut], { timeout: 30000 });
    const audio = await import('node:fs/promises').then(fs => fs.readFile(tmpOut));
    return audio;
  } finally {
    await unlink(tmpText).catch(() => {});
    await unlink(tmpOut).catch(() => {});
  }
}

export function audioToBase64(audioBuffer) {
  return audioBuffer.toString('base64');
}

/**
 * Engine-aware health check for the dashboard diagnostics panel. Only
 * chatterbox/fish-speech/coqui are external services worth an HTTP check —
 * the default 'gtts' (and 'piper') run in-process via a local subprocess,
 * so "is it healthy" means "does python3 + the gtts module actually work",
 * not "does something answer on ttsApiUrl" (nothing does, by design, and
 * checking that previously reported the working default as "Down").
 */
export async function checkTTSEngine() {
  if (PRIMARY_ENGINE === 'openai') {
    return Boolean(config.openaiKey);
  }
  if (['chatterbox', 'fish-speech', 'coqui'].includes(PRIMARY_ENGINE)) {
    try {
      const res = await axios.get(TTS_API_URL.replace(/\/(synthesize|tts)$/, '/health'), { timeout: 5000 });
      return res.status === 200;
    } catch {
      return false;
    }
  }
  if (PRIMARY_ENGINE === 'piper') {
    try {
      await execFileAsync('piper', ['--help'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
  try {
    const pythonBin = await resolvePythonBin();
    await execFileAsync(pythonBin, ['-c', 'import gtts'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}