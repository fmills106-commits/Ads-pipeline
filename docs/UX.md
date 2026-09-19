# User experience

**The complexity belongs in the software, not in the user's setup.**

The product should feel less like an advertising dashboard and more like
hiring an automated marketing employee. The engine underneath is elaborate —
provider routing, experiments, QA gates, cost ceilings, learning. A business
owner should meet none of it.

---

## Setup: four questions

```
1. What's your business?          name + website URL
2. What do you want more of?      sales · leads · customers · awareness
3. What can you spend on ads?     $10/day  or  $300/month
4. How involved do you want to be? Autopilot · Ask me first · Manual
```

That is the entire configuration surface. Nothing is optional, because if it
were optional the system could have worked it out itself.

### What the four answers produce

One typed number becomes every internal limit (`src/lib/budget.ts`):

| Owner states | System derives                                                                |
| ------------ | ----------------------------------------------------------------------------- |
| `$10/day`    | daily cap $10, campaign cap $310 (clamped to platform), approval threshold $5 |
| `$300/month` | daily cap $9.67 — divided by **31**, always rounded **down**                  |

Dividing by the longest possible month means a $310/month budget spends at most
$10/day in _every_ month. It under-spends slightly in February, which is
recoverable; overshooting in March would be a broken promise.

A budget above the deployment ceiling is **refused with an explanation, not
silently capped**. Quietly spending $20/day against a stated $100/day would
leave the owner believing something false about their own account.

The goal maps to a campaign objective in exactly one place
(`OBJECTIVE_FOR_GOAL`), which is why nobody ever types `OUTCOME_SALES`.

---

## Three automation choices

| Choice                           | What it means                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Autopilot**                    | The AI runs the advertising within budget. It still stops and asks whenever something important is uncertain. |
| **Ask me first** _(recommended)_ | The AI prepares everything and checks before anything goes live.                                              |
| **Manual**                       | The AI suggests; the owner approves each action.                                                              |

This replaced a four-level scale with overlapping semantics. Crucially, **all
three are equally safe**: budget caps, QA gates, claim checks and stopping
rules apply identically at every level. The choice is about involvement, not
about how much protection you get.

The database default is `ASK_ME_FIRST`, and the UI marks it recommended.

---

## What the owner never configures

CPA limits · ROAS thresholds · CTR thresholds · CPC limits · image-provider
priority · AI model selection · API routing · experiment parameters · creative
fatigue thresholds · provider spending limits · QA settings · database
settings · crawling settings · retry settings · background-job settings.

All of these exist and are enforced. All are derived or defaulted.

**Advanced Settings** is collapsed, and a normal user never opens it. What is
inside is mostly _not editable_ — it is a read-out of what the system decided,
so someone who wants to check that a $10/day budget really produced a $10/day
ceiling can see it in one click. Hiding complexity is not the same as hiding
what the software chose.

---

## The dashboard

Six facts and a feed:

```
Alpine Coffee Roasters
Get more sales · $10/day · Autopilot         [ Pause everything ]

Advertising 🟢 Running    Spend $42.30    Sales 17    Current ads 6
```

Plus a simulation banner while running on free providers, a pause banner when
paused, and an attention banner when something needs a decision.

Navigation went from eleven items to five: **Overview · Ads · Results · Costs ·
Settings**. The old list — Websites, Products, Creatives, Experiments, Offers,
Integrations — mirrored the system's internals, which is how engineers think
about it and not how an owner does. Those things all still exist; they live
inside these screens rather than demanding their own tab.

---

## The activity feed

```
🎨 Created 3 new Halloween ad variations.
📊 Ad #4 is performing better than the other variations.
🔄 Created new variations based on the results.
⚠️  Product price changed on the website. Updated advertising materials.
⏸️ Paused an ad because the product is no longer available.
```

An icon, a sentence, and roughly when. No timestamps to the second, no
correlation ids, no levels.

`activity_events` is a **separate table** from `audit_logs`, not a view over
it. The audit log keeps every field change, actor, and old/new value for
debugging and accountability. The feed is the short version. Everything in the
feed is also in the audit log; not everything in the audit log belongs in the
feed.

Two rules keep it trustworthy:

1. **Messages are composed server-side from verified values.** A model's prose
   never becomes an activity message — otherwise the feed inherits every
   hallucination the model makes.
2. **Every event corresponds to something that actually happened.** Nothing is
   written speculatively or in advance.

---

## Pause everything

One button, always in the same place.

Pausing takes **one click and no confirmation** — making someone hesitate in
front of a dialog is the wrong thing to do when they want spending to stop.
Resuming asks for confirmation, because that is the direction that starts
spending again.

The pause is recorded on the business rather than inferred from campaign
states, so it stops _future_ work as well as current: a job that would generate
and launch a campaign calls `assertNotPaused` before doing anything. The gate
lives in the service layer, not the UI, so a background job cannot bypass it.

The system pauses itself the same way when a safeguard trips, and the feed
distinguishes the two:

> 🛑 You paused all advertising. Nothing will run or spend until you resume.
>
> 🛑 Advertising paused automatically: a product went out of stock.

---

## Autopilot safety

Simple interface, unchanged safeguards. Regardless of automation mode, the AI
may never:

- exceed the stated budget (enforced as the lower of stated and platform caps);
- advertise an unavailable product, an incorrect price, or an expired promotion;
- continue spending when a critical system fails;
- bypass a QA gate;
- make up a product claim.

When something important is uncertain, it stops and asks — and that shows up in
the feed as an attention item with a count on the dashboard.
