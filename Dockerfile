# Portable build — works on Cloud Run, Render, Northflank, a raw VM, or
# anywhere else that runs a container. Railway's nixpacks.toml is
# Railway-specific and is not used here; this Dockerfile replaces it.
FROM node:22-slim

# python3 + pip + gTTS: last-resort TTS fallback (src/lib/freeTTS.js) after
# the Gemini and (optional) ElevenLabs engines. ffmpeg needs NO system
# package here — ffmpeg-static ships a prebuilt binary via npm.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir gTTS

WORKDIR /app

# Install deps first so this layer only rebuilds when package*.json changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Cloud Run injects PORT at runtime (defaults to 8080, matching config.js).
# The app already binds to all interfaces (app.listen(config.port)), which
# is what Cloud Run/most container hosts require.
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.js"]
