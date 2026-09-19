# AI Advertising Engine

A general-purpose, multi-tenant platform that takes a business website, builds a
structured understanding of the business and its products, develops advertising
strategy, generates and quality-checks creative, launches campaigns through an
advertising provider, collects performance data, and uses structured experiments
to improve what it generates next.

Nothing in the architecture is specific to an industry, product category, store
platform, or advertising network. Businesses are onboarded through the same
flow whatever they sell.

## Status

**Phase 1 of 10 is complete and verified.** See [docs/PHASES.md](docs/PHASES.md)
for the full plan and [docs/PHASE-1.md](docs/PHASE-1.md) for exactly what was
built, what was tested, and what is deliberately not built yet.

Phase 1 delivers the foundation: TypeScript in strict mode, PostgreSQL with
migrations, session authentication, the multi-tenant isolation layer, an audit
trail, the background-job schema, structured logging, the error taxonomy, and a
working UI shell. Website scanning, the AI engines, creative generation, and
Meta integration arrive in later phases.

## Quick start

Requires Node 20.11+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env          # then fill in the secrets it names
npm run db:migrate
npm run dev                   # http://localhost:3000
```

Generate the two required secrets with:

```bash
openssl rand -base64 48       # AUTH_SECRET
openssl rand -base64 32       # ENCRYPTION_KEY
```

## Verification

```bash
npm run verify                # format check, lint, typecheck, all tests
npm run test:unit             # no external services needed
npm run test:db               # needs PostgreSQL; uses .env.test
./scripts/smoke.sh            # end-to-end over HTTP, against a running dev server
```

`npm run test:db` and `scripts/smoke.sh` are the ones that matter for tenancy:
they prove over a real database and a real HTTP stack that one business's data
cannot be read or written from another's session.

## Mock mode

`MOCK_MODE=true` (the default outside production) makes every external
provider — AI, image generation, advertising platforms, and the crawler's
network layer — resolve to a deterministic in-process fake. The whole pipeline
is developed and tested this way, with no credentials and no ad spend.

The application refuses to start with `NODE_ENV=production` and mock mode on,
so a fake campaign can never be presented to a merchant as a real one. (The
`next build` step is exempt, because building is not serving.)

## Documentation

| Document                                     | Contents                                                         |
| -------------------------------------------- | ---------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layering, tenancy model, provider abstractions, security posture |
| [docs/SCHEMA.md](docs/SCHEMA.md)             | The full target database schema and which phase adds each table  |
| [docs/PHASES.md](docs/PHASES.md)             | The ten-phase plan and the definition of done                    |
| [docs/PHASE-1.md](docs/PHASE-1.md)           | Phase 1 report: what was built, what was verified, what remains  |

## Safety posture

Three things are structural rather than advisory:

- **Money.** Platform-wide spending ceilings come from environment
  configuration. A business can be configured to spend less, never more, and no
  automation level lets the AI raise them.
- **Tenancy.** Business-scoped data is reachable only through a capability
  object returned by a membership check. A cross-tenant reference is reported as
  404, never 403 — confirming that a record exists in someone else's workspace
  is itself a leak.
- **Truth.** Verified facts extracted from a merchant's own website and AI
  inferences are separate concepts in the data model and in the UI. An AI
  hypothesis is never rendered as a business fact.
