-- Phase 3 — the marketing engine.
--
-- Seven tables, all additive: nothing existing is altered or dropped, so this
-- applies to a populated database without touching a row of it.
--
-- The separation worth noticing is `ai_inferences` sitting beside the Phase 2
-- `business_facts` / `product_facts` rather than joining them. A fact carries
-- a source URL and an extraction method; an inference carries reasoning and an
-- uncertainty. No operation moves a row between them, and the UI renders them
-- differently — which is what "distinguish verified information from AI
-- inference" has to mean at the storage layer to mean anything at all.
--
-- `offers.marginKnown` is the other deliberate column: the engine may not
-- invent a cost price, so an offer on a product whose cost the merchant never
-- supplied records its margin as unavailable rather than estimated.

-- CreateEnum
CREATE TYPE "InferenceKind" AS ENUM ('AUDIENCE_HYPOTHESIS', 'MOTIVATION', 'OBJECTION', 'USE_CASE', 'SEASONAL_OPPORTUNITY');

-- CreateEnum
CREATE TYPE "Uncertainty" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "StrategyAngle" AS ENUM ('PROBLEM_SOLUTION', 'BENEFIT', 'DEMONSTRATION', 'LIFESTYLE', 'SEASONAL', 'GIFT', 'VALUE', 'SOCIAL_PROOF', 'URGENCY', 'EDUCATIONAL', 'COMPARISON');

-- CreateEnum
CREATE TYPE "OfferType" AS ENUM ('PERCENT_OFF', 'FIXED_OFF', 'BXGY', 'BUNDLE', 'FREE_SHIPPING', 'SEASONAL');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'ACTIVE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AdCopyStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "ai_decisions" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "inputSummary" TEXT NOT NULL,
    "reasoningSummary" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "uncertainty" TEXT NOT NULL DEFAULT 'medium',
    "factIds" TEXT[],
    "providerKey" TEXT NOT NULL,
    "model" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "estimatedCostCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_profiles" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "valueProposition" TEXT NOT NULL,
    "brandVoice" TEXT NOT NULL,
    "restrictions" TEXT[],
    "aiDecisionId" UUID,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_inferences" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "subjectType" TEXT,
    "subjectId" UUID,
    "kind" "InferenceKind" NOT NULL,
    "statement" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "uncertainty" "Uncertainty" NOT NULL DEFAULT 'MEDIUM',
    "supportingFactIds" TEXT[],
    "aiDecisionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_inferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_strategies" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "productId" UUID,
    "angle" "StrategyAngle" NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "suggestedCta" TEXT NOT NULL,
    "assumptions" TEXT[],
    "testingVariables" TEXT[],
    "aiDecisionId" UUID,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_strategies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_rules" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "maxDiscountPercent" INTEGER NOT NULL DEFAULT 20,
    "minDiscountPercent" INTEGER NOT NULL DEFAULT 5,
    "minMarginPercent" INTEGER,
    "allowPercentage" BOOLEAN NOT NULL DEFAULT true,
    "allowFixed" BOOLEAN NOT NULL DEFAULT true,
    "allowBundles" BOOLEAN NOT NULL DEFAULT false,
    "allowFreeShipping" BOOLEAN NOT NULL DEFAULT true,
    "allowSeasonal" BOOLEAN NOT NULL DEFAULT true,
    "allowAutomatic" BOOLEAN NOT NULL DEFAULT false,
    "requireApproval" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "productId" UUID,
    "type" "OfferType" NOT NULL,
    "value" INTEGER,
    "resultingPriceCents" INTEGER,
    "marginKnown" BOOLEAN NOT NULL DEFAULT false,
    "estimatedMarginCents" INTEGER,
    "rationale" TEXT NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'PROPOSED',
    "approvedBy" UUID,
    "approvedAt" TIMESTAMP(3),
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "aiDecisionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_copies" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "strategyId" UUID NOT NULL,
    "offerId" UUID,
    "primaryText" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "cta" TEXT NOT NULL,
    "variantLabel" TEXT NOT NULL,
    "status" "AdCopyStatus" NOT NULL DEFAULT 'DRAFT',
    "aiDecisionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_copies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_decisions_businessId_createdAt_idx" ON "ai_decisions"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_decisions_businessId_kind_idx" ON "ai_decisions"("businessId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "business_profiles_businessId_key" ON "business_profiles"("businessId");

-- CreateIndex
CREATE INDEX "ai_inferences_businessId_kind_idx" ON "ai_inferences"("businessId", "kind");

-- CreateIndex
CREATE INDEX "ai_inferences_businessId_createdAt_idx" ON "ai_inferences"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "marketing_strategies_businessId_createdAt_idx" ON "marketing_strategies"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "marketing_strategies_productId_idx" ON "marketing_strategies"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "offer_rules_businessId_key" ON "offer_rules"("businessId");

-- CreateIndex
CREATE INDEX "offers_businessId_status_idx" ON "offers"("businessId", "status");

-- CreateIndex
CREATE INDEX "offers_productId_idx" ON "offers"("productId");

-- CreateIndex
CREATE INDEX "ad_copies_businessId_status_idx" ON "ad_copies"("businessId", "status");

-- CreateIndex
CREATE INDEX "ad_copies_productId_idx" ON "ad_copies"("productId");

-- CreateIndex
CREATE INDEX "ad_copies_strategyId_idx" ON "ad_copies"("strategyId");

-- AddForeignKey
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_aiDecisionId_fkey" FOREIGN KEY ("aiDecisionId") REFERENCES "ai_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_inferences" ADD CONSTRAINT "ai_inferences_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_inferences" ADD CONSTRAINT "ai_inferences_aiDecisionId_fkey" FOREIGN KEY ("aiDecisionId") REFERENCES "ai_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_strategies" ADD CONSTRAINT "marketing_strategies_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_strategies" ADD CONSTRAINT "marketing_strategies_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_strategies" ADD CONSTRAINT "marketing_strategies_aiDecisionId_fkey" FOREIGN KEY ("aiDecisionId") REFERENCES "ai_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_rules" ADD CONSTRAINT "offer_rules_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_aiDecisionId_fkey" FOREIGN KEY ("aiDecisionId") REFERENCES "ai_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_copies" ADD CONSTRAINT "ad_copies_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_copies" ADD CONSTRAINT "ad_copies_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_copies" ADD CONSTRAINT "ad_copies_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "marketing_strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_copies" ADD CONSTRAINT "ad_copies_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_copies" ADD CONSTRAINT "ad_copies_aiDecisionId_fkey" FOREIGN KEY ("aiDecisionId") REFERENCES "ai_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

