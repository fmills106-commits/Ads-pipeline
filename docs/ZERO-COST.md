# Zero-cost architecture

The application runs, develops, tests and demonstrates end to end for **$0**.
No API key, no hosted service, no subscription, no credit card. A local
PostgreSQL is the only thing it needs, and that is free too.

This is not a limited trial mode. It is the mode the product is built in, and
paid services are optional upgrades on top of it.

---

## The three switches

Spending money requires **three independent things to be true**. No single
misconfiguration can start a bill.

```
1.  ZERO_COST_MODE=false          ← environment
2.  a non-zero cost ceiling       ← environment
3.  that provider enabled         ← per workspace, in the database
```

Miss any one and the capability resolves to its free implementation and keeps
working. The three are checked in different places — schema validation, the
cost ledger, the registry — so a mistake in one does not disarm the others.

Defaults on a fresh clone: mode **on**, ceilings **$0.00**, providers **all
off**.

---

## Provider architecture

Every capability that could cost money sits behind an interface with at least
one local, free implementation.

| Capability                     | Free implementation (default)                            | Paid alternative             |
| ------------------------------ | -------------------------------------------------------- | ---------------------------- |
| AI                             | `ai.local` — deterministic strategy and copy             | `ai.anthropic` — built, off  |
| Image generation               | `image.local` — SVG creatives from templates             | `image.external` (Phase 4)   |
| Advertising                    | `advertising.simulated` — full campaigns, simulated data | `advertising.meta` (Phase 6) |
| Storage                        | `storage.local` — filesystem                             | `storage.s3` (Phase 4)       |
| Analytics · Search · Embedding | declared seams                                           | later phases                 |

`selectProvider` enforces the rules:

1. **In zero-cost mode, paid providers are invisible** — not deprioritised,
   not skipped, absent from consideration entirely. Enabling one explicitly
   makes no difference.
2. Outside zero-cost mode, a paid provider is considered only if it is both
   _configured_ (credentials present) and _enabled_ for that workspace.
3. Otherwise the free provider runs. This is the branch that makes "keeps
   working with every external service disabled" true rather than aspirational.

A capability with no free provider registered raises at selection time. It is
treated as a programming error, because it would silently break the guarantee.

---

## The guard

Nothing calls a provider implementation directly. Every invocation goes through
`runProvider`, which:

- **selects** the provider, so mode and enablement apply on every call rather
  than being remembered at each site;
- **checks the ceilings before the call**, so a request that would exceed a
  limit never leaves the process;
- **falls back to free rather than failing** when a paid call is refused — and
  returns `fellBackBecause` so the downgrade is visible. A silent downgrade is
  the same dishonesty as a silent charge;
- **records a cost row afterwards**, whether the call succeeded, failed, or
  cost nothing.

A paid call that leaves no trace is not expressible in this design.

---

## Cost accounting

`cost_records` is append-only and records **free calls too**. That is
deliberate: "1,284 AI operations this month, $0.00" is the single most useful
thing the Costs page can say, and it is only possible if the free path writes
rows as diligently as the paid one.

Ceilings, all enforced before the call:

| Ceiling                           | Default | Meaning                                     |
| --------------------------------- | ------- | ------------------------------------------- |
| `MAX_DAILY_PROVIDER_COST_CENTS`   | `0`     | Per day, per workspace                      |
| `MAX_MONTHLY_PROVIDER_COST_CENTS` | `0`     | Per calendar month                          |
| `MAX_SINGLE_CALL_COST_CENTS`      | `50`    | One runaway request                         |
| Per-provider                      | unset   | Optional, tighter than the platform ceiling |

**Zero means zero, never "unlimited."** A daily allowance above the monthly one
is rejected at startup as the contradiction it is.

Where actual cost is reported it is used; where it is not, the estimate stands.
It is never back-filled with a guess.

`costCeilings()` collapses every ceiling to zero while zero-cost mode is on, so
"is this allowed to cost money?" has exactly one answer, computed in one place.

---

## What "simulated" means

The free providers are real capabilities, not stubs.

- **`ai.local`** produces structurally valid, deterministic output that passes
  the _same schema validation_ a paid provider's would. It composes from values
  the caller supplied and asserts no prices, reviews, statistics or
  superlatives — the prohibited-claims rules are satisfied by construction
  rather than by filtering afterwards.
- **`image.local`** composes SVG creatives from the brief. Template-composed
  creative is what most ecommerce advertising actually looks like; it renders in
  milliseconds and is exactly reproducible. Because every element is placed from
  known values, Phase 4's QA checks are satisfiable by construction: the price
  on the image _is_ the price passed in.
- **`advertising.simulated`** builds complete campaign structures and generates
  plausible, internally consistent, deterministic performance data. Simulated
  spend never exceeds the campaign budget — the same invariant the real
  safeguards enforce.

Everything simulated is **labelled**. `ExternalRef` and `Insights` carry
`isReal: boolean` in the return type rather than as a convention, AI output
carries `simulated: true`, and the dashboard shows a simulation banner. A
simulated campaign that looked real would be the most damaging thing this
product could do.

---

## The one thing that cannot be free

`ai.anthropic` is the only paid provider with an adapter behind it, and it is
worth being precise about why, because "everything is free" and "there is a paid
writer" have to both be true.

