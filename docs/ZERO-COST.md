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
| AI                             | `ai.local` — deterministic strategy and copy             | `ai.anthropic` (Phase 3)     |
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

## Upgrading to a paid provider

1. Put the credential in the environment. **Nothing happens** — the provider
   becomes _available_, not active.
2. Set `ZERO_COST_MODE=false`.
3. Raise a cost ceiling above zero.
4. Enable that specific provider for the workspace.

At every stage, Settings shows which implementation is serving each capability
and whether it is `Local / free` or `External / paid`.

Downgrading is removing any one of those. The application keeps working.

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
