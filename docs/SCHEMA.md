# Database schema

The full target schema, and the phase that adds each table.

Tables are created in the migration that ships the code reading and writing
them. Twenty-five empty tables added up front would be twenty-five guesses; each
one below is specified here so the shape is agreed, and migrated when it earns
its place.

**Migrated so far:** `users`, `sessions`, `workspaces`,
`workspace_memberships`, `businesses`, `audit_logs`, `jobs`,
`provider_settings`, `cost_records`, `activity_events`.

---

## Conventions

- Primary keys are UUIDv4.
- Money is `Int` in minor units (cents) plus an ISO-4217 `currency` on the owning
  business. No floating point.
- Every tenant-scoped table carries an indexed, non-null `businessId`.
- Timestamps are `timestamptz`. `createdAt` / `updatedAt` on every mutable table.
- Deletes cascade down the ownership tree. `AuditLog.actorId` is the exception:
  `SET NULL`, so the audit record survives the account.
- Anything historical is **versioned, never overwritten**: prices, product
  facts, creatives, and performance snapshots accumulate.

---

## Phase 1 — identity, tenancy, auditing, jobs ✅ migrated

### `users`

`id`, `email` (unique), `passwordHash`, `name`, timestamps.

### `sessions`

`id`, `tokenHash` (unique — HMAC of the cookie token), `userId`, `expiresAt`,
`ipAddress`, `userAgent`, `createdAt`.

### `workspaces`

`id`, `slug` (unique), `name`, timestamps. The billing and ownership boundary.

### `workspace_memberships`

`id`, `userId`, `workspaceId`, `role` (`OWNER|ADMIN|MEMBER|VIEWER`).
Unique on `(userId, workspaceId)`.

### `businesses`

The tenant boundary for all advertising data.
`id`, `workspaceId`, `name`, `industry`, `websiteUrl`, `description`,
`currency`, `timezone`, `archivedAt`, timestamps.
Unique on `(workspaceId, name)`.

**The four things the owner chooses**, and nothing else:
`goal` (`SALES|LEADS|CUSTOMERS|AWARENESS`), `budgetAmountCents` +
`budgetPeriod` (`DAILY|MONTHLY`) stored exactly as entered, and
`automationMode` (`AUTOPILOT|ASK_ME_FIRST|MANUAL`, default `ASK_ME_FIRST`).
Null goal/budget means setup is unfinished, and nothing can spend.

**Emergency stop:** `pausedAt`, `pauseReason`. While `pausedAt` is non-null
nothing launches, spends, or runs automation — including work not yet created.

**Derived safeguards**, computed from the stated budget rather than typed in:
`maxDailyBudgetCents`, `maxCampaignBudgetCents`,
`budgetApprovalThresholdCents`. Always intersected with the platform ceilings.

### `audit_logs`

Append-only. `id`, `workspaceId`, `businessId?`, `actorType`
(`USER|SYSTEM|AI`), `actorId?`, `action`, `objectType?`, `objectId?`,
`previousValue`, `newValue`, `metadata`, `ipAddress`, `createdAt`.

`actorType` is what makes this worth keeping: it records whether a human or the
automation made each decision.

### `jobs`

`id`, `type`, `workspaceId`, `businessId?`, `status`
(`PENDING|RUNNING|SUCCEEDED|FAILED|DEAD|CANCELLED`), `priority`, `payload`,
`result`, `attempts`, `maxAttempts`, `runAt`, `startedAt`, `completedAt`,
`lastError`, `idempotencyKey` (unique), timestamps.
Indexed on `(status, runAt, priority)` for the claim query.

### `provider_settings`

Per-workspace opt-in for one provider implementation.
`id`, `workspaceId`, `capability`, `providerKey`, `tier`
(`LOCAL_FREE|EXTERNAL_PAID`), `enabled` (default **false**),
`maxDailyCostCents?`, `maxMonthlyCostCents?`, `enabledBy?`, `enabledAt?`.
Unique on `(workspaceId, capability, providerKey)`.

A capability with no row here uses its free implementation — so the
application works fully with this table empty, which is the default state.

### `cost_records`

Append-only, one row per provider invocation, **free or paid**.
`id`, `workspaceId`, `businessId?`, `kind`, `capability`, `providerKey`,
`tier`, `model?`, `units`, `unitLabel`, `estimatedCostCents`,
`actualCostCents?`, `subjectType?`, `subjectId?`, `succeeded`, `errorCode?`,
`createdAt`.

