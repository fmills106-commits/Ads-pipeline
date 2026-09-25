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
   - the **pooled** one (host contains `-pooler`) → this is `DATABASE_URL`
   - the **direct** one (no `-pooler`) → used only for migrations

Pooled for the app, because a serverless function opens a connection per
invocation and would otherwise exhaust the server's limit. Direct for
migrations, because schema changes do not work through a transaction-mode
pooler.

Apply the schema from your machine, once:

```bash
DATABASE_URL="<the DIRECT string>" npx prisma migrate deploy
```

Re-run that same command after any future deploy that adds a migration.

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

Set these environment variables for **Production**:

| Variable            | Value                      |
| ------------------- | -------------------------- |
| `DATABASE_URL`      | the **pooled** Neon string |
| `AUTH_SECRET`       | generated above            |
| `ENCRYPTION_KEY`    | generated above            |
| `CRON_SECRET`       | generated above            |
| `APP_URL`           | `https://your-domain.com`  |
| `NODE_ENV`          | `production`               |
| `LOG_FORMAT`        | `json`                     |
| `TRUSTED_PROXY`     | `vercel`                   |
| `ZERO_COST_MODE`    | `true`                     |
| `WORKER_MAX_RUN_MS` | `50000`                    |

Notes on the two that are easy to get wrong:

- **`TRUSTED_PROXY=vercel`** is what makes per-IP rate limiting work. Left at
  `none`, every anonymous request shares one bucket — safe, but it means one
  visitor's failed logins count against everybody's.
- **`WORKER_MAX_RUN_MS`** must sit _below_ your plan's function timeout. Set it
  too high and an invocation is killed mid-crawl and the whole attempt is
  repeated; set correctly, a long crawl stops itself and reports what it did
  read. 50000 (50s) is a safe starting point on Hobby. Check your plan's actual
  limit in Vercel's docs and leave a margin.

The app refuses to start if `APP_URL` is not `https://`, if `CRON_SECRET` is
missing, or if `LOG_FORMAT` is `pretty` — deliberately, because each of those
fails silently and expensively otherwise.

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

`vercel.json` additionally declares a Vercel Cron entry for the same endpoint.
Whether it fires at the requested frequency depends on your plan — Vercel
limits cron frequency on Hobby — so the GitHub workflow is the dependable path
and the Vercel entry is a belt-and-braces extra. Two schedulers calling the
same endpoint is harmless: jobs are claimed with `FOR UPDATE SKIP LOCKED`, so
the second caller simply finds nothing to do.

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

## What this does not have yet

Named so nothing here reads as more finished than it is:

- **No password reset.** Losing a password means losing the account.
- **No email of any kind.** No verification, no notifications.
- **No backups beyond Neon's own.** Check what its free tier retains.
- **No error tracking.** Failures are in the logs and nowhere else.
- **No workspace switcher.** One workspace per account in the UI.
- **No ads.** Campaigns and Meta arrive in Phases 5 and 6. Today this reads
  websites and records what it finds.
