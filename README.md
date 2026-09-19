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

**Phase 1 complete and verified**, plus the zero-cost provider architecture and
the simplified interface. See [docs/PHASES.md](docs/PHASES.md) for the plan and
[docs/PHASE-1.md](docs/PHASE-1.md) for what was built and tested.

Website scanning, the AI marketing engine, creative generation and Meta
integration arrive in Phases 2–6. The seams they plug into exist now, each with
its free implementation already in place.

## Quick start

Requires Node 20.11+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env          # fill in the two generated secrets it names
npm run db:migrate
npm run dev                   # http://localhost:3000
```

```bash
openssl rand -base64 48       # AUTH_SECRET
openssl rand -base64 32       # ENCRYPTION_KEY
```

That is the whole setup. Register, answer four questions, and the dashboard is
live — running entirely on local providers.

## Verification

```bash
npm run verify                # format, lint, typecheck, all tests
npm run test:unit             # no external services needed
npm run test:db               # needs PostgreSQL; uses .env.test
./scripts/smoke.sh            # end-to-end over HTTP, against a running dev server
```

The suite runs at $0 by construction — `.env.test` holds no credential for any
paid service.

## Documentation

| Document                                     | Contents                                                       |
| -------------------------------------------- | -------------------------------------------------------------- |
| [docs/ZERO-COST.md](docs/ZERO-COST.md)       | How $0 operation is enforced rather than promised              |
| [docs/UX.md](docs/UX.md)                     | The four-question setup, three automation modes, activity feed |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layering, tenancy, providers, security posture                 |
| [docs/SCHEMA.md](docs/SCHEMA.md)             | Full target database schema, phase by phase                    |
| [docs/PHASES.md](docs/PHASES.md)             | The ten-phase plan and the definition of done                  |
| [docs/PHASE-1.md](docs/PHASE-1.md)           | Phase 1 report: built, verified, and what remains              |

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
are separate tables with separate UI treatment. Simulated campaigns and
simulated metrics carry `isReal: false` in the return type, not as a
convention. An AI hypothesis is never rendered as a business fact.

**Stopping.** One button pauses everything, with no confirmation dialog in the
way. The flag lives on the business, so it stops work that has not been created
yet — a background job checks it before doing anything.
