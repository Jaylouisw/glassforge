# syntax=docker/dockerfile:1

# Glassforge — zero-dependency app, so there is no build or install stage.
FROM node:20-alpine

WORKDIR /app

COPY . .

ENV NODE_ENV=production \
    PORT=8000 \
    GF_DATA=/app/data

EXPOSE 8000

# The app writes projects under GF_DATA, so the data directory must be writable by `node`.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]