Free calls are recorded deliberately: "1,284 operations this month, $0.00" is
the most useful thing the cost page can say, and it needs the rows to say it.
`actualCostCents` is null when genuinely unknown — never back-filled with a
guess.

### `activity_events`

The owner-facing feed, separate from `audit_logs` by design.
`id`, `workspaceId`, `businessId`, `kind`, `severity`
(`INFO|NOTICE|ATTENTION`), `message`, `detail?`, `needsAttention`,
`resolvedAt?`, `createdAt`.

`message` is one plain sentence composed server-side from verified values — a
model's prose never becomes an activity message, or the feed would inherit
every hallucination. Everything here is also in the audit log; not everything
in the audit log belongs here.

---

## Phase 2 — website knowledge

### `websites`

`id`, `businessId`, `rootUrl`, `sitemapUrl?`, `robotsTxt?`, `lastScannedAt`,
`scanStatus`, `platformHint` (Shopify / WooCommerce / unknown — a hint for
extraction strategy, never a hard-coded assumption).

### `website_pages`

`id`, `businessId`, `websiteId`, `url`, `pageType`
(`HOME|PRODUCT|COLLECTION|ABOUT|FAQ|SHIPPING|RETURNS|CONTACT|POLICY|BLOG|OTHER`),
`title`, `rawHtmlRef` (object-storage key, not inline), `extractedText`,
`structuredData` (JSON-LD / OpenGraph), `contentHash`, `httpStatus`,
`fetchedAt`.

`contentHash` is what makes rescans cheap and change detection exact.

### `products`

`id`, `businessId`, `websiteId`, `externalId?`, `name`, `description`,
`priceCents`, `originalPriceCents?`, `costCents?` (merchant-supplied only —
**never inferred**), `currency`, `availability`, `productUrl`, `category`,
`tags`, `contentHash`, `firstSeenAt`, `lastSeenAt`, `removedAt?`.

### `product_versions`

Every change to a product creates a row here rather than overwriting.
`id`, `businessId`, `productId`, `snapshot` (JSON), `changedFields`,
`detectedAt`. This is what §48/§49 require: a price moving from $9.99 to $11.99
preserves the old value and flags campaigns carrying outdated information.

### `product_variants`

`id`, `businessId`, `productId`, `sku?`, `name`, `priceCents`, `availability`,
`attributes` (JSON).

### `product_images`

`id`, `businessId`, `productId`, `sourceUrl`, `storageKey`, `width`, `height`,
`isPrimary`, `altText?`.

### `business_facts` / `product_facts`

The provenance layer. `id`, `businessId`, `productId?`, `key`, `value`,
`sourceUrl`, `sourceExcerpt`, `confidence` (0–1), `extractionMethod`
(`JSON_LD|OPENGRAPH|HTML|TEXT|MERCHANT_PROVIDED`), `verifiedAt`.

Separate from anything AI-generated. A row here is traceable to a URL.

---

## Phase 3 — marketing engine

### `business_profiles`

`id`, `businessId` (unique), `valueProposition`, `brandVoice`, `brandColors`,
`brandFonts`, `restrictions`, `policies`, `generatedAt`, `aiDecisionId`.

### `ai_inferences`

Everything the model concluded rather than read. `id`, `businessId`,
`subjectType`, `subjectId`, `kind` (`AUDIENCE_HYPOTHESIS|MOTIVATION|OBJECTION|
USE_CASE|SEASONAL_OPPORTUNITY|…`), `statement`, `reasoning`, `uncertainty`,
`supportingFactIds`, `createdAt`.

Kept in a different table from `*_facts` on purpose. The UI renders them
differently and they are never presented as verified.

### `marketing_strategies`

`id`, `businessId`, `productId?`, `angle`
(`PROBLEM_SOLUTION|BENEFIT|DEMONSTRATION|LIFESTYLE|SEASONAL|GIFT|VALUE|
SOCIAL_PROOF|URGENCY|EDUCATIONAL|COMPARISON`), `hypothesis`, `hook`,
`suggestedCta`, `assumptions`, `testingVariables`, `aiDecisionId`, `createdAt`.

No numeric quality score. Structured reasoning and assumptions instead — §10.

### `offers`

