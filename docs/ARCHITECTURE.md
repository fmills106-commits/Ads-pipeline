# Architecture

## 1. Repository inspection (starting point)

The repository was empty at the start of this work: an initialised git repo with
no commits, no remote content, no framework, no package manager configuration,
no database, no authentication, and no existing integrations. There was nothing
to preserve and nothing to reuse, so the stack below was chosen rather than
inherited.

Environment available: Node 22.22, npm 10.9 / pnpm 10.33, PostgreSQL 16, Docker.

## 2. Stack

| Concern    | Choice                                            | Why                                                                                                                              |
| ---------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Framework  | Next.js 15 (App Router), React 19                 | Server components let tenant checks run server-side against the database on every render, rather than being trusted from a token |
| Language   | TypeScript, `strict` + `noUncheckedIndexedAccess` | The platform's job is to not get facts wrong; the type system is the cheapest place to enforce that                              |
| Database   | PostgreSQL 16                                     | `FOR UPDATE SKIP LOCKED` gives a job queue without a second datastore; JSONB holds provenance and AI payloads                    |
| ORM        | Prisma 6                                          | Generated types keep tenant filters honest at compile time; migrations are reviewable SQL                                        |
| Validation | Zod                                               | One schema language for environment, API bodies, and AI output — §64 needs all three                                             |
| Styling    | Tailwind CSS 4                                    | Design tokens in `@theme`, so light/dark and the status palette are defined once                                                 |
| Tests      | Vitest                                            | Two projects: `unit` (no services) and `db` (real PostgreSQL)                                                                    |
| Auth       | Database-backed sessions, scrypt                  | Revocation must be immediate; a stateless JWT cannot revoke a creative-approval session                                          |

Deliberately **not** added: Redis, a hosted queue, an auth SaaS, a component
library, an AI SDK, a native image library. Each would be a dependency carried
through ten phases to serve one, and several would pull in a paid service or a
build toolchain. The seams that let them in later are in place.

Before any third-party dependency: can this be done locally? Can open source do
it? Can it be simulated? Is the external service genuinely necessary? Where the
answer is no, the local implementation wins.

## 3. Layering

```
src/middleware.ts   Per-request CSP with a fresh nonce. The only code that runs
                    before routing, which is why the policy lives here.

src/app/            Next.js routes — thin. Pages resolve context; routes call services.
  (auth)/           Sign-in and registration
  (app)/            The authenticated shell
  api/              Route handlers, all wrapped by src/server/api/handler.ts

src/server/         All logic that touches the database or an external system.
  api/              The single route wrapper: validation, auth, rate limiting,
                    logging, error mapping. Plus the proxy-trust decision.
  auth/             Password hashing, sessions, registration and login
  tenancy/          Tenant context and the access guards
  business/         Business CRUD, onboarding, pause-everything
  providers/        Registry, the run guard, and the local implementations
  cost/             Cost ledger, ceilings, hard stops
  activity/         The owner-facing plain-language feed
  audit/            The append-only technical audit trail
  jobs/             The queue (claim, retry, dead-letter) and the worker loop
  scanner/          Crawl, extract, persist — the website scanner

src/lib/            Pure, dependency-light modules usable from anywhere.
  env.ts            Zod-validated configuration — nothing else reads process.env
  logger.ts         Structured JSON logging with redaction
  errors.ts         The error taxonomy
  crypto.ts         AES-256-GCM for OAuth tokens at rest
  retry.ts          Bounded exponential backoff with full jitter
  budget.ts         Stated budget -> derived internal limits. Pure.
  net-safety.ts     URL/IP classification and both SSRF gates. Pure.
  db.ts, id.ts, slug.ts

src/components/     Presentational only. No data access.
```

The rule that keeps this honest: **`src/app` never queries the database
directly.** A page resolves a tenant context and calls a service. A service
takes that context, not a raw id.

## 4. Tenancy

This is the part most worth reading.

```
User ──< WorkspaceMembership >── Workspace ──< Business ──< (everything else)
```

A user may belong to several workspaces; a workspace owns several businesses.
`Business` is the isolation boundary for advertising data — knowledge, creatives,
campaigns, experiments and everything learned from performance.

