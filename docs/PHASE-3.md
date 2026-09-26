# Phase 3 report — AI marketing engine

**Status: complete and verified.**

Phase 2 turned a website into facts. This turns facts into a reading of the
business, ways to advertise it, offers, and ad text — while keeping the two
kinds of statement apart the whole way.

---

## 1. What was built

### The guarded call path — `src/server/marketing/ai.ts`

Every AI call in the application goes through one function, which is what makes
the guarantees around it enforceable rather than a convention each caller has
to remember:

- Output is validated against a Zod schema **inside** the provider call, so a
  malformed response never becomes a value anyone could use.
- A shape failure is retried **once**, with the specific complaint fed back,
  then fails loudly. Looping until it parses would turn a confused provider
  into an unbounded bill.
- Anything that is not a shape failure — a timeout, a refusal, a cost ceiling —
  is not retried, because rephrasing would not fix it.
- Every durable result writes an `ai_decisions` row: what went in, what came
  out, which provider, whether it was simulated, and which verified facts it
  was reasoned from.

### Analysis — `analysis.ts`

Reads verified facts and produces a `business_profiles` row plus audience
hypotheses. A business with fewer than three verified facts is **refused**
rather than analysed: a reading built on nothing looks identical to one built
on plenty, and the owner would have no way to tell them apart.

### The offer engine — `offers.ts`

Contains **no AI call**. Choosing which kind of offer suits a product is
judgement; working out what 15% off does to a price is arithmetic, and
arithmetic a language model performs is arithmetic nobody checked. Every
number here is computed from a price the merchant's own site states.

### Strategies and copy — `engine.ts`

Strategies carry a hypothesis, its assumptions and the variables an experiment
should vary — and deliberately **no quality score**. Nothing has been measured
yet, and `0.82` would invite treating a guess as a measurement. Copy is
generated per strategy so that every sentence traces back to a stated reason.

### The claim checker — `claims.ts`

The last thing between generated copy and a merchant's customers.

It is **allow-listed against evidence**, not pattern-matched for bad words. A
blocklist of forbidden phrases is endless and evaded by rephrasing; asking
"this copy states a price — is that price on the product page?" cannot be
rephrased around, because the problem is the claim rather than the wording.

What it refuses: prices the page does not state, discounts with no approved
offer behind them, unsubstantiated superlatives, specific statistics,
manufactured urgency, regulated health and income promises, and anything the
merchant themselves banned. What it permits: a phrase the merchant published
on their own site, which is theirs to make.

What it does not attempt: judging whether "beautifully made" is fair. That is
not checkable, and pretending otherwise would make it an editor rather than a
fact-checker.

---

## 2. The two properties that matter

**An inference can never become a fact.** `ai_inferences` and
`business_facts` / `product_facts` are separate tables written by separate
modules, and there is no operation anywhere that moves a row between them. A
fact carries a source URL and an extraction method; an inference carries
reasoning and an uncertainty, and cites the facts it was reasoned from. The UI
renders them under different badges on different pages.

**An unknown margin stays unknown.** `offers.marginKnown` is false whenever the
merchant never supplied a cost — which the scanner is forbidden from inferring
— and the screen says "Margin unknown, you have not told us what this costs
you". An estimated margin would be a number somebody discounts against.

---

## 3. Verification

**489 tests** (up from 432). The new ones:

| File                                  | Tests | Covers                                                          |
| ------------------------------------- | ----: | --------------------------------------------------------------- |
| `tests/unit/marketing-claims.test.ts` |    16 | Every category of claim, written from the direction of the harm |
| `tests/unit/marketing-offers.test.ts` |    15 | Margin, ceilings, and products that must not be discounted      |
| `tests/db/marketing.test.ts`          |    26 | The engine end to end on a real scan, plus tenant isolation     |

Typecheck, lint, format and production build clean. The whole engine was then
driven through a real browser — every button, zero console errors.

### Three bugs found by running it

