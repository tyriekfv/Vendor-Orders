FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Inside a container we must bind all interfaces; publish the port to your LAN
# via the container's port mapping. The app has no login — keep it on a trusted network.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321

# The SQLite database and OCR cache live here — map it to persistent storage.
VOLUME /app/data

EXPOSE 4321

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:4321/api/vendors >/dev/null || exit 1

CMD ["node", "server.js"]
