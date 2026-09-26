FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS builder

WORKDIR /workspace

ENV NODE_OPTIONS=--max-old-space-size=1280

COPY . .

RUN corepack enable pnpm \
  && corepack install --global pnpm@12.3.4 \
  && pnpm install --frozen-lockfile --filter @devrandom/site... \
  && pnpm --filter @devrandom/domain run build \
  && pnpm --filter @devrandom/protocol run build \
  && pnpm --filter @devrandom/site run build

FROM nginx:1.28.0-alpine@sha256:30f1c0d78e0ad60901648be663a710bdadf19e4c10ac6782c235200619158284

COPY apps/site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /workspace/apps/site/.next/site-csp.inc /etc/nginx/site-csp.inc
COPY --from=builder /workspace/apps/site/out /usr/share/nginx/html

EXPOSE 3210
