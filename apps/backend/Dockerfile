# Combined Inflexion backend (REST API at / + Path-B engine at /engine).
# Build context = the monorepo root (see railway.json build.dockerfilePath).
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

# Copy the whole workspace and install. The build is scoped to the backend's
# dependency closure (sdk -> engine/api), so Foundry/Rust packages are never built.
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@inflexion/backend..." build

ENV NODE_ENV=production
# Railway injects PORT; the app listens on it (default 8088). /data is the shared
# volume for the telemetry JSONL (mount it in the Railway service).
EXPOSE 8088
CMD ["pnpm", "--filter", "@inflexion/backend", "start"]