The enforcement mechanism is a **capability object**:

```ts
const context = await requireBusinessContext(user, businessId);
const products = await prisma.product.findMany({ where: scopedToBusiness(context) });
```

`BusinessContext` carries a private brand symbol, so it cannot be constructed
outside `src/server/tenancy/context.ts`. The only way to obtain one is through a
function that has already checked membership against the database. Services take
the context rather than a `businessId: string`, which means "forgot to filter by
tenant" does not typecheck.

Two further rules:

- Membership is checked against the business's **actual** `workspaceId`, read
  from the row — never against a workspace id the caller supplied. Passing
  Workspace A's id cannot reach Business B.
- A cross-tenant reference returns **404, not 403**. A 403 would confirm the
  record exists. `TENANT_MISMATCH` maps to 404 with the same public message as a
  genuine miss, and `tests/db/tenancy.test.ts` asserts the two are
  indistinguishable.

## 5. Provider abstractions

Every capability that could cost money sits behind an interface with at least
one **local, free implementation**, and nothing calls an implementation
directly — calls go through `runProvider`, which selects, checks cost ceilings,
falls back to free, and records the cost.

| Capability       | Free (default)          | Paid alternative                   |
| ---------------- | ----------------------- | ---------------------------------- |
| Web fetch        | `webfetch.local`        | a scraping service, if ever needed |
| AI               | `ai.local`              | `ai.anthropic` (Phase 3)           |
| Image generation | `image.local`           | `image.external` (Phase 4)         |
| Advertising      | `advertising.simulated` | `advertising.meta` (Phase 6)       |
| Storage          | `storage.local`         | `storage.s3` (Phase 4)             |

Reaching a paid provider requires three independent switches — zero-cost mode
off, a non-zero cost ceiling, and that provider enabled for the workspace — so
no single misconfiguration can start a bill. A capability with no free provider
registered raises at selection time; it would silently break the guarantee that
the application works with every external service disabled.

The full design, and the tests that hold it in place, are in
[ZERO-COST.md](ZERO-COST.md).

## 6. Background jobs

Long work — crawling, image generation, campaign sync, learning analysis — runs
as rows in the `jobs` table, claimed with `SELECT … FOR UPDATE SKIP LOCKED`.
The table shipped in Phase 1; the queue and worker that drive it shipped in
Phase 2 with the website scan, its first job type.

Each job carries `attempts`, `maxAttempts`, `runAt`, `lastError`, and an
optional unique `idempotencyKey` so a webhook redelivery or a double-clicked
button does not duplicate work. Retries use `withRetry` from `src/lib/retry.ts`:
exponential growth with **full jitter**, so a batch of jobs that failed together
does not retry together. `maxAttempts` is a required parameter, which makes
"retry forever" inexpressible.

Jobs are tenant-scoped (`workspaceId`, optional `businessId`) so a worker's logs
and failures attribute to the right business. A job has no tenancy shortcut: it
rebuilds a `BusinessContext` through `requireBusinessContext`, the same
membership check every request passes.

Payloads are Zod-validated at **enqueue** time rather than in the worker, so a
malformed payload fails at the button press where someone can see it instead of
dead-lettering an hour later. `scripts/worker.ts` runs the loop standalone;
`kickQueue` also drains in-process, so development needs no second terminal.

## 7. Reading the outside world

`src/server/scanner/` turns a website address into knowledge. Three ideas carry
most of the weight.

**Provenance is mandatory, not decorative.** A fact row cannot be written
without a source URL, an extraction method and a confidence score — the columns
are non-null and there is no code path that fabricates them. Verified facts
(`business_facts`, `product_facts`) live in different tables from anything a
model produces, and there is no operation that promotes an inference into them.

**Strategies compete; nothing is averaged.** Four extractors run on every page
and the highest-confidence candidate per field wins outright:

```
JSON_LD > MICRODATA > OPENGRAPH > HTML > TEXT_PATTERN
```

The order is a claim about intent: schema.org JSON-LD is something a merchant
published deliberately, a regex over visible text is a guess. Averaging two
disagreeing readings of a price would produce a number neither source states.

