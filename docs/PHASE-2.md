# Phase 2 report — Website scanner

**Status: complete and verified.**

The platform's first contact with the outside world. A business owner gives a
website address; this phase turns it into pages, products, prices and facts,
each one traceable to the URL it came from.

---

## 0. Existing architecture, and what was reused

The instruction was to inspect Phase 1 and build on it rather than replace it.
What was already there and got used as-is:

| Phase 1 component                   | How Phase 2 uses it                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `BusinessContext` capability object | Every scanner service takes a context, never a `businessId` string                                 |
| `jobs` table (schema only, no code) | The queue and worker code was written against the existing table; no schema change needed          |
| Provider registry + `runProvider`   | The fetcher registers as `webfetch.local`; the scan job is the **first** real `runProvider` caller |
| `cost_records`                      | Every scan writes a cost row, at zero — free calls are recorded too                                |
| `activity_events` / `audit_logs`    | Plain-language feed and technical trail, both written by the scan job                              |
| `assertSafePublicUrl`               | Kept, hardened (see §4), and joined by a second post-DNS gate                                      |
| `AppError` taxonomy, `retryable`    | Drives the queue's retry-vs-dead-letter decision with no new mechanism                             |
| Pause-everything                    | Checked before queueing **and** between pages mid-crawl                                            |

One new runtime dependency: `node-html-parser`. Weighed against the local-first
rule — an HTML parser is not something to hand-roll, and the alternatives
(`jsdom`, headless Chromium) are an order of magnitude heavier for a job that
never needs to execute JavaScript.

Nothing from Phase 1 was rewritten. One thing was **deleted**:
`tests/unit/url-safety.test.ts`, superseded by the much larger
`tests/unit/net-safety.test.ts`.

---

## 1. What was built

### The fetcher — `src/server/providers/local/web-fetch.ts`

A free, local HTTP client registered as `webfetch.local` under a new
`WEB_FETCH` capability. Redirects are followed **manually**, one hop at a time,
so both SSRF gates re-run on every hop — `fetch`'s own redirect following would
validate the first URL and then connect wherever it was sent. Bodies stream
against a byte ceiling and stop reading when it is reached, rather than
buffering a response and checking its size afterwards. Content types outside an
allow-list are never downloaded at all. Timeouts are enforced with
`AbortController`.

### The job queue — `src/server/jobs/`

`SELECT … FOR UPDATE SKIP LOCKED`, so two workers cannot claim one job. Payloads
are Zod-validated at **enqueue** time, not in the worker — a malformed payload
fails at the button press where someone can see it, instead of dead-lettering
later. An optional unique `idempotencyKey` makes a double-clicked button a
no-op, including under a genuine concurrent race (the `P2002` path returns the
existing row). Stalled jobs past a ten-minute lease are reclaimed. Backoff is
exponential with jitter; a non-retryable `AppError` dead-letters immediately.

`scripts/worker.ts` runs the loop standalone; `kickQueue` also drains
best-effort in-process, so a development server processes scans without a second
terminal.

### Robots — `src/server/scanner/robots.ts`

RFC 9309 rather than a naive line filter: groups are collected per user-agent,
the **longest matching rule wins**, `Allow` beats `Disallow` on an equal-length
tie, and `*` / `$` wildcards are honoured. `crawl-delay` is respected when it is
slower than ours and ignored when it is faster. `looksLikeRobotsTxt` rejects the
HTML error page many servers return for a missing `/robots.txt` — treating that
as a rule file is how a crawler concludes it may read everything.

### Discovery — `src/server/scanner/sitemap.ts`

`urlset` and `sitemapindex`, with cross-site entries dropped. `prioritiseEntries`
puts product pages first, so a page limit reached on a large site still yields
products rather than blog archives.

### Extraction — `src/server/scanner/html.ts`, `price.ts`

Four strategies run on every page and compete by confidence: JSON-LD (including
flattened `@graph`, tolerant of the malformed JSON real sites ship) → microdata
→ OpenGraph → ordinary HTML → text patterns. The highest-confidence candidate
per field wins outright; nothing is averaged.

Prices infer the separator convention per string, so `1,299.00` and `1.299,00`
both read correctly and genuinely ambiguous input (`1,299`) returns **null**
rather than a guess that could be off by a thousand. Zero-decimal currencies are
handled. `extractStatedOffers` reports only what a page literally says —
percent-off, amount-off, BOGO, free shipping — and rejects implausible readings
(>95% off is a parse error, not a bargain).

### The crawl — `src/server/scanner/crawler.ts`

Bounded on pages, bytes, wall clock and requests-per-host; serial per host with
a polite delay; identifies itself by user agent. The page the owner **asked
for** is always fetched first. Canonical URLs and redirect targets deduplicate
against pages already seen.

### Persistence — `src/server/scanner/persist.ts`

Upserts websites, pages, products and images; writes `business_facts` /
`product_facts` where the source URL, method and confidence are all mandatory. A
product version is created only when its `contentHash` actually changed.
`removedAt` is set only when the crawl **completed** — concluding a product
disappeared from a run that stopped at a page limit would be a wrong fact.

