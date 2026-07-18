#!/bin/bash
# One-command setup script for Horizon AI full stack
set -e  # stop on the first failure instead of printing a false "Setup complete"

echo "🚀 Setting up Horizon AI full stack..."

# Clone Chatterbox (TTS library — NOT a server)
# ⚠️  chatterbox is a Python TTS library with no HTTP server, no app.py, and
# no /synthesize endpoint. Cloning it here does not give you a runnable
# tts-server; you still need to write and deploy your own wrapper around it
# (e.g. a small Flask/FastAPI app calling ChatterboxTTS.generate()) before
# TTS_ENGINE=chatterbox will actually work. Until then, set TTS_ENGINE=gtts
# in .env to use the working fallback path.
echo "📦 Cloning Chatterbox TTS (library only — see warning above)..."
if [ ! -d "tts" ]; then
  git clone https://github.com/resemble-ai/chatterbox.git tts
fi
cd tts
if command -v pip3 &>/dev/null; then
  pip3 install -r requirements.txt
elif command -v pip &>/dev/null; then
  pip install -r requirements.txt
else
  echo "⚠️  Neither pip3 nor pip found — skipping Chatterbox Python deps." >&2
fi
cd ..

# Clone Render Video API
# ⚠️  This is a real, runnable server, but it requires a PostgreSQL database
# (DATABASE_URL), a JWT_SECRET, and an S3-compatible bucket
# (RAILWAY_BUCKET_*) before it will start — see render-api/README.md and
# railway.json. It also requires you to register through its own dashboard
# and generate an API key, then set RENDER_API_KEY in .env — none of that
# can be automated by this script.
echo "📦 Cloning Render Video API (needs Postgres + S3 bucket + API key — see warning above)..."
if [ ! -d "render-api" ]; then
  git clone https://github.com/juppfy/render-video-api.git render-api
fi
cd render-api
npm install
cd ..

# Install Horizon AI dependencies
echo "📦 Installing Horizon AI..."
npm install

# Copy environment file — never overwrite an existing .env with real keys in it
if [ -f ".env" ]; then
  echo "ℹ️  .env already exists — leaving it untouched."
else
  cp .env.example .env
  echo "✅ .env created from .env.example."
fi

echo ""
echo "✅ Dependencies installed. This does NOT mean the free TTS/render stack is ready to run:"
echo "   1. tts-server has no actual server yet — write one, or set TTS_ENGINE=gtts in .env."
echo "   2. render-api needs DATABASE_URL, JWT_SECRET, and S3 bucket vars set before it starts."
echo "   3. render-api needs its own registered API key set as RENDER_API_KEY in .env."
echo "   Edit .env with your keys, then run 'npm start'."
