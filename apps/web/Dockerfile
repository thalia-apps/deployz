# syntax=docker/dockerfile:1

# apps/web — Next.js standalone, built inside the pnpm workspace.
#
# Build from the REPOSITORY ROOT (the build context is the whole workspace,
# because pnpm needs the lockfile and every project manifest):
#
#   docker build -f apps/web/Dockerfile --platform linux/amd64 \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.deployz.dev \
#     --build-arg NEXT_PUBLIC_APP_HOST=app.deployz.dev \
#     --build-arg NEXT_PUBLIC_MARKETING_HOST=deployz.dev \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://deployz.dev \
#     --build-arg NEXT_PUBLIC_COOKIE_PREFIX= \
#     -t deployz-web .

FROM --platform=linux/amd64 node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# ── Build ────────────────────────────────────────────────────────────────
FROM base AS build
WORKDIR /repo

# Manifests before sources so the install layer survives source-only changes.
# Every workspace manifest is copied, not just apps/web's: --frozen-lockfile
# validates the lockfile against the whole workspace and fails with
# "lockfile is not up to date" if a project directory is missing.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/analysis/package.json ./packages/analysis/package.json
COPY packages/cdk/package.json ./packages/cdk/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/copy-map/package.json ./packages/copy-map/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/fixture/package.json ./packages/fixture/package.json
COPY packages/relay/package.json ./packages/relay/package.json

# `@deployz/web...` is apps/web plus its workspace dependencies only, which
# keeps aws-cdk-lib and the AWS SDKs out of the build entirely.
RUN pnpm install --frozen-lockfile --filter @deployz/web...

COPY packages/contracts ./packages/contracts
COPY packages/copy-map ./packages/copy-map
# The Security Details page reads its IAM permissions from the committed
# bootstrap template (apps/web/src/lib/bootstrap-permissions.ts).
COPY packages/cdk/artifacts/bootstrap-template-v1.json ./packages/cdk/artifacts/bootstrap-template-v1.json
COPY apps/web ./apps/web

# apps/web has value imports from @deployz/contracts and @deployz/copy-map,
# and both packages resolve through their compiled dist/ (see their exports
# maps) — they must be built before `next build` can bundle them. .dockerignore
# strips **/dist, so a package whose build is missing here fails to resolve at
# all, and only in the image: `pnpm build` runs turbo, which builds every
# workspace package, so CI stays green.
RUN pnpm --filter @deployz/contracts build
RUN pnpm --filter @deployz/copy-map build

# NEXT_PUBLIC_* IS INLINED INTO THE CLIENT BUNDLE AT THIS STEP. A container
# environment variable cannot change them afterwards — a new value needs a new
# image. That makes the image environment-specific: do not build once and
# promote it between environments.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_HOST
ARG NEXT_PUBLIC_MARKETING_HOST
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_COOKIE_PREFIX
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_APP_HOST=$NEXT_PUBLIC_APP_HOST \
    NEXT_PUBLIC_MARKETING_HOST=$NEXT_PUBLIC_MARKETING_HOST \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_COOKIE_PREFIX=$NEXT_PUBLIC_COOKIE_PREFIX

# NEXT_OUTPUT gates `output: 'standalone'` in next.config.ts — see the comment
# there: it is opt-in because the standalone tree symlinks into the pnpm store,
# which Windows refuses, and the container build is the only consumer.
RUN NEXT_OUTPUT=standalone pnpm --filter @deployz/web build

# ── Runtime ──────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV PORT=3000
# The standalone server binds to localhost by default, which no container
# health check can reach. This is not optional.
ENV HOSTNAME=0.0.0.0

# outputFileTracingRoot is the repo root, so the standalone tree mirrors the
# workspace layout: the entry point is apps/web/server.js with node_modules
# hoisted to the tree root. .next/static is deliberately NOT part of the
# standalone output and has to be copied separately. The same applies to
# apps/web/public, which holds the brand icons that the web manifest uses.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
