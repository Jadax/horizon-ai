# Portable build — works on Cloud Run, Render, Northflank, a raw VM, or
# anywhere else that runs a container. Railway's nixpacks.toml is
# Railway-specific and is not used here; this Dockerfile replaces it.
FROM node:22-slim

# python3 + pip + gTTS: last-resort TTS fallback (src/lib/freeTTS.js) after
# the Gemini and (optional) ElevenLabs engines.
# fontconfig + fonts-dejavu-core: node:22-slim has neither, so ffmpeg's ass=
# subtitle filter (libass) had no usable font config at all on Cloud Run —
# verified live, every render failed with "No usable fontconfig
# configuration file found" / "Failed to load fonctconfig fonts!". DejaVu
# Sans is the standard free fallback and covers Latin script captions.
# ffmpeg (apt, not ffmpeg-static's prebuilt binary): the johnvansickle static
# build segfaults instantly on Cloud Run's gVisor sandbox on every real render
# (`Uncaught signal: 11 ... fault_addr=...`, confirmed live, reproducible,
# unaffected by 2x memory/CPU) — a SIMD-instruction/sandbox mismatch specific
# to that static binary. Debian's apt ffmpeg is a normal dynamically-linked
# build and doesn't hit it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip fontconfig fonts-dejavu-core fonts-liberation ffmpeg \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir gTTS yt-dlp

WORKDIR /app

# Install deps first so this layer only rebuilds when package*.json changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Point ffmpeg-static's resolved path at the real apt ffmpeg binary instead of
# its bundled (broken-on-Cloud-Run) one, so app code needs no changes.
RUN rm -f node_modules/ffmpeg-static/ffmpeg && ln -s /usr/bin/ffmpeg node_modules/ffmpeg-static/ffmpeg

# Cloud Run injects PORT at runtime (defaults to 8080, matching config.js).
# The app already binds to all interfaces (app.listen(config.port)), which
# is what Cloud Run/most container hosts require.
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.js"]
