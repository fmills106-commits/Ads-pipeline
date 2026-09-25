#!/usr/bin/env bash
#
# The Vercel build: apply migrations, then build.
#
# Migrating during the build rather than as a separate manual step means a
# deployment cannot go out against a database whose schema it does not match —
# the failure mode that produces Prisma errors on whichever page happens to
# touch a new column. It also means nobody needs a local toolchain to operate
# this: a push is the whole deploy.
#
# The trade is that a bad migration fails the build. That is the right way
# round: a deploy that stops is recoverable, a half-migrated production
# database is not.
#
# Migrations run over DIRECT_URL, never the pooled connection. Neon's pooler
# runs in transaction mode, which does not support the session-level advisory
# locks `prisma migrate deploy` uses to stop two deploys migrating at once.
# Pointing migrate at the pooled URL fails in ways that read like a network
# problem.

set -euo pipefail

echo "▸ Applying migrations"

if [ -n "${DIRECT_URL:-}" ]; then
  # `env` scopes the override to this one command, so the app's own
  # DATABASE_URL is untouched for the rest of the build.
  env DATABASE_URL="$DIRECT_URL" npx prisma migrate deploy
elif [ -n "${DATABASE_URL:-}" ]; then
  echo "  ! DIRECT_URL is not set, so migrations will run over DATABASE_URL."
  echo "    If that is a pooled connection string (its host contains"
  echo "    '-pooler'), this will fail. Add DIRECT_URL — the unpooled string"
  echo "    from the same database — in your project's environment variables."
  npx prisma migrate deploy
else
  echo "  ✗ Neither DIRECT_URL nor DATABASE_URL is set; cannot migrate." >&2
  exit 1
fi

echo "▸ Generating the Prisma client"
npx prisma generate

echo "▸ Building"
npx next build
