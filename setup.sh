#!/bin/bash
# One-command setup for Horizon AI — single-service mode (default).
# TTS and rendering both run in-process (gTTS via python3, FFmpeg via the
# bundled ffmpeg-static npm package) — no separate services to deploy.
set -e  # stop on the first failure instead of printing a false "Setup complete"

echo "🚀 Setting up Horizon AI (single-service mode)..."

# Python3 + gTTS for the in-process TTS fallback (TTS_ENGINE=gtts, the
# default). On Railway this is handled by nixpacks.toml instead; this step
# is for running horizon-ai locally.
echo "📦 Checking for python3 + gTTS..."
if command -v pip3 &>/dev/null; then
  pip3 install gTTS
elif command -v pip &>/dev/null; then
  pip install gTTS
else
  echo "⚠️  Neither pip3 nor pip found — install Python 3 first, then run: pip3 install gTTS" >&2
fi

# Install Horizon AI dependencies (includes ffmpeg-static for in-process rendering)
echo "📦 Installing Horizon AI..."
npm install

# Copy environment file — never overwrite an existing .env with real keys in it
if [ -f ".env" ]; then
  echo "ℹ️  .env already exists — leaving it untouched."
else
  cp .env.example .env
  echo "✅ .env created from .env.example (TTS_ENGINE=gtts, RENDER_ENGINE=ffmpeg by default — no extra services needed)."
fi

echo ""
echo "✅ Setup complete for single-service mode. Edit .env with your API keys, then run 'npm start'."
echo ""
echo "Optional, NOT required to run: swapping in resemble-ai/chatterbox (needs you to build and deploy your"
echo "own HTTP wrapper around it — it's a library, not a server) or juppfy/render-video-api (needs its own"
echo "Postgres database, JWT_SECRET, S3-compatible bucket, and a dashboard-generated API key) as separate"
echo "Railway services for higher-quality TTS/rendering. Set TTS_ENGINE/RENDER_ENGINE accordingly if you do."