**The containment delimiters leaked into the ad copy.** The first design
wrapped every untrusted field in `<<<UNTRUSTED_…>>>` markers at the AI
chokepoint. That is wrong, and the screen showed why: the free provider builds
no prompt, it composes from its inputs, so the markers appeared verbatim in the
value proposition shown to the owner. Delimiting is a property of a _prompt_ —
it exists so concatenated text cannot escape into instruction context — and a
provider that concatenates nothing has nothing to escape from. Wrapping now
belongs to `buildContainedPrompt`, which a prompt-building provider must use;
sanitising and bounding, which are genuinely provider-agnostic, stayed at the
chokepoint. Four tests pin the boundary, including that untrusted text is still
properly contained when a prompt _is_ built.

**The free provider produced headlines too long to publish.** Ad platforms cap
a headline at 60 characters, the schema enforces it, and the local provider
sailed straight through with a long product name. Found because the local
provider is held to exactly the same validation as a paid one — which is the
argument for doing that.

**Pressing a button twice stacked duplicates.** Suggesting offers three times
produced three copies of every offer, and writing ads twice left two sets side
by side with nothing to say which was current. Both now replace rather than
accumulate — scoped so that an approved offer or an approved ad is never
quietly withdrawn, because those were decisions somebody made.

---

## 4. What remains

**The output is a placeholder, not advice.** Everything above runs on
`ai.local`, which does not use a language model. It produces structurally
valid, deterministic text so the pipeline is exercisable for $0, and the `/ads`
page leads with "this is a placeholder, not a recommendation". Connecting a
real provider is a Settings change, and the shape of what is stored does not
move.

**`ai.anthropic` is now built, and off.** The adapter is in
`src/server/providers/external/ai-anthropic.ts`; `docs/ZERO-COST.md` has the
whole argument for why it is the one thing that cannot be free and what keeps it
optional. Nothing in this phase changes shape when it is switched on: the same
schemas, the same validation, the same decision records. What changes is that
the copy is written rather than composed.

It has never made a live call. Every branch of it is tested against a stand-in
client — containment, token accounting, refusals, prose where JSON was asked
for — but the first real request is still the first real request, and that is
worth knowing before switching it on.

**Product-level analysis is thin.** Business analysis reads across all
products; per-product analysis producing motivations and objections is
specified and not yet built.

**Offers are proposed for one product at a time via the UI**, and the `/ads`
page drives strategies and copy from the first product and first strategy
rather than offering a picker. Adequate for a single-product test, thin for a
catalogue.

**No images.** Phase 4. Today this is text a merchant could copy and use by
hand, which is genuinely useful and is not an ad campaign.

## Corrections from the first real owner

Two things the first person to use the deployment found, and one the
verification screenshots found.

**No way to remove a website.** An owner typed an address to try the scanner
and was then stuck with it. The missing button was not the whole problem:
pointing a business at a different site invalidates everything downstream of
the old one, so there was nothing safe to wire a button to until something knew
what to discard. `src/server/business/website.ts` now does, and the rule it
enforces is that the application must never describe one company using another
company's pages — the website row and its cascade, the business-level facts,
the AI's profile and inferences, and the offers and strategies drafted from
them all go together, in one transaction with the address change. The audit
log, the cost records and the activity feed survive: those are the record of
what happened, and tidying away history is how you lose the ability to answer
"why did it do that?"

**No way to choose light or dark.** The palette had followed
`prefers-color-scheme` since Phase 1, so dark mode worked for anyone whose
device was set to dark and was invisible to everyone else. The choice now lives
in a cookie read by the root layout, which means the right theme is in the HTML
the server sends — no flash of the wrong colours, and no blocking inline script,
which matters because the content-security-policy admits no un-nonced inline
script. `system` remains the default and means "keep following the device",
which is why it is three options rather than a toggle.

**Setup announced itself twice.** A screenshot of the dashboard showed "Set up
to get more sales on $5/day" twice in the activity feed. `completeOnboarding`
recorded the milestone on every call, so a double-clicked Finish button wrote
it twice. It is now recorded only on the transition into being onboarded; the
audit log still records both writes, because both really happened.
