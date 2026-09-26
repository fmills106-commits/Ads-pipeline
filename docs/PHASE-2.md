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

### Tests — 399 passing (273 unit, 126 against real PostgreSQL)

178 of them are new in this phase:

| File                                    | Tests | Covers                                                                       |
| --------------------------------------- | ----: | ---------------------------------------------------------------------------- |
| `tests/unit/net-safety.test.ts`         |    38 | IPv4/IPv6 parsing, host classification, both gates, normalisation            |
| `tests/unit/scanner-extraction.test.ts` |    64 | JSON-LD, microdata, OpenGraph, prices, offers, robots, sitemaps, containment |
| `tests/unit/scanner-crawl.test.ts`      |    34 | The crawl against a real HTTP server on a real socket                        |
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
products discovered, facts traceable to URLs_ — **is met.** See §7 for what
that test found, which was not nothing.

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

---

## 7. The first real websites

Two shops chosen to be materially different, both crawled through the
production path with the strict URL policy, an eight-page cap and the
crawler's normal politeness:

| Site                 | Structured data      | What it tests                       |
| -------------------- | -------------------- | ----------------------------------- |
| `webscraper.io`      | schema.org microdata | The structured path, on real markup |
| `books.toscrape.com` | **none at all**      | The HTML fallbacks, with no help    |

Both now extract correctly:

- **MSI GL72M 7RDX** — $1,099.00 USD, `MICRODATA`, confidence 0.9
- **A Light in the Attic** — £51.77 GBP, `HTML`, confidence 0.7

Getting there took four fixes. The fixture had been written with generous
structured data on every product page, so none of this was reachable until the
scanner met markup nobody wrote for it.

**Category pages became products.** "Add to basket" appears once per row on a
listing, which satisfied the product signal; with no structured data the name
fell back to the page's `<h1>`. A real bookshop's category pages would have
been stored as products called "Travel" and "Mystery", with no price. Product
extraction now needs either structured data declaring one product, or a price
plus no sign the page is a list of many.

**The front page became a product.** A flattened microdata map collected every
`itemprop` on the page regardless of which `itemscope` it belonged to, so a
`WebSite` scope's `name` and a pricing table's `price` combined into a product
called "Home" costing $1,187.98. Product microdata is now read only from inside
a `schema.org/Product` scope, and a site's root is never treated as a single
product unless its own structured data says so.

**A product was named after its URL.** `itemprop` values preferred the `href`
attribute over the element's text, so `<a itemprop="name" href="/product/120">`
yielded "/test-sites/e-commerce/allinone/product/120". The attribute is now
chosen by property: links for `url`, `image` and `availability`, text for
everything else.

**A whole shop yielded nothing.** `books.toscrape.com` publishes prices only as
`<p class="price_color">£51.77</p>` — no JSON-LD, no OpenGraph, no microdata,
and no basket button on product pages either. There was no HTML price path at
all, so every product was discarded for having no price. There are now two
bounded attempts: an element the markup labels as the price, or a single
distinct amount on the whole page. Neither runs on a page that looks like a
list, and both record the weaker method so nothing claims to be structured data
that isn't.

One case was left deliberately unresolved. A page with a heading and a labelled
price is genuinely ambiguous — a one-product shop looks exactly like a
membership page — so the scanner does not try to tell them apart. What it must
not do is claim the merchant _published_ product data when they published
something else, and the recorded method carries that distinction: Phase 3 can
weigh an `HTML` 0.7 guess differently from a `MICRODATA` 0.9 statement.

Every fix is covered by tests built from the real markup that broke it —
17 new assertions across `scanner-extraction.test.ts` and
`scanner-crawl.test.ts`, plus four fixture pages carrying the shapes that
caused the trouble.

## Several products on one page

Added after the first real storefront: a one-page shop selling four pack sizes
from a single section of its front page. Every product it sold was invisible,
for two independent reasons.

