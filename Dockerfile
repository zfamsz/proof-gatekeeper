# syntax=docker/dockerfile:1
# Proof Gatekeeper — production image.
# Circuit binaries are downloaded from the OFFICIAL Agent Games URLs at
# build time and verified against the SHA-256 hashes in RESEARCH.md §4.
# They are never committed to git (see .gitignore).
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN chown node:node /app

USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node test ./test
COPY --chown=node:node circuits/gatekeeper.vkey.json ./circuits/gatekeeper.vkey.json

RUN npm run build \
  && rm -rf src test

# Download + verify the circuit artifacts (official URLs, RESEARCH.md §4).
RUN mkdir -p /app/circuits \
  && curl -fsSL -o /app/circuits/gatekeeper.wasm https://agentgames.zkverify.io/circuits/gatekeeper.wasm \
  && curl -fsSL -o /app/circuits/gatekeeper_final.zkey https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey \
  && echo "be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f  /app/circuits/gatekeeper.wasm" | sha256sum -c - \
  && echo "adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d  /app/circuits/gatekeeper_final.zkey" | sha256sum -c - \
  && test "$(stat -c%s /app/circuits/gatekeeper.wasm)" = "1755820" \
  && test "$(stat -c%s /app/circuits/gatekeeper_final.zkey)" = "309750"

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/health" || exit 1

CMD ["node", "dist/src/server.js"]