`id`, `businessId`, `productId?`, `type`
(`PERCENT_OFF|FIXED_OFF|BXGY|BUNDLE|FREE_SHIPPING|SEASONAL`), `value`,
`resultingPriceCents?`, `marginKnown` (boolean), `estimatedMarginCents?`,
`rationale`, `status` (`PROPOSED|APPROVED|REJECTED|ACTIVE|EXPIRED`),
`approvedBy?`, `approvedAt?`, `startsAt?`, `endsAt?`.

`marginKnown` exists because §9 forbids inventing a cost. When cost is unknown
the margin is recorded as unavailable, not estimated.

### `offer_rules`

Per-business merchant constraints. `id`, `businessId` (unique),
`maxDiscountPercent`, `minDiscountPercent`, `minMarginPercent?`,
`allowPercentage`, `allowFixed`, `allowBundles`, `allowFreeShipping`,
`allowSeasonal`, `allowAutomatic`, `requireApproval`.

### `ad_copies`

`id`, `businessId`, `productId`, `strategyId`, `offerId?`, `primaryText`,
`headline`, `description`, `cta`, `variantLabel`, `aiDecisionId`, `status`.

### `ai_decisions`

`id`, `businessId`, `kind`, `inputSummary`, `reasoningSummary`, `output` (JSON),
`uncertainty`, `dataSourceIds`, `provider`, `model`, `promptTokens`,
`completionTokens`, `estimatedCostCents`, `createdAt`.

A concise decision explanation — §51 explicitly does not want hidden
chain-of-thought stored.

---

## Phase 4 — creative

### `creative_formats`

Data-driven, not hard-coded. `id`, `platform`, `name`, `width`, `height`,
`aspectRatio`, `safeAreaInsets` (JSON), `maxFileBytes`, `allowedMimeTypes`.

### `creative_templates`

`id`, `businessId?` (null = platform-global), `key`
(`PROMOTIONAL_PRODUCT|SEASONAL|MINIMAL_PRODUCT|PROBLEM_SOLUTION|SOCIAL_PROOF|
PRODUCT_FEATURE|COLLECTION|SALE`), `config` (typography, spacing, background,
product placement, offer badge, CTA, brand elements).

### `creatives`

The logical creative. `id`, `businessId`, `productId`, `strategyId`, `offerId?`,
`adCopyId?`, `templateId`, `concept`, `status`
(`DRAFT|GENERATING|QA|NEEDS_REVIEW|APPROVED|REJECTED|PUBLISHED|PAUSED|ARCHIVED`),
`currentVersionId`.

### `creative_versions`

Immutable. `id`, `businessId`, `creativeId`, `versionNumber`, `formatId`,
`storageKey`, `width`, `height`, `mimeType`, `bytes`, `generationPrompt`,
`sourceAssetIds`, `provider`, `model`, `generatedAt`, `qaStatus`,
`qaFindings` (JSON), `approvedBy?`, `approvedAt?`.

Everything needed to explain later why a creative performed the way it did.

### `creative_qa_checks`

`id`, `businessId`, `creativeVersionId`, `check`
(`PRODUCT_MATCH|PRICE_MATCH|DISCOUNT_MATCH|BRAND_MATCH|READABILITY|
TEXT_CORRUPTION|MISLEADING_CLAIM|SAFE_AREA|DIMENSIONS|FILE_TYPE`),
`outcome` (`PASS|FAIL|SKIPPED`), `detail`, `checkedAt`.

Per-check rows, not one verdict: a failure has to say _which_ rule it broke.

### `brand_systems`

`id`, `businessId` (unique), `logoStorageKey?`, `primaryColor`,
`secondaryColors`, `fontPreferences`, `tone`, `visualStyle`, `imageStyle`,
`ctaStyle`, `source` (`EXTRACTED|MANUAL`).

---

## Phase 5/6 — campaigns and advertising providers

### `integrations`

`id`, `workspaceId`, `businessId`, `provider` (`META|GOOGLE|TIKTOK|MOCK`),
`externalAccountId`, `status`, `connectedAt`, `lastSyncedAt`, `scopes`.

### `oauth_credentials`

`id`, `integrationId` (unique), `encryptedAccessToken`,
`encryptedRefreshToken?`, `expiresAt?`, `rotatedAt`.

Ciphertext only — AES-256-GCM, AAD-bound to the integration id.

