# Clio in one container: the server serves the built headset app, the API and the Gemini Live relay
# on one port. HTTPS comes from whatever is in front of it (Render, a tunnel, a proxy). See
# docs/deploy.md.
#
#   docker build -t clio .
#   docker run --rm -p 8787:8787 -e GEMINI_API_KEY=… -e CLIO_ACCESS_KEY=… -v clio-data:/app/data clio

FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
# Manifests first, so the install layer is reused until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/headset/package.json apps/headset/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# The server runs from its TypeScript source through tsx, as `pnpm start` does, so this keeps the
# workspace (node_modules, sources, the build) and leaves pnpm's download store behind.
FROM node:24-slim
ENV NODE_ENV=production \
    CLIO_HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
# The default port. Hosts that set PORT (Render does) get that one instead.
EXPOSE 8787
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
