# Deploying

Everything here is free except the domain, which is about $10–15 a year at
cost. No credit card is needed for the hosting or the database.

---

## Why not Cloudflare Workers

Cloudflare is used here for the domain, DNS and edge protection — the things it
is unmatched at — but **the application itself cannot run on Workers**, and it
is worth knowing why before trying.

Workers have no DNS API. The scanner's second SSRF gate resolves a hostname and
checks every address it points at _before_ opening a socket
(`assertResolvedAddressesArePublic`), because a public hostname can have a
private `A` record. On Workers that check cannot be written at all, so the
choice would be between deleting the guard or shipping a scanner that can be
pointed at internal infrastructure. Neither is acceptable in an application
whose entire job is fetching URLs strangers supply.

`node:crypto`'s `scrypt` — the password hash — and `node:net` are also absent.
Cloudflare Containers would sidestep all of this, but they are a paid product,
so the recommendation below keeps the free path open.

---

## What goes where

| Piece                  | Where               | Cost                  |
| ---------------------- | ------------------- | --------------------- |
| Domain + DNS           | Cloudflare          | ~$10–15/year, at cost |
| Application            | Vercel              | $0 (Hobby)            |
| PostgreSQL             | Neon                | $0 (free tier)        |
| Tests on every push    | GitHub Actions      | $0                    |
| Draining the job queue | GitHub Actions cron | $0                    |

