FROM node:24-trixie-slim

# Why trixie + curl: sc.tuwaiq.edu.sa is behind Cloudflare bot management that
# fingerprints the TLS ClientHello (JA3). Node's own TLS stack and the old
# curl in bookworm-slim both get a permanent 403. curl 8.x on Debian trixie
# (OpenSSL 3.5, post-quantum X25519MLKEM768 group) matches a real browser's
# fingerprint and passes. src/http.js shells out to this curl.
# fonts-noto-core: Arabic glyphs for @resvg/resvg-js image rendering.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/index.js"]
