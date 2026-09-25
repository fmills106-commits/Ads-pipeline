# AI Advertising Engine

Give it your website. It learns what you sell, works out how to advertise it,
creates the ads, runs them, measures what happened, and improves what it makes
next.

For the business owner that is four questions and a dashboard. Underneath it is
a multi-tenant platform with provider abstraction, structured experiments,
creative QA, cost ceilings and an audit trail — none of which they ever
configure.

Nothing in the architecture is specific to an industry, product category, store
platform, or advertising network.

## It costs nothing to run

No API key. No hosted service. No subscription. No credit card. A local
PostgreSQL is the only thing required, and that is free too.

Every capability that _could_ cost money — AI, image generation, advertising,
storage — has a local implementation that is used by default. Paid services are
optional upgrades, and reaching one needs **three independent switches** all
set. Defaults on a fresh clone: zero-cost mode **on**, cost ceilings **$0.00**,
every paid provider **off**.

See [docs/ZERO-COST.md](docs/ZERO-COST.md).

## Status

**Phases 1–3 complete and verified** — the foundation, the zero-cost
provider architecture, the simplified interface, and the website scanner. See
[docs/PHASES.md](docs/PHASES.md) for the plan, and the
[Phase 1](docs/PHASE-1.md) and [Phase 2](docs/PHASE-2.md) reports for what was
built and tested.

Point it at a website today and it will read the pages, find the products, and
record the prices, offers and contact details — each fact carrying the URL it
came from and how it was extracted. It has been run against real shops, both
with and without structured data; doing that found four extraction bugs no
fixture had caught, all fixed and covered by tests.

It also reads that back: what the business seems to sell, who might want it,
ways to advertise each product, suggested offers, and ad text — with every
conclusion badged as a conclusion, and every claim checked against what the
site actually says. That runs on the free built-in generator today, which
marks its own output as a placeholder rather than passing it off as advice.

Creative generation and Meta integration arrive in Phases 4–6. The seams they
plug into exist now, each with its free implementation already in place.

## Quick start

Requires Node 20.11+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env          # fill in the two generated secrets it names
npm run db:migrate
npm run dev                   # http://localhost:3000
npm run worker                # optional: background jobs in their own process
```

```bash
openssl rand -base64 48       # AUTH_SECRET
openssl rand -base64 32       # ENCRYPTION_KEY
```

That is the whole setup. Register, answer four questions, and the dashboard is
live — running entirely on local providers. The worker is optional in
development: the dev server drains the queue in-process, so pressing "Read my
website" works without it.

## Putting it online

It runs on free tiers — Vercel for the app, Neon for Postgres, GitHub Actions
for CI and for draining the job queue. The only real cost is the domain, about
$10–15 a year at Cloudflare Registrar. No credit card is needed for the rest.

One step in [docs/DEPLOY.md](docs/DEPLOY.md) is easy to skip and breaks
everything quietly: **something has to drive the job queue.** A serverless host
has nowhere to keep a worker process, so a queued scan sits untouched and the
app looks broken while being perfectly healthy. The repository ships a GitHub
Actions workflow that handles it; it needs two values set.

Cloudflare Workers is not an option for the app itself, and the reason is
worth knowing: Workers have no DNS API, and the scanner's second SSRF gate
resolves a hostname and inspects every address behind it before opening a
socket. Porting to Workers would mean deleting that check.

## Verification

```bash
npm run verify                # format, lint, typecheck, all tests
npm run test:unit             # no external services needed
npm run test:db               # needs PostgreSQL; uses .env.test
./scripts/smoke.sh            # end-to-end over HTTP, against a running dev server
```

GitHub Actions runs `verify` plus a production build on every push, against a
real PostgreSQL service, and checks that the migrations still match
`schema.prisma`.

The suite runs at $0 by construction — `.env.test` holds no credential for any
paid service.

## Documentation

| Document                                     | Contents                                                          |
| -------------------------------------------- | ----------------------------------------------------------------- |
| [docs/ZERO-COST.md](docs/ZERO-COST.md)       | How $0 operation is enforced rather than promised                 |
| [docs/UX.md](docs/UX.md)                     | The four-question setup, three automation modes, activity feed    |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layering, tenancy, providers, security posture                    |
| [docs/SCHEMA.md](docs/SCHEMA.md)             | Full target database schema, phase by phase                       |
| [docs/PHASES.md](docs/PHASES.md)             | The ten-phase plan and the definition of done                     |
| [docs/PHASE-1.md](docs/PHASE-1.md)           | Phase 1 report: built, verified, and what remains                 |
| [docs/PHASE-2.md](docs/PHASE-2.md)           | Phase 2 report: the website scanner, and the SSRF bypass it fixed |
| [docs/PHASE-3.md](docs/PHASE-3.md)           | Phase 3 report: the marketing engine and the claim checker        |
| [docs/DEPLOY.md](docs/DEPLOY.md)             | Putting it on a domain: Neon, Vercel, Cloudflare, and the worker  |

## What is structural, not advisory

**Money.** Spending requires three independent switches. Advertising budgets
are the lower of what the owner stated and what the deployment permits, and no
automation level lets the AI raise either. A budget above the ceiling is
refused with an explanation rather than silently capped.

**Tenancy.** Business-scoped data is reachable only through a capability object
returned by a membership check — a missing tenant filter does not typecheck. A
cross-tenant reference returns 404, never 403: confirming a record exists in
someone else's workspace is itself a leak.

**Truth.** Verified facts scraped from a merchant's own site and AI inferences
are separate tables with separate UI treatment. A fact row cannot be written
without the URL it came from — the column is non-null. Simulated campaigns and
simulated metrics carry `isReal: false` in the return type, not as a
convention. An AI hypothesis is never rendered as a business fact. Where the
scanner cannot tell (`1,299` — twelve hundred, or one and a bit?) it records
nothing rather than guessing.

**Fetching.** The scanner's job is to fetch URLs strangers supply, so every URL
passes two gates: one on the address as written, one on the address DNS
actually resolved to, both re-run on every redirect hop. The only exemption is
a function argument with no configuration path, so no deployment can switch the
guard off.

**Stopping.** One button pauses everything, with no confirmation dialog in the
way. The flag lives on the business, so it stops work that has not been created
yet — a background job checks it before doing anything.