**Refusing beats guessing.** `1,299` could be twelve hundred or one and a
bit, depending on where you are, so `parsePriceNumber` returns `null` rather
than picking. `costCents` stays empty unless a merchant typed it in. A crawl
that hit a page limit never concludes a product was removed. A crawl that read
nothing reports `unreachable` and fails, rather than presenting an empty site.

Everything the scanner reads is a stranger's text: bounded, sanitised, stored
as data, and shown with the URL it came from.

## 8. Error handling

Every failure crossing a module boundary is an `AppError` carrying:

- a stable `code` from a closed union, for logs and for the UI;
- a `status`, so route handlers contain no mapping logic;
- `retryable`, which the job runner uses to choose backoff or dead-lettering — a
  rate limit is worth repeating, a 401 is not;
- a `publicMessage` kept separate from the internal `message`, so provider
  responses and stack detail never reach a browser.

`toAppError` normalises anything thrown, preserving the original as `cause`.

## 9. Security posture

**Secrets.** OAuth tokens are encrypted at rest with AES-256-GCM
(`src/lib/crypto.ts`), version-tagged for rotation, and bound to their context
with additional authenticated data — a token row copied to another integration
fails to decrypt rather than silently working. Application secrets come from the
environment and are validated at boot.

**Sessions.** The cookie holds a 32-byte random token; the database stores an
HMAC of it keyed with `AUTH_SECRET`. A database snapshot yields no usable
sessions. Cookies are `httpOnly`, `sameSite=lax`, and `secure` whenever
`APP_URL` is HTTPS.

**Passwords.** scrypt at N=2¹⁷, r=8, p=1, with parameters stored inside the hash
so they can be raised later without invalidating anyone. Length is bounded at
both ends — unbounded input into a memory-hard KDF is a denial-of-service
vector. Login runs a dummy verification for unknown emails so timing does not
reveal which addresses are registered.

**SSRF.** The platform is _designed_ to fetch arbitrary user-supplied URLs,
which makes this the highest-risk surface. Two gates, both in
`src/lib/net-safety.ts`:

1. `assertSafePublicUrl` rejects private, loopback, link-local (including
   `169.254.169.254`), CGNAT, multicast and internal-TLD targets, plus
   non-HTTP schemes, embedded credentials and non-standard ports, at the moment
   a URL is supplied.
2. `assertResolvedAddressesArePublic` classifies the **resolved** addresses
   immediately before connecting, and every one of them must be public. DNS can
   point a public hostname at a private address, and one private `A` record is
   enough to refuse.

Redirects are followed manually, one hop at a time, so both gates re-run on
every hop — `fetch`'s own redirect following would check the first URL and then
connect wherever it was sent.

Gate 1 classifies the host by **numeric address**, not by string shape. An
earlier version matched only dotted quads, which let `http://2130706433/`,
`http://0x7f000001/`, `http://127.1/`, `http://017700000001/` and
`http://[::ffff:127.0.0.1]/` through — all of them `127.0.0.1`. Those five are
now named regression tests.

The only exemption is `UrlPolicy { allowedPrivateHosts }`, a **function
argument with no configuration path**, so a test can reach a fixture on
loopback without any deployment being able to turn the guard off.

