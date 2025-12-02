FROM node:20-bookworm

# Install system tools for conversion
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      ghostscript \
      libreoffice && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p tmp

ENV PORT=4000
EXPOSE 4000

CMD ["node", "server.js"]
