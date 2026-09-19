# Development phases

Each phase ends with the same gate: tests pass, lint passes, typecheck passes,
migrations apply cleanly, the API works, the UI works, the work is documented,
and the remaining work is named. Nothing is reported as working that has not
been run.

Where an external API cannot be exercised without credentials, the phase ships a
provider interface and a mock implementation, and says so — it does not claim
the integration works.

| Phase | Scope                                                                                                             | Status          |
| ----- | ----------------------------------------------------------------------------------------------------------------- | --------------- |
| 1     | Foundation — TypeScript, database, auth, tenancy, UI shell, config, logging, errors                               | ✅ **Complete** |
| 2     | Business onboarding — website scanner, sitemap discovery, page extraction, structured facts, product discovery    | Next            |
| 3     | AI marketing engine — business/product analysis, strategies, audience hypotheses, offer engine, ad copy           | Planned         |
| 4     | Creative engine — templates, image provider, generation, QA, versioning, approval                                 | Planned         |
| 5     | Campaign engine — builder, ad sets, ads, budget controls, mock advertising provider                               | Planned         |
| 6     | Meta integration — OAuth, account selection, campaign creation, creative upload, publishing, insights sync        | Planned         |
| 7     | Analytics — performance snapshots, dashboard, creative and campaign performance                                   | Planned         |
| 8     | Experiment engine — hypotheses, controls, variations, tracking, results                                           | Planned         |
| 9     | Learning engine — cross-campaign analysis per business, product/creative/offer/audience insights, recommendations | Planned         |
| 10    | Automation — scheduled scanning and sync, automatic generation, rules engine, automation levels, safeguards       | Planned         |

---

## Phase 1 — Foundation ✅

Delivered: project scaffold, strict TypeScript, PostgreSQL + Prisma with a
reviewed migration, session authentication, the multi-tenant isolation layer,
the append-only audit trail, the background-job schema, structured logging with
redaction, the error taxonomy, bounded retry with jitter, secret encryption, the
SSRF guard, and a working UI shell with business onboarding.

Verified: 141 automated tests (85 unit, 56 against real PostgreSQL), a clean
production build, and a 16-check end-to-end smoke test over HTTP.

Full report: [PHASE-1.md](PHASE-1.md).

## Phase 2 — Business onboarding

Website scanner with a per-host rate limiter and robots.txt compliance;
sitemap discovery; multi-strategy extraction (JSON-LD → OpenGraph → HTML →
text, in that order of trust); product discovery; `business_facts` and
`product_facts` with URL-level provenance and a confidence score; the job
worker loop; rescan with content-hash change detection and product versioning.

The second SSRF gate — re-validating the resolved IP immediately before
connecting — lands here, alongside the first fetch the platform ever makes.

Exit criterion: two materially different real websites onboarded through the
normal flow, with products discovered and facts traceable to URLs.

## Phase 3 — AI marketing engine

`AIProvider` interface plus a mock implementation, then Anthropic. All model
output validated against Zod schemas with a repair-then-retry-then-fail path;
malformed data never passes downstream. Business and product analysis;
marketing strategies with structured reasoning rather than invented scores;
audience _hypotheses_ stored separately from verified data; the offer engine
with merchant constraints and explicit "margin unavailable" when cost is
unknown; ad copy with the prohibited-claims list enforced.

Prompt-injection defence is built here: scraped content enters prompts as
delimited data, never as instruction.

## Phase 4 — Creative engine

Data-driven creative formats and templates; `ImageGenerationProvider` and
`StorageProvider` abstractions; generation; the QA agent with per-check results
covering price, discount, product, brand, readability, safe areas, dimensions
and misleading claims; immutable versioning; the approval workflow. A failed QA
never publishes.

## Phase 5 — Campaign engine

Campaign builder; ad sets and ads; the budget guard enforcing the lower of the
platform and per-business ceilings; approval thresholds; the emergency
"pause all campaigns" control. `AdvertisingProvider` with a mock
implementation — no real spend, no real credentials.

## Phase 6 — Meta integration

`MetaAdvertisingProvider` behind the Phase 5 interface. OAuth with encrypted
token storage; ad-account selection; campaign, ad set, creative and ad creation;
insights synchronisation; webhook handling with signature verification and
idempotency.

Real credentials are introduced only after the Phase 5 mock pipeline passes the
definition-of-done test end to end.

## Phase 7 — Analytics

Append-only performance snapshots with explicit data-freshness labelling;
dashboard; creative and campaign performance views.

## Phase 8 — Experiment engine

Controlled experiments: hypothesis, control, variant, one variable held
distinct, recorded start and end, results and conclusion.

## Phase 9 — Learning engine

Cross-campaign analysis **within each business**. Insights carry sample size,
time period, context and stated uncertainty. Knowledge layers (global, business,
product, campaign, creative) with a storage-level constraint preventing data
from mixing between businesses.

## Phase 10 — Automation

Scheduled scanning and synchronisation; the rules engine with configurable
conditions; automation levels 1–4; spending safeguards that no automation level
can bypass.

---

## Definition of done

The platform is not finished because the UI exists. The minimum successful
end-to-end test is:

1. Create a business
2. Enter its website
3. Scan the website
4. Discover a product
5. Extract verified product information
6. Generate marketing analysis
7. Generate multiple strategies
8. Generate an offer proposal
9. Generate ad copy
10. Generate multiple creatives
11. Run creative QA
12. Approve a creative
13. Create a mock campaign
14. Verify campaign structure
15. Generate mock performance data
16. Analyse performance
17. Create an experiment
18. Generate a new creative based on experiment results
19. Verify historical data remains intact
20. Verify tenant isolation

Steps 19 and 20 hold as of Phase 1 and are re-asserted by the test suite on
every change. Real Meta credentials are introduced only after steps 1–20 pass
against mock providers.
