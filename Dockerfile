# Momobit — Node + ffmpeg on Render (Docker runtime).
# The native Render runtimes don't ship ffmpeg, so we install it here.
FROM node:20-slim

# ffmpeg for audio/video work, and the fonts/deps the PDF step needs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Render provides PORT at runtime; the bot binds it for the webhook + health check.
CMD ["node", "bot.js"]
