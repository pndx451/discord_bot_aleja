FROM node:22-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    --no-install-recommends && \
    pip3 install -q yt-dlp --break-system-packages && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Parchear @distube/yt-dlp: remover --no-call-home en todas sus variantes
RUN node -e "
const fs = require('fs');
const path = '/app/node_modules/@distube/yt-dlp/dist/index.js';
let code = fs.readFileSync(path, 'utf8');
console.log('Buscando no-call-home...');
console.log('Encontrado:', code.includes('no-call-home'));
code = code.replace(/[\"']--no-call-home[\"'],?\s*/g, '');
fs.writeFileSync(path, code);
console.log('Patch aplicado. Verificando:', !code.includes('no-call-home'));
"

COPY . .
CMD ["node", "index.js"]