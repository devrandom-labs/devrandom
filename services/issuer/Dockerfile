FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

WORKDIR /workspace

COPY . .

RUN corepack enable pnpm \
  && corepack install --global pnpm@12.3.4 \
  && pnpm install --frozen-lockfile --filter @devrandom/issuer... \
  && pnpm --filter @devrandom/domain run build \
  && pnpm --filter @devrandom/protocol run build \
  && pnpm --filter @devrandom/identity run build \
  && pnpm --filter @devrandom/issuer run build

ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV PORT=3211

EXPOSE 3211

ENTRYPOINT ["node", "services/issuer/dist/main.js"]