The last row matters more than it looks — see [The worker](#the-worker).

---

## 1. Database (Neon)

1. Create a project at [neon.tech](https://neon.tech). Pick the region nearest
   your users.
2. From the connection details, copy **both** strings:
   - the **pooled** one (host contains `-pooler`) → `DATABASE_URL`
   - the **direct** one (no `-pooler`) → `DIRECT_URL`

Both are needed, for different jobs. The app uses the pooled connection
because a serverless function opens one per invocation and would otherwise
exhaust the server's limit. Migrations use the direct one, because Neon's
pooler runs in transaction mode and does not support the session-level
advisory locks `prisma migrate deploy` uses to stop two deploys migrating at
once — point migrate at the pooled URL and it fails in ways that read like a
network fault.

**Nothing to run by hand.** `scripts/vercel-build.sh` applies migrations on
every deploy, before building. That means a deployment cannot go out against a
database whose schema it does not match, and operating this needs no local
toolchain: a push is the whole deploy. A bad migration fails the build, which
is the right way round — a stopped deploy is recoverable, a half-migrated
production database is not.

Ignore Neon's "set up with your coding agent" prompt and the "install Neon
skills" box. They install a CLI, an MCP server and a `neon.ts` config;
`DATABASE_URL` is the entire interface between this application and Postgres.

## 2. Secrets

```bash
openssl rand -base64 48   # AUTH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY   (must decode to exactly 32 bytes)
openssl rand -base64 32   # CRON_SECRET
```

Keep them. `ENCRYPTION_KEY` is not recoverable — losing it makes any stored
OAuth token undecryptable, and from Phase 6 that means reconnecting Meta.

## 3. Application (Vercel)

Import the GitHub repository at [vercel.com/new](https://vercel.com/new). It
detects Next.js; `vercel.json` in the repository supplies the build command and
the function limits.

Set these environment variables for **Production**. There are five, and all
five are secrets — nothing else needs setting:

| Variable         | Value                                 |
| ---------------- | ------------------------------------- |
| `DATABASE_URL`   | the **pooled** Neon string            |
| `DIRECT_URL`     | the **direct** (unpooled) Neon string |
| `AUTH_SECRET`    | generated above                       |
| `ENCRYPTION_KEY` | generated above                       |
| `CRON_SECRET`    | generated above                       |

Paste each connection string on its own, starting at the `p` of
`postgresql://`. Neon's copy button hands you a whole `psql '…'` command, and
pasting that — or the URL with the quotes still around it — gives a build
failure that blames `prisma/schema.prisma` rather than the variable. The build
checks both strings before it does anything else and names whichever is wrong,
so you get one clear line instead of `P1012`; it prints no part of the value,
because the value contains a password.

Everything else is derived from what Vercel tells the application about
itself: `APP_URL` from the deployment's hostname (the deployment's own, on a
preview, so its cookies do not target production), `TRUSTED_PROXY=vercel`,
`LOG_FORMAT=json`, and a `WORKER_MAX_RUN_MS` that fits inside the function
timeout. Set any of them explicitly and the explicit value wins — which is
what you want if you later put Cloudflare's proxy in front, since the header
carrying the client's address changes with it.

**When Vercel offers to import environment variables from the repository,
decline, or check what it filled in.** It reads `.env.example`, whose values
are local-development defaults. The secrets there are commented out for this
reason, but `DATABASE_URL` still points at a local Postgres and `APP_URL` at
`http://localhost:3000` — neither of which you want in production. The app
refuses to boot on an `http://` `APP_URL` rather than running insecurely, and
refuses outright if a production deployment ends up with
`NODE_ENV=development`, which would otherwise silently skip every safety
check and stop marking session cookies secure.

**Do not add Vercel's "Prisma Postgres" integration.** You already have Neon;
that would create a second database and set a conflicting `DATABASE_URL`.

## 4. Domain (Cloudflare)

Cloudflare Registrar sells at cost with no renewal markup and free WHOIS
privacy.

1. Register or transfer the domain in Cloudflare → **Domain Registration**.
2. In Vercel → project → **Domains**, add the domain. Vercel shows the records
   it wants.
3. In Cloudflare → **DNS**, add them:

   | Type    | Name  | Content                | Proxy        |
   | ------- | ----- | ---------------------- | ------------ |
   | `CNAME` | `@`   | `cname.vercel-dns.com` | **DNS only** |
   | `CNAME` | `www` | `cname.vercel-dns.com` | **DNS only** |

**Leave the proxy off (grey cloud).** Vercel issues and renews the certificate
and terminates TLS itself; putting Cloudflare's proxy in front adds a second
TLS hop that causes redirect loops unless Cloudflare's SSL mode is _Full
(strict)_. If you do want Cloudflare's WAF and caching in front, set SSL/TLS →
Overview → **Full (strict)** first, then switch `TRUSTED_PROXY` to
`cloudflare`, since the header carrying the client's address changes with it.

## 5. The worker

**This step is not optional.** Without it, pressing "Read my website" queues a
scan that nothing ever picks up, and the application looks broken while being
perfectly healthy.

A serverless deployment has nowhere to keep a long-lived process, so something
external has to drive the queue. The repository ships a workflow that does it:

1. GitHub → repository → **Settings → Secrets and variables → Actions**
2. Add a **secret** `CRON_SECRET` — the same value as in Vercel.
3. Add a **variable** `APP_URL` — `https://your-domain.com`.

`.github/workflows/worker.yml` then calls `/api/cron/worker` every five
minutes. It also clears expired sessions and spent rate-limit counters.

`vercel.json` additionally declares a Vercel Cron entry for the same endpoint,
but only once a day (`0 4 * * *`). That is not a preference — Vercel's Hobby
plan accepts no finer granularity than daily, and a deployment whose
`vercel.json` asks for more is rejected at build time rather than quietly
downgraded. So the GitHub workflow is the real scheduler and the Vercel entry
is a daily safety net for the housekeeping (expired sessions, spent rate-limit
counters) in case the workflow is never configured.

Two schedulers calling the same endpoint is harmless: jobs are claimed with
`FOR UPDATE SKIP LOCKED`, so the second caller simply finds nothing to do.

`maxDuration` is 60 seconds for the same reason — that is the Hobby ceiling,
and asking for more fails the build. `WORKER_MAX_RUN_MS` defaults to 50s on
Vercel so a drain returns of its own accord before the platform kills it; a
crawl cut short that way reports PARTIAL with the pages it did read. On a plan
with longer functions, raise both together or neither.

To confirm it works:

```bash
curl -i -H "Authorization: Bearer $CRON_SECRET" https://your-domain.com/api/cron/worker
```

Expect `{"data":{"processed":0,...}}`. A `401` means the secret does not match.

### If five-minute latency is too slow

Scans then start within a few minutes rather than a few seconds. When that
becomes annoying, move to a host that allows a real process — the code needs no
changes:

```bash
docker build -t ads-web .
docker build -t ads-worker --target worker .
```

Run `ads-web` for the app and `ads-worker` alongside it. The worker claims a
job within about two seconds. Fly.io and any VPS work this way; Fly requires a
card on file, though a small app usually stays inside the free allowance.

## 6. Check it

```bash
curl https://your-domain.com/api/health
```

Then in a browser: register, answer the four setup questions, add one of your
websites, and press **Read my website**. Within a few minutes the Website page
should list your products with the URL each fact came from.

The Costs page should read **$0** and "This has cost you nothing" — it records
every provider call, including the free ones, so if it ever shows a number you
will know before a bill does.

---

## 7. Optional: paid writing

Everything above runs on the free providers and will keep doing so. This step is
the only one that can produce a bill, and it is two separate jobs.

**The operator's part, once, in the hosting environment.** These cannot be set
from the interface, on purpose — `ZERO_COST_MODE` is your promise that the
deployment cannot spend money, and a screen that could revoke it would make the
promise meaningless.

| Variable                          | Set to      | Why                                        |
| --------------------------------- | ----------- | ------------------------------------------ |
| `ZERO_COST_MODE`                  | `false`     | Permission for anything paid to run at all |
| `MAX_DAILY_PROVIDER_COST_CENTS`   | e.g. `100`  | The most it may spend in a day ($1.00)     |
| `MAX_MONTHLY_PROVIDER_COST_CENTS` | e.g. `1000` | And in a calendar month ($10.00)           |

Redeploy after changing them. With the mode off but both ceilings at zero,
nothing paid can run — the amount and the permission are deliberately separate
variables.

**The owner's part, in Settings, needing no redeploy.** Get an API key from
`console.anthropic.com` (it is prepaid credit, bought with a card), paste it into
the box under **Claude (paid)**, then press **Turn on** and set a daily limit.

Whoever supplies the key pays for it. Set `ANTHROPIC_API_KEY` in the environment
and you are paying for every workspace; leave it unset and each owner pastes
their own. A workspace's own key overrides the deployment's.

What it costs, at the default model and this engine's own size limits: roughly
2–4¢ each time it writes, so about 7¢ to take one product from analysis through
to ad copy. The per-call ceiling of 50¢ is far above anything it should produce;
if a call is ever refused for exceeding it, something is wrong, not expensive.

To undo any of it: remove the key, switch the provider off, lower a ceiling, or
set `ZERO_COST_MODE=true`. Any one of those is enough, and the application keeps
working on the free providers.

---

## What will go wrong first

Honest list, roughly in order of likelihood.

**A scan finds nothing on a real shop.** If the catalogue is rendered by
JavaScript in the browser, the scanner sees an empty page — it reads HTML and
does not run scripts. The Website page reports pages read and products found,
so this is visible rather than silent, but it is a genuine gap with no cheap
fix (headless Chromium costs real infrastructure).

**A scan comes back PARTIAL.** It hit `WORKER_MAX_RUN_MS`, a page limit or a
time limit. What it did read is accurate; there is simply more. Press it again.

**Rate limited while testing.** Ten scans per hour per business, ten logins per
fifteen minutes. Deliberate, and per-account rather than global.

**A migration is forgotten.** Deploying code whose schema has changed without
running `prisma migrate deploy` gives Prisma errors on the affected pages. CI
checks that migrations match the schema, but nothing yet runs them for you.

**A pasted key is rejected.** Anthropic's answer is reported as such — "would
not accept the key… nothing was charged" — rather than as a generic failure, and
the free writer keeps working meanwhile. The usual cause is a key copied with a
trailing space or line break, which is refused before it is ever stored.

## What this does not have yet

Named so nothing here reads as more finished than it is:

- **No password reset.** Losing a password means losing the account.
- **No email of any kind.** No verification, no notifications.
- **No backups beyond Neon's own.** Check what its free tier retains.
- **No error tracking.** Failures are in the logs and nowhere else.
- **No workspace switcher.** One workspace per account in the UI.
- **No ads.** Campaigns and Meta arrive in Phases 5 and 6. Today this reads
  websites and records what it finds.