The free writer is real. It reads the dossier, quotes the merchant's own
sentence about their own product, keeps inside the claim rules and costs nothing,
for ever. What it cannot do is write. It cannot read eight pages about soft-foam
Halloween squishies and produce a sentence nobody would guess was generated,
because writing needs a language model and no language model runs for nothing.

So the arrangement is not free writing. It is:

- **Off by default and complete without it.** Every task it serves has a free
  implementation that passes the same validation. The three switches above stand
  in front of it unchanged.
- **Priced before it runs.** `src/server/providers/pricing.ts` estimates the
  call from the prompt and the output allowance, and the ceiling is checked
  against that estimate. This is not decoration: `checkBudget` reads an estimate
  of zero as "free" and skips every limit, so before there was an adapter the
  estimate did not matter, and the moment there was one it decided whether
  limits applied at all.
- **Recorded in cents afterwards**, from the tokens the model reports at the
  published rate for the model that answered — and recorded as _unknown_ rather
  than guessed when this build has no checked price for that model. The
  pessimistic estimate stands in wherever spend is totalled.
- **Never cached.** Prompt caching would be cheaper, and it is deliberately not
  used: every untrusted block is wrapped in a per-call random delimiter, so no
  two prompts share a prefix. Containment beats the discount.
- **Shown the product, where there is one.** Writing about a single product
  sends up to three of the merchant's own photographs by URL — nothing is
  downloaded, since the images are already public and already served by their
  own host. Each costs roughly 1,600 input tokens, about a third of a penny, and
  the estimate counts them. They travel only with a single-product request,
  because a picture is evidence about the thing in it and a mixed set from forty
  products invites a confident description of the wrong one. Every URL is put
  through the same gate that decides whether the crawler may fetch it, since
  these came out of a stranger's HTML; an unusable one is dropped rather than
  raised. And the system prompt says that writing inside an image is part of the
  picture, never an instruction — an image is as capable of carrying "ignore
  your instructions" as a product description is.
- **Honest about failure.** A refusal is `PROVIDER_REJECTED` and final. Output
  that is not the requested shape is `AI_OUTPUT_INVALID`, which buys exactly one
  rephrased retry, because the retry is a second billed call.

`ANTHROPIC_MODEL` picks the model. The default is a mid-priced one on purpose; a
larger model writes better and costs more, and that is the owner's decision to
make, not a default to be quietly generous with.

---

## Whose key, and who is paying

A credential can come from two places, and the difference is who gets the bill:

| Source          | Set in                   | Who pays               |
| --------------- | ------------------------ | ---------------------- |
| **Environment** | `ANTHROPIC_API_KEY`      | whoever runs the depl. |
| **Workspace**   | Settings → paste the key | the owner of that ws.  |

The workspace's own key wins where both exist. It is the more specific of the
two and the one its owner can see and change, so silently preferring the
operator's key — and their bill — would be the wrong way round.

Stored keys are encrypted with `encryptSecret`, bound by their authenticated
additional data to one workspace and one provider, so a row copied elsewhere
fails to decrypt rather than yielding a key someone else is paying for. Only the
last four characters are kept in the clear, as a hint. **There is no read path**:
no route, no action and no function returns a stored key, and the audit log
records the hint only.

A key that cannot be decrypted — a rotated `ENCRYPTION_KEY`, a database restored
into another deployment — is treated as absent and logged loudly. The work goes
to the free provider and the owner can see their key needs re-entering; failing
every call instead would take down a feature that is optional by design.

This exists because the middle step below used to be a wall: open the hosting
platform's environment-variable panel, paste a secret into a form that cannot
tell a good paste from a bad one, and redeploy. It is the step that broke this
project's own deployment once, and it is not a thing a shop owner should have to
do to switch on a feature.

---

## Upgrading to a paid provider

The deployment's operator, once:

1. Set `ZERO_COST_MODE=false`.
2. Raise a cost ceiling above zero.

Neither of those is available in the interface, deliberately: zero-cost mode is
the operator's promise that this deployment cannot spend money, and a screen that
could revoke it would make the promise worthless.

Then, per workspace, in Settings and needing no redeploy:

3. Paste the API key — or leave it, if the deployment supplies one.
4. Switch that specific provider on, with a daily limit.

Each of the four is independent, and Settings names whichever one is missing.
Downgrading is undoing any one of them: remove the key, switch it off, lower the
ceiling, or turn zero-cost mode back on. The application keeps working
throughout, on the free providers.

---

## Testing

The whole suite runs at $0 by construction: `.env.test` contains no credential
for any paid service, and the unit environment sets none. The tests that hold
this in place:

- `tests/unit/env.test.ts` — ceilings collapse to zero in zero-cost mode; no
  credential is ever a required variable; turning off zero-cost mode alone
  permits nothing.
- `tests/unit/providers.test.ts` — paid providers are invisible in zero-cost
  mode even when enabled; every capability has a free provider; the real
  registry has no paid provider configured without credentials.
- `tests/unit/local-providers.test.ts` — free providers report zero cost, mark
  output simulated, are deterministic, and never invent claims.
- `tests/db/cost.test.ts` — free calls are allowed with every ceiling at zero;
  the call that _would_ cross a ceiling is refused, not the one after; spending
  is workspace-isolated.
