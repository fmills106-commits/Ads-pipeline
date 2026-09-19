# Phase 1 report — Foundation

**Status: complete and verified.**

Covers Phase 1 and the Phase 1.5 rework that followed it: the zero-cost
provider architecture ([ZERO-COST.md](ZERO-COST.md)) and the simplified
interface ([UX.md](UX.md)). Both changed the foundation, so they were done
before Phase 2 built on top rather than retrofitted afterwards.

---

## 0. Repository inspection

Requested before any code was written, so: the repository was an initialised git
repo on branch `claude/ai-advertising-engine-spec-g9zx9r` with **no commits, no
remote content, and no files**.

| Question                   | Finding                 |
| -------------------------- | ----------------------- |
| Current architecture       | None — empty repository |
| Existing technology        | None                    |
| Existing files             | None                    |
| Existing functionality     | None                    |
| Existing authentication    | None                    |
| Existing UI components     | None                    |
| Deployment configuration   | None                    |
| Environment conventions    | None                    |
| Existing APIs/integrations | None                    |
| Anything reusable          | Nothing                 |

Available in the environment: Node 22.22, npm 10.9, pnpm 10.33, PostgreSQL 16
(installed, started for this work), Docker.

So there was nothing to preserve and the stack was chosen, not inherited. The
choices and their reasons are in [ARCHITECTURE.md](ARCHITECTURE.md#2-stack).

---

## 1. What was built

### Configuration

`src/lib/env.ts` — the only module that reads `process.env`. Validates
everything once with Zod, fails at startup listing _every_ problem, and enforces
cross-field rules: a live AI provider requires a key; the daily budget ceiling
cannot exceed the campaign ceiling; mock mode is refused when serving production
traffic. `.env.example` documents the full variable surface, grouped by the
phase that first needs each one.

### Logging

`src/lib/logger.ts` — dependency-free structured JSON logging with child loggers
that carry tenant context. Redacts any key matching a secret pattern at any
nesting depth, truncates long strings, and bounds recursion. This matters
because the process will handle live ad-account tokens and unbounded,
potentially adversarial scraped page text.

### Errors

`src/lib/errors.ts` — a closed union of error codes, each mapping to an HTTP
status, a retryability flag the job runner uses, and a public message kept
separate from the internal one. `TENANT_MISMATCH` maps to **404**, not 403.

### Retry

`src/lib/retry.ts` — exponential backoff with **full jitter**, so a batch of
jobs that failed together does not retry together. `maxAttempts` is a required
parameter, which makes "retry forever" inexpressible.

### Secrets

`src/lib/crypto.ts` — AES-256-GCM, version-tagged for key rotation, optionally
AAD-bound to a context string so a token row copied elsewhere fails to decrypt
rather than silently working. Built now because Phase 6 will store Meta tokens
that can spend real money.

### Database

Seven tables migrated: `users`, `sessions`, `workspaces`,
`workspace_memberships`, `businesses`, `audit_logs`, `jobs`. The full target
schema — 30+ tables across all ten phases — is specified in
[SCHEMA.md](SCHEMA.md) and migrated phase by phase, so each migration ships with
the code that justifies it.

### Authentication

scrypt at N=2¹⁷ with parameters stored in the hash, bounded input length,
Unicode normalisation, and constant-time comparison. Sessions are database-
backed: the cookie holds a random token, the database stores an HMAC of it, so a
database snapshot yields no usable sessions and revocation is immediate. Login
runs a dummy verification for unknown emails so timing does not reveal which
addresses are registered.

### Tenancy

`src/server/tenancy/context.ts` — the isolation layer. A branded capability
object that cannot be constructed outside the module; the only way to get one is
through a function that has already checked membership against the database.
Services take that object, not a `businessId: string`, so missing a tenant
filter does not typecheck. Membership is checked against the business's actual
`workspaceId` read from the row, never one the caller supplied.

### Auditing

Append-only, with `actorType` distinguishing `USER`, `SYSTEM` and `AI` — the
column that makes the log worth keeping once automation is doing things. Never
throws: an audit failure must not roll back the action that succeeded.
`AuditLog.actorId` is `SET NULL` on user deletion, so the record outlives the
account.

### SSRF guard

`assertSafePublicUrl` rejects private, loopback, link-local (including
`169.254.169.254`), CGNAT, multicast and internal-TLD targets at the moment a
user supplies a URL. This is gate one of two; the crawler re-validates the
resolved IP before connecting in Phase 2.

### API layer

One route wrapper (`src/server/api/handler.ts`) handling request id, structured
logging, Zod body validation, authentication, and error-to-status mapping — so
route handlers contain only their own logic and the conventions in §41 are
enforced rather than merely documented. Six endpoints: health, register, login,
logout, workspaces, businesses.

### UI

Sign-in, registration, the authenticated shell with the full §26 navigation,
dashboard, businesses (list + add), and settings. Navigation sections whose
phase has not shipped are shown disabled with their phase number — the shape of
the finished product, honestly labelled.

The `Provenance` primitive (verified fact vs AI inference) is built now rather
than later, so every screen from Phase 3 onward has one way to express that
distinction and an AI hypothesis can never be styled like a scraped fact.

---

## 2. Verification

Every claim below was produced by running the command, not by inspection.

### Tests — 231 passing

```
Test Files  16 passed (16)
     Tests  231 passed (231)
```

| Suite             | Tests | Covers                                                                               |
| ----------------- | ----- | ------------------------------------------------------------------------------------ |
| `unit/env`        | 13    | Defaults, every rejection path, cross-field rules, build-phase exemption             |
| `unit/logger`     | 10    | Levels, child bindings, redaction (nested, arrays, errors), truncation, cycle safety |
| `unit/errors`     | 10    | Status mapping, retryability, public/internal separation, 404-not-403                |
| `unit/password`   | 16    | Round-trip, salting, Unicode, length bounds, 7 malformed-hash cases                  |
| `unit/crypto`     | 11    | Round-trip, nonce uniqueness, tamper detection, AAD binding                          |
| `unit/retry`      | 12    | Backoff growth, clamping, jitter, bounded attempts, predicates                       |
| `unit/url-safety` | 10    | Every private range, metadata endpoint, IPv6, adjacent-public non-regression         |
| `unit/slug`       | 6     | Diacritics, apostrophes, truncation                                                  |
| `db/auth`         | 19    | Registration, workspace creation, login, 11 session lifecycle cases                  |
| `db/tenancy`      | 22    | **Cross-tenant isolation**, roles, archival, multi-business users                    |
| `db/business`     | 14    | Defaults, allow-listed updates, SSRF rejection, audit, cascades                      |

The database tests run against real PostgreSQL. The setup refuses to run unless
the database name contains "test", because the suite truncates every table.

### Tenant isolation specifically

`tests/db/tenancy.test.ts` uses two deliberately unrelated tenants — a coffee
roaster and a marine supplier — and asserts that tenant A cannot open, list, or
update tenant B's business; that the refusal is a 404; and that it is
**indistinguishable** from a business that does not exist at all.

### Typecheck and lint

```
$ npx tsc --noEmit     # clean
$ npx eslint .         # clean
$ npx prettier --check # clean
```

`strict` plus `noUncheckedIndexedAccess`, `noImplicitOverride`, and
`noFallthroughCasesInSwitch`. `@typescript-eslint/no-explicit-any` is an error.

### Migration

```
$ npx prisma migrate deploy
Applying migration `20260919181516_phase1_identity_tenancy_audit_jobs`
$ psql -c '\dt'   # 7 tables + _prisma_migrations
```

### Production build

```
✓ Compiled successfully in 3.3s
✓ Generating static pages (14/14)
12 routes, 103 kB shared JS
```

### End-to-end over HTTP — 23 checks

`./scripts/smoke.sh` against a running server. All passed:

```
✓ health reports database up
✓ running in zero-cost mode — nothing can be charged
✓ registered tenant A / tenant B
✓ duplicate email rejected (409)
✓ weak password rejected (400)
✓ anonymous request refused (401)
✓ tenant A owns workspace … / tenant B owns workspace …
✓ created business A at automation Level 1
✓ created business B in an unrelated industry
✓ cloud metadata URL rejected (400)
✓ tenant A sees only its own businesses
✓ cross-tenant read refused as 404 (not 403 — existence is not confirmed)
✓ cross-tenant write refused as 404
✓ tenant B's data was not modified
✓ completed setup: goal, $10/day budget, Autopilot
✓ $300/month derived to $9.67/day (rounds down, never over)
✓ budget above the ceiling refused with an explanation, not capped
✓ PAUSE EVERYTHING stops the business
✓ resume restarts it
✓ cannot pause another tenant's business
✓ session revoked immediately on sign-out
```

### UI

Verified by request against a running server: `/` redirects to `/login` when
anonymous; `/dashboard` redirects to `/login` when anonymous; `/login` and
`/register` render; `/dashboard` and `/businesses` render for an authenticated
user with the correct empty states.

### Running at $0, confirmed

The health endpoint reports `zeroCostMode: true`, Settings shows every
capability as `Local / free`, and the Costs page reports **$0.00** with the
count of free operations. No credential for any paid service exists in the
test environment or in `.env.test`.

An earlier guard refused to _serve_ in production while using simulated
providers. That was removed: a self-hosted install running entirely on free
providers is exactly what this product is meant to allow. What replaced it is
labelling — simulated results carry `isReal: false` in the return type, and the
dashboard shows a simulation banner — so honesty is preserved without blocking
the free deployment.

### A bug the tests caught

`parseBudgetToCents` stripped commas indiscriminately, so `10,5` — how much of
the world writes ten and a half — parsed as `$105`. A plausible typo became a
tenfold overspend. Now a comma is accepted only as a genuine thousands
separator, and ambiguous input is refused rather than guessed.

## 3. What is deliberately not built

Named explicitly so nothing here reads as working when it is not.

**No external integration has been tested against a live service, because none
has been written.** The AI, image, advertising and storage _interfaces_ exist
and each has a working free implementation. The paid implementations are
registered so Settings can list them honestly as available-but-off, and calling
one raises a clear error rather than pretending to work. They arrive in Phases
3, 4 and 6.

| Not built                                                                | Phase |
| ------------------------------------------------------------------------ | ----- |
| Website crawler, sitemap discovery, product extraction, facts            | 2     |
| Job worker loop (the `jobs` table and schema exist; nothing consumes it) | 2     |
| Resolved-IP SSRF re-validation (gate two)                                | 2     |
| AI provider, strategies, offers, ad copy, prompt-injection delimiting    | 3     |
| Creative generation, QA, versioning, approval                            | 4     |
| Campaign builder, budget enforcement, emergency pause                    | 5     |
| Meta OAuth and Marketing API                                             | 6     |
| Performance sync, real dashboard metrics                                 | 7     |
| Experiments                                                              | 8     |
| Learning engine                                                          | 9     |
| Automation rules, cost tracking                                          | 10    |

Known gaps within Phase 1's own scope, to close as the surfaces that need them
arrive:

- **Content-Security-Policy** is not set. It needs a per-request nonce, which
  belongs in middleware alongside the rest of the request pipeline — Phase 2.
- **Rate limiting** is not implemented. It is needed on login and on the
  expensive generation endpoints; the first of those exists in Phase 3.
- **Workspace switching** — the UI uses the user's first workspace. The data
  model and the API already support many; the picker is UI work for Phase 2.
- **Enabling a paid provider has no UI yet.** `provider_settings` and the
  selection logic are in place and tested; the toggle is deferred until there
  is a paid provider worth enabling (Phase 3).
- **Simulated ads and results pages** are placeholders in the navigation until
  Phases 4 and 7 fill them.
- **Password reset and email verification** are not built. No mail transport is
  configured, and adding one before there is anything to send would be
  speculative.
- Prisma warns that `package.json#prisma` is deprecated in favour of
  `prisma.config.ts`. Cosmetic on Prisma 6; migrating it changes `.env` loading
  semantics, so it is deferred rather than done hastily.

---

## 4. Next

Phase 2 — business onboarding: the website scanner, sitemap discovery,
multi-strategy extraction, structured facts with URL-level provenance, product
discovery, and the job worker loop.

The exit criterion is the one from §54: two materially different real websites
onboarded through the same normal flow, proving the engine is not shaped around
either of them.