### `campaigns`

`id`, `businessId`, `integrationId?`, `externalId?`, `name`, `objective`,
`status` (`DRAFT|PENDING_APPROVAL|SCHEDULED|ACTIVE|PAUSED|COMPLETED|FAILED`),
`dailyBudgetCents?`, `lifetimeBudgetCents?`, `startsAt`, `endsAt?`,
`approvedBy?`, `approvedAt?`, `launchedAt?`.

### `ad_sets`

`id`, `businessId`, `campaignId`, `externalId?`, `name`, `audienceId?`,
`placements`, `dailyBudgetCents?`, `status`.

### `ads`

`id`, `businessId`, `adSetId`, `creativeVersionId`, `adCopyId`, `externalId?`,
`status`, `rejectionReason?`.

### `audiences`

`id`, `businessId`, `name`, `kind` (`HYPOTHESIS|VERIFIED`), `definition` (JSON),
`rationale`, `sourceInferenceId?`.

`kind` keeps §20's distinction: an audience hypothesis is not demographic data.

### `budget_approvals`

`id`, `businessId`, `campaignId`, `requestedBy`, `requestedCents`,
`priorCents?`, `reason`, `status`, `decidedBy?`, `decidedAt?`.

### `webhook_events`

`id`, `provider`, `externalEventId` (unique — idempotency), `signatureVerified`,
`payload`, `receivedAt`, `processedAt?`.

---

## Phase 7 — performance

### `performance_snapshots`

Append-only; never updated. `id`, `businessId`, `scope`
(`CAMPAIGN|AD_SET|AD|CREATIVE`), `scopeId`, `periodStart`, `periodEnd`,
`impressions`, `reach`, `clicks`, `ctr`, `cpcCents`, `cpmCents`, `addToCarts`,
`purchases`, `purchaseValueCents`, `cpaCents`, `roas`, `conversionRate`,
`spendCents`, `currency`, `dataFreshness` (`LIVE|SYNCED|HISTORICAL|ESTIMATED`),
`syncedAt`.

`dataFreshness` is what stops stale numbers being presented as live — §43.

### `sync_runs`

`id`, `businessId`, `integrationId`, `startedAt`, `finishedAt?`, `status`,
`recordsWritten`, `error?`.

---

## Phase 8 — experiments

### `experiments`

`id`, `businessId`, `name`, `hypothesis`, `variable`
(`CREATIVE_CONCEPT|DISCOUNT_VISIBILITY|COPY_HOOK|OFFER_SIZE|AUDIENCE|FORMAT|CTA`),
`status`, `startedAt`, `endedAt?`, `conclusion?`, `confidence?`, `sampleSize?`.

### `experiment_variants`

`id`, `businessId`, `experimentId`, `label` (`CONTROL` or a variant name),
`creativeVersionId?`, `adCopyId?`, `offerId?`, `audienceId?`, `adId?`,
`resultSummary?`.

---

## Phase 9 — learning

### `ai_insights`

`id`, `businessId`, `scope` (`BUSINESS|PRODUCT|CREATIVE|OFFER|AUDIENCE|CAMPAIGN`),
`scopeId?`, `statement`, `evidence` (JSON), `sampleSize`, `periodStart`,
`periodEnd`, `confidence`, `caveats`, `generatedAt`.

`sampleSize`, the period, and `caveats` are mandatory columns, not optional
decoration: §22 forbids drawing strong conclusions from small datasets, and a
nullable sample size makes that easy to forget.

### `knowledge_entries`

`id`, `layer` (`GLOBAL|BUSINESS|PRODUCT|CAMPAIGN|CREATIVE`), `businessId?`
(null only for `GLOBAL`), `subjectId?`, `key`, `value`, `evidenceIds`,
`supersededById?`, `createdAt`.

A database constraint enforces that every non-`GLOBAL` layer has a
`businessId` — §24's "do not mix data between businesses" at the storage level.

---

## Phase 10 — automation

### `automation_rules`

`id`, `businessId`, `trigger` (`SCHEDULE|CTR_BELOW|CPA_ABOVE|CREATIVE_AGE|
ROAS_BELOW`), `condition` (JSON), `action`, `enabled`, `requiresApproval`,
`lastFiredAt?`.

`cost_records` already exists — see Phase 1 above. Phase 10 adds the
per-business generation caps that read from it.