### Containment — `src/server/scanner/untrusted.ts`

Prompt-injection defence built now, before Phase 3 has anything to inject into.
It is **structural, not filtering**: a random per-call delimiter the content
cannot guess, so it cannot close its own block; control, zero-width and
bidirectional-override characters neutralised; length bounded. Text that looks
like an instruction is _flagged and passed through_, because "ignore the noise"
is legitimate product copy and a filter would lose real information while
stopping nothing.

### API and UI

`POST /api/businesses/:id/scan` starts or reuses a scan; `GET` reports status.
`/website` shows what was found, every fact labelled with where it came from and
how confident it is — as words, not a number, because "0.72" means nothing to a
shop owner. The scan control reports **pages read**, not a percentage: a crawl
does not know how many pages a site has, and a fake progress bar would be a lie.

---

## 2. What the scanner can extract

Verified against the fixture site in `tests/helpers/fixture-site.ts`, which
deliberately mixes the shapes real sites use.

**Business:** name, description, contact email, phone, postal address, social
profiles, currency, logo, platform hint.

**Products:** name, description, price, compare-at price, currency, SKU / MPN /
`externalId`, brand, category, availability (`IN_STOCK|OUT_OF_STOCK|PREORDER|UNKNOWN`),
tags, image URLs with alt text and dimensions, calls to action, explicitly
stated offers.

**Pages:** normalised URL, final URL after redirects, page type
(home / product / collection / about / FAQ / shipping / returns / contact /
policy / blog / other), title, meta description, visible text, the raw
structured data found, content hash, outbound link count.

**Site:** robots.txt, sitemap URLs, resolved root after redirects.

Every one of those becomes a fact row carrying its **source URL**, extraction
method and confidence. Two things it deliberately will not produce: a
`costCents` it was not given, and a variant list (see SCHEMA.md).

---

## 3. What it refuses to do

- **Never invents a price or a cost.** Ambiguous price text yields `null`.
- **Never promotes an inference to a fact.** There is no code path from Phase 3's
  tables into `business_facts`.
- **Never concludes a product was removed** from an incomplete crawl.
- **Never reports an empty scan as a success.** See §5.
- **Never calls a paid provider.** The whole phase runs on `webfetch.local`;
  reaching anything paid still needs all three Phase 1.5 switches.

---

## 4. Security

### SSRF — two gates, and a real bypass found and fixed

Fetching arbitrary user-supplied URLs is this product's _job_, which makes this
the highest-risk surface in the codebase.

**Gate 1, syntactic** (`assertSafePublicUrl`): scheme, embedded credentials,
non-standard ports, URL length, and host classification — loopback, RFC 1918,
link-local including `169.254.169.254`, CGNAT, multicast, and internal TLDs
(`.local`, `.internal`, `.lan`, `.home.arpa`, `metadata.google.internal`).

**Gate 2, post-DNS** (`assertResolvedAddressesArePublic`): the _resolved_
addresses are classified immediately before connecting, and **all** of them must
be public. A public hostname with one private `A` record is the classic rebind,
and it is refused.

Both gates re-run on **every redirect hop**.

The bypass: gate 1 only recognised dotted-quad IPv4, so every one of these was
**accepted** before this phase hardened it —

```
http://2130706433/        http://0x7f000001/     http://127.1/
http://017700000001/      http://0x7f.1/         http://[::ffff:127.0.0.1]/
```

All six reach `127.0.0.1`. `parseIPv4` now normalises to a numeric address
first, handling `inet_aton` short forms and hex/octal parts, and `classifyIPv6`
recognises IPv4-mapped addresses in both notations. The six are now named
regression tests.

### Prompt injection

Structural containment, as described in §1. The fixture site serves a product
description containing "Ignore previous instructions…"; the scan stores it,
flags it, and reports it as a warning — treating it as content, which is what it
is.

### Other

Untrusted text is sanitised of control, zero-width and bidi characters before
storage. Page size, page count, byte total, crawl duration and per-request
timeouts are all bounded. The logger already redacts and truncates, which
matters more now that it is handling arbitrary scraped text. Every scanner
service takes a `BusinessContext`; the background job rebuilds one through
`requireBusinessContext`, so a job gets no shortcut around tenancy.

---

## 5. Verification

### Tests — 382 passing (256 unit, 126 against real PostgreSQL)

161 of them are new in this phase:

| File                                    | Tests | Covers                                                                       |
| --------------------------------------- | ----: | ---------------------------------------------------------------------------- |
| `tests/unit/net-safety.test.ts`         |    38 | IPv4/IPv6 parsing, host classification, both gates, normalisation            |
| `tests/unit/scanner-extraction.test.ts` |    52 | JSON-LD, microdata, OpenGraph, prices, offers, robots, sitemaps, containment |
| `tests/unit/scanner-crawl.test.ts`      |    29 | The crawl against a real HTTP server on a real socket                        |
| `tests/db/jobs.test.ts`                 |    21 | Claiming, double-claim, idempotency races, backoff, dead-letter, reclaim     |
| `tests/db/scanner.test.ts`              |    21 | Persistence, provenance, versioning, change detection, tenant isolation      |

