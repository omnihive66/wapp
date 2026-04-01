FROM node:20-slim

# Dependências do Puppeteer/Chromium
RUN apt-get update && apt-get install -y \
    git \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Força git a usar HTTPS em vez de SSH (resolve erro 128 no Railway)
RUN git config --global url."https://".insteadOf git:// && \
    git config --global url."https://github.com/".insteadOf git@github.com:

COPY package.json ./
RUN npm install

COPY . .

RUN mkdir -p auth_info logs

EXPOSE 3001

CMD ["node", "server.js"]
