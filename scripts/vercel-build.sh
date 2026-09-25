#!/usr/bin/env bash
#
# The Vercel build: check the database URLs, apply migrations, then build.
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

# --- Preflight ---------------------------------------------------------------
#
# Both database URLs are typed into a hosting dashboard by hand, which is
# exactly the kind of place a value arrives wrapped in quotes, still carrying
# the `psql ` prefix from a copy button, or holding the placeholder from the
# instructions. Prisma does catch a malformed URL, but it reports it as a
# schema validation failure pointing at `prisma/schema.prisma:27` — which sends
# you reading the schema, the one file that is not wrong.
#
# So check the shape here and say which variable, and how it is wrong, in the
# words of the dashboard the value was typed into.
#
# Nothing below ever prints a connection string or any part of one that could
# carry a credential. A scheme and a character count are safe to show; the
# value is not.

url_problem() {
  local name="$1" value="$2"

  case "$value" in
    postgresql://* | postgres://*) return 1 ;;
  esac

  local hint
  case "$value" in
    '')
      hint="it is empty. Delete the variable rather than leaving it blank, or paste the connection string into it"
      ;;
    "'"* | '"'*)
      hint="it is wrapped in quote marks. Paste the URL on its own, with no quotes around it"
      ;;
    psql*)
      hint="it starts with 'psql'. That is the command Neon's copy button gives you, not the URL — copy only the postgresql://... part from inside it"
      ;;
    '<'*)
      hint="it still holds the <placeholder> from the setup instructions, not a real connection string"
      ;;
    "$name"=*)
      hint="it repeats '$name=' inside the value. The value is the URL by itself; the name belongs in the Key field"
      ;;
    [[:space:]]*)
      hint="it begins with a space or a line break. Retype it with nothing before the p of postgresql"
      ;;
    *://*)
      # A scheme is not a credential, so naming it is safe and is usually the
      # whole answer.
      hint="its scheme is '${value%%://*}://'. It must be postgresql:// or postgres://"
      ;;
    *)
      hint="it has no scheme at all — it does not begin postgresql://. It is ${#value} characters long, so something was pasted, just not a connection string"
      ;;
  esac

  echo "  ✗ $name is not a PostgreSQL connection string: $hint." >&2
  return 0
}

echo "▸ Checking the database configuration"

preflight_failed=0
for var in DATABASE_URL DIRECT_URL; do
  # DIRECT_URL is optional; an absent one is handled further down, and an
  # absent DATABASE_URL is caught there too.
  if [ -n "${!var:-}" ] && url_problem "$var" "${!var}"; then
    preflight_failed=1
  fi
done

if [ "$preflight_failed" -ne 0 ]; then
  cat >&2 <<'EOF'

  Fix this in Vercel → your project → Settings → Environment Variables.
  Click the eye icon to reveal a value; edit it, save, and redeploy.

  Both come from the same Neon database and differ only in host:
    DATABASE_URL  the POOLED string   — its host contains "-pooler"
    DIRECT_URL    the UNPOOLED string — its host does not

  Each should look exactly like this, and start at the p:
    postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require

EOF
  exit 1
fi

# Not fatal, because a non-Neon Postgres has no pooler and this is then simply
# not applicable — but it is worth saying, because getting these two the wrong
# way round produces a lock timeout during migration that reads like the
# database being unreachable.
if [ -n "${DIRECT_URL:-}" ]; then
  case "$DIRECT_URL" in
    *-pooler.*)
      echo "  ! DIRECT_URL looks like a POOLED connection (its host contains"
      echo "    '-pooler'). Migrations need the unpooled string: the pooler runs"
      echo "    in transaction mode and cannot hold the advisory lock that stops"
      echo "    two deploys migrating at once. Expect this to hang or fail."
      ;;
  esac
fi

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