The crawl and fetcher tests run against a real server rather than a mocked
`fetch`, because the parts most likely to break — redirects, content types,
status codes, per-hop revalidation — are exactly the parts mocking skips.

### The loopback problem, and how the tests stay honest

The fixture site is on loopback, which the SSRF guard blocks by design. Rather
than adding an "allow private addresses" flag — which would have made every SSRF
assertion vacuous — the crawler takes a `UrlPolicy { allowedPrivateHosts }`
**function argument** with no configuration path. Tests exempt `127.0.0.1` by
name; `169.254.169.254` stays refused, so the SSRF tests still mean something.
One test asserts the fixture host is refused under the default policy, proving
the exemption is not the default.

### Typecheck, lint, format, build

All clean. `npm run verify` passes. The production build succeeds with
`/website` and `/api/businesses/[businessId]/scan` in the route table.

### Migration

`20260921180742_phase2_website_scanner` — hand-written, reviewed, applied
cleanly to dev and test. Eight tables; the two enum additions (`WEB_FETCH`) use
`ALTER TYPE … ADD VALUE`, preserving existing rows.

### End-to-end over HTTP — 12 checks

Register → business → setup → scan → worker → UI, against a dev server on a real
port, with a fixture shop on another. What it proves:

- a literal loopback URL is refused at the API boundary, before anything is stored;
- a **public-looking hostname** (`shop.fixture-e2e.test`, pointed at `127.0.0.1`
  via `/etc/hosts` — what a DNS rebind achieves) passes gate 1, is accepted, and
  is then refused by gate 2 in the worker;
- the fixture server counts its own requests and records **zero** — the crawler
  never opened a socket, not even for `robots.txt`;
- a second scan click reuses the in-flight scan;
- the Website page reports the failure and shows no product data;
- the dashboard raises it as needing attention;
- `webfetch.local` appears on the Costs page at **$0**.

Happy-path extraction against the same fixture is covered by
`tests/db/scanner.test.ts`, which exempts the host in code. The end-to-end run
deliberately covers the case that _cannot_ be tested with an exemption: that the
guard holds on the production path, where no exemption exists.

### Two bugs the tests caught

**The crawler ignored the start URL.** The frontier was sorted before the first
fetch, so a sitemap entry could displace the page the owner asked for — a scan
pointed at one product page could come back having read the homepage instead.
Found by a fixture test, fixed by only sorting once a page has been fetched.

**An unreachable site reported success.** Found by the end-to-end run, and the
more interesting of the two. When gate 2 refused the host, the crawl loop
drained its frontier, fetched nothing, and returned `stopReason: 'completed'`.
The scan stored as `COMPLETED` with zero pages, so the owner saw an empty
Website page — the implication being that we had read their site and found
nothing on it. A crawl that read nothing is now `unreachable`, which the job
raises as a failure with the reason in the owner's own words ("That website
resolves to a private address, so it cannot be scanned"), marked
non-retryable because retrying a refusal cannot succeed. Seven tests now cover
it, including that a cancel is still reported as a cancel.

Both were reported as working before they were run against a real server. That
is the argument for the verification step, not a footnote to it.

---

## 6. What remains for Phase 3

Phase 2's exit criterion — _two materially different real websites onboarded,
products discovered, facts traceable to URLs_ — **has not been met.** The
scanner is verified against a fixture that deliberately mixes real-world
shapes, and against the reserved-domain and private-address cases. It has not
been pointed at a live shop, because this environment's outbound network is
proxied and a real merchant site is not a fixture. That test needs a browser, a
URL and five minutes, and it should happen before Phase 3 depends on the output.

Carried forward from the Phase 1 report, still open:

- `/api/assets/*` does not exist, though `storage.urlFor()` points at it
- `purgeExpiredSessions` is never called
- no CSP, no rate limiting
- no workspace switcher, no password reset
- no UI to enable a paid provider (deliberate while everything is free)

New, and Phase 3's to resolve or inherit:

- **Scheduled rescans.** `isRescan` and change detection work; nothing schedules
  them. Phase 10 owns the scheduler, but Phase 3 will want fresher data than a
  manual button provides.
- **Images are URLs only.** `storageKey` is null throughout. Phase 4 fetches the
  bytes it needs.
- **`platformHint` is recorded, unused.** It orders nothing yet.
- **No JavaScript rendering.** A shop that renders its catalogue client-side
  yields a near-empty scan. Headless Chromium would fix it and would cost real
  infrastructure; the honest answer for now is that such a site scans poorly,
  and the UI says how many pages were read so it is visible rather than silent.

Phase 3 starts from `business_facts` and `product_facts` and adds the marketing
engine. Its first obligation is the one this phase set up for it: an AI
inference must never be written where a verified fact belongs.