**Rate limiting.** Fixed windows counted in Postgres (`rate_limits`), because a
serverless deployment shares no memory between invocations and Redis would be a
second datastore — a paid one — to serve one table. Counting happens in a single
`INSERT … ON CONFLICT DO UPDATE`, so two concurrent requests cannot both read
the same count and both decide they are under the limit. Limits are per account
where a session exists and per address otherwise: 10 logins per 15 minutes, 5
registrations per hour, 10 scans per hour per business (that one protects the
merchant's server as much as ours), and a 300/minute backstop on everything
else. The limiter fails **open** on a database error and logs loudly — losing
one control beats refusing every request — and that is the only place in the
codebase where that trade is made.

**Which address to believe.** `TRUSTED_PROXY` names the reverse proxy in front
of the deployment, and only that proxy's header is read: `CF-Connecting-IP` for
Cloudflare, `X-Real-IP` for Vercel. Trust is configured, never detected,
because `X-Forwarded-For` arrives from the open internet and anyone can set it
— a limiter keyed on it would be defeated by rotating a header. The default,
`none`, reads no proxy header at all and counts every anonymous caller
together: blunt, and the safe failure.

**Content-Security-Policy.** Set in middleware with a per-request nonce, since
Next.js injects inline bootstrap scripts and a static policy could only permit
them with `unsafe-inline`. `script-src` gets the strict treatment — a nonce
plus `strict-dynamic`, no host allow-list to bypass — because this application
stores arbitrary text scraped from strangers' sites, which is exactly the input
that turns a rendering bug into account takeover. `connect-src 'self'` matters
as much: a successful injection still has nowhere to send what it read.
`style-src` keeps `'unsafe-inline'`, because React sets style attributes and
inline CSS is a far smaller problem than inline script; shipping a policy so
strict it broke the app would be worse than shipping an honest one.

**Logging.** The logger redacts any key matching a secret pattern at any nesting
depth, truncates long strings, and bounds recursion depth — scraped page text is
unbounded and may be adversarial.

**Prompt injection.** Website content is data, never instruction. The defence
(`src/server/scanner/untrusted.ts`) is **structural, not filtering**: untrusted
text is passed as a separate named parameter from the instruction, wrapped in a
random per-call delimiter the content cannot guess and so cannot close, with
control, zero-width and bidirectional-override characters neutralised and length
bounded. Text that resembles an instruction is flagged and **passed through** —
"ignore the noise" is legitimate product copy, and a filter would lose real
information while stopping a determined attacker not at all. All model output is
validated against a Zod schema before anything downstream consumes it.

## 10. Configuration

`src/lib/env.ts` is the only module that reads `process.env`. It validates
everything once, eagerly, and fails at startup with every problem listed — not
with an `undefined` surfacing three layers deep later. It also enforces
cross-field rules: a live AI provider requires a key, mock mode is refused when
serving production traffic, and the daily budget ceiling cannot exceed the
campaign ceiling.

## 11. Conventions

- Money is stored as integer minor units with an ISO-4217 code. No floats near a
  budget.
- Tenant-scoped tables carry an indexed, non-null `businessId` or `workspaceId`.
- Deletes cascade down the ownership tree, except `AuditLog.actorId`, which is
  `SET NULL` — the record of what happened outlives the account that did it.
- Historical data is versioned, never overwritten. Prices, product facts and
  performance snapshots accumulate.
- API responses are `{ data }` or `{ error: { code, message } }`, always with an
  `x-request-id` header.

## 12. Running it somewhere

The application needs a Node runtime with DNS, `node:crypto`'s `scrypt`, and
outbound sockets. That rules out Cloudflare Workers — there is no DNS API
there, and the scanner's post-DNS SSRF gate cannot be written without one, so
deploying to Workers would mean deleting a security control rather than porting
it. [DEPLOY.md](DEPLOY.md) has the details and the recommended combination.

**Background work is the part that needs a decision.** A queued scan does
nothing until something runs it, and there are two shapes:

| Shape              | How                                       | Latency           | Where                        |
| ------------------ | ----------------------------------------- | ----------------- | ---------------------------- |
| Long-lived process | `npm run worker`                          | ~2s               | Container, VPS, Fly.io       |
| Scheduled drain    | `GET /api/cron/worker` with `CRON_SECRET` | schedule interval | Vercel + GitHub Actions cron |

The scheduled path is what makes a serverless deployment work at all, and it
carries one constraint worth stating plainly: `WORKER_MAX_RUN_MS` must be below
the platform's function timeout. The crawl derives its own ceiling from it and
stops itself, so a scan that runs out of time reports `PARTIAL` with the pages
it did read. Set it too high and the invocation is killed mid-crawl instead,
and the whole attempt is repeated on the next schedule — the same work, twice,
forever.

The same endpoint owns the housekeeping that nothing else was calling: expired
sessions and spent rate-limit counters. Both leak rows rather than break
anything, which is precisely why they needed a scheduled owner rather than a
place in a hot path.