`extractFromHtml` returned at most one product per page, and `persistScan`
identified a product by the URL it was found at — so even had extraction found
four, three would have collided on that URL and silently vanished. Both are
fixed: `PageExtraction.products` is a list, and a product on a page that offers
several carries a short identifier from the page (its element `id`, else its
`data-sku`, else a slug of its name) which becomes a URL fragment. A page about
one product keeps its bare URL, so nothing recorded earlier loses its price
history.

Extraction now tries three paths and uses the first that yields anything, so a
product page's "you may also like" strip never reports its neighbours as its
own products:

1. **Several declared products** — two or more `schema.org/Product` nodes, read
   one per node rather than merged. Merging is what turned a carousel into a
   single product called "Home" priced at $1,187.98.
2. **One product** — the original path, unchanged, guards and all.
3. **A repeated group of priced offers** — no structured data, but sibling
   elements of one shape each naming one thing and one price.

Path 3 is the loosest, so it is the most constrained. The hard part is not
finding the four packs; it is finding them without also "finding" products on a
category listing, whose markup is the same shape — repeated cards, each with a
name, a price and an add-to-basket button. The difference is where the checkout
is: **a listing card links to the product's own page, a pack card has nowhere
to send you.** A card containing a link out is declined, which costs nothing
because that product is read properly, with its full detail, from the page it
links to. A cart, a comparison table in an article, and a single priced banner
are all refused too, and a price of zero is never a product's price.

Everything from path 3 is recorded as method `HTML` — the lowest trust tier
above guessing from prose — so the provenance stays honest about having been
inferred from layout rather than declared.

### A pre-existing bug this uncovered

The new category-listing test failed on the _old_ code path, not the new one:
the listing was stored as a single product named "Flours" at £7.90. The
`looksLikeListing` guard counts add-to-basket phrases, and its pattern began
with `\b` — but `extractVisibleText` joins text nodes with no separator, so the
page reads `£7.90Add to basket` and there is no word boundary between `0` and
`A`. It found none of the three buttons.

The fix is to the pattern, not to the text. Putting spaces between elements
would fix the boundary and break something worse: a price split across
elements, `<span>$</span><span>15</span>`, is ordinary storefront markup and
would become "$ 15" and stop parsing as money.

## Pausing advertising does not stop you reading your own site

Reported by the owner: the Website page said "Advertising is paused for this
business. Resume it to scan the website", on a page with no way to resume.

Two separate faults. The message was a dead end — it told you to change
something from a page that could not change it. And the rule behind it was
wrong: reading your own website spends nothing, launches nothing and
advertises nothing, so refusing it while paused told an owner who had paused
advertising, perhaps because something was going wrong, that the way to look at
their own site was to turn advertising back on. Resuming is the one action here
that can start spending money. Coupling the harmless thing to the dangerous one
is how a safety control teaches people to switch it off.

So `StartScanInput.trigger` distinguishes `OWNER` from `SYSTEM`, defaulting to
`SYSTEM` — a caller that forgets gets the restrictive behaviour. Only the API
route, which runs inside a request from a signed-in member, claims `OWNER`. A
scan the system decided to run is still refused while paused, so no background
trigger has gained anything.

The pause is checked in **three** places, and the first fix only changed two of
them. `startScan` allowed the scan and the job let it through, but the crawler
re-reads the pause before every page and stopped on the first check — so the
scan ran, read nothing, and recorded CANCELLED. From the owner's side that is
indistinguishable from the button doing nothing. The third check now asks
whether the pause arrived _after_ this crawl began: a pause already in force
does not stop a scan the owner just asked for, and pressing "Pause everything"
mid-crawl still stops it within one page.

That predicate is exported as `pausedSince` and unit-tested, because it cannot
be reached through the job: `crawlWebsite` validates its start URL against the
strict URL policy, which has no configuration path and no test escape hatch on
purpose, so the job can only be run in tests against hosts that never resolve.

The Website page now also shows the pause, with the control that undoes it.
