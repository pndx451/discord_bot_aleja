FROM node:22-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg \
    --no-install-recommends && \
    pip3 install -q yt-dlp --break-system-packages && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY patch-distube.js ./
RUN node patch-distube.js
COPY . .

CMD ["node", "index.js"]