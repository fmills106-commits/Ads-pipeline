# A container image for hosts that allow a long-lived process.
#
# Why this exists alongside the serverless setup: a container can run
# `npm run worker`, which claims a queued job within a couple of seconds. The
# serverless path needs an external scheduler poking an endpoint every few
# minutes instead. If scan latency ever matters more than the convenience of
# Vercel, this is the switch — same code, no rearchitecting.
#
#   docker build -t ads-pipeline .
#
#   docker run --env-file .env -p 3000:3000 ads-pipeline                # app
#   docker run --env-file .env ads-pipeline npm run worker              # worker
#   docker run --env-file .env ads-pipeline npx prisma migrate deploy   # schema
#
# One image, three commands, because the worker runs TypeScript through tsx and
# the migrator needs the Prisma CLI — splitting them would mean maintaining
# three dependency sets to save a few tens of megabytes on a fallback path.
#
# The image carries no secrets. Everything comes from the environment at run
# time, and the build deliberately does not need a reachable database.

# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

# Prisma's query engine needs libc compatibility and OpenSSL on Alpine.
RUN apk add --no-cache libc6-compat openssl

COPY package.json package-lock.json ./
# `npm ci` triggers prisma generate via postinstall, so the schema must be
# present before dependencies are installed.
COPY prisma ./prisma
RUN npm ci

# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Placeholders that satisfy the boot-time configuration check while compiling.
# The build renders pages; it never connects to anything. The production-only
# rules in src/lib/env.ts are skipped during a build for this reason — see the
# NEXT_PHASE check there.
ENV NODE_ENV=production
ENV APP_URL=https://placeholder.invalid
ENV DATABASE_URL=postgresql://placeholder/placeholder
ENV AUTH_SECRET=build-time-placeholder-secret-not-used-at-all
ENV ENCRYPTION_KEY=cGxhY2Vob2xkZXItMzItYnl0ZS1rZXktZm9yLWJ1aWxkcyE=
ENV NEXT_TELEMETRY_DISABLED=1

RUN npx prisma generate && npm run build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Never run as root.
RUN addgroup -g 1001 -S nodejs && adduser -S app -u 1001

COPY --from=builder --chown=app:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=app:nodejs /app/.next ./.next
COPY --from=builder --chown=app:nodejs /app/public ./public
COPY --from=builder --chown=app:nodejs /app/prisma ./prisma
COPY --from=builder --chown=app:nodejs /app/scripts ./scripts
COPY --from=builder --chown=app:nodejs /app/src ./src
COPY --from=builder --chown=app:nodejs /app/package.json ./package.json
COPY --from=builder --chown=app:nodejs /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=app:nodejs /app/tsconfig.json ./tsconfig.json

# Clear the build placeholders so a missing variable fails loudly at boot
# rather than quietly pointing at "postgresql://placeholder".
ENV APP_URL=""
ENV DATABASE_URL=""
ENV AUTH_SECRET=""
ENV ENCRYPTION_KEY=""

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
