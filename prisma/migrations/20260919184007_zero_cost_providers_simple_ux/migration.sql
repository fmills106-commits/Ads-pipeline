-- CreateEnum
CREATE TYPE "AutomationMode" AS ENUM ('AUTOPILOT', 'ASK_ME_FIRST', 'MANUAL');

-- CreateEnum
CREATE TYPE "BusinessGoal" AS ENUM ('SALES', 'LEADS', 'CUSTOMERS', 'AWARENESS');

-- CreateEnum
CREATE TYPE "BudgetPeriod" AS ENUM ('DAILY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ProviderCapability" AS ENUM ('AI', 'IMAGE_GENERATION', 'ADVERTISING', 'STORAGE', 'ANALYTICS', 'SEARCH', 'EMBEDDING');

-- CreateEnum
CREATE TYPE "ProviderTier" AS ENUM ('LOCAL_FREE', 'EXTERNAL_PAID');

-- CreateEnum
CREATE TYPE "CostKind" AS ENUM ('AI_CALL', 'IMAGE_GENERATION', 'STORAGE', 'API_CALL', 'EMBEDDING', 'SEARCH');

-- CreateEnum
CREATE TYPE "ActivitySeverity" AS ENUM ('INFO', 'NOTICE', 'ATTENTION');

-- AlterTable
-- The four-level automation scale collapses to three owner-facing choices.
-- Existing rows are mapped rather than dropped: the generated migration would
-- have discarded `automationLevel` and silently reset every business to the
-- default, which for a setting that governs autonomous spending is not an
-- acceptable way to lose data.
ALTER TABLE "businesses"
ADD COLUMN     "automationMode" "AutomationMode" NOT NULL DEFAULT 'ASK_ME_FIRST',
ADD COLUMN     "budgetAmountCents" INTEGER,
ADD COLUMN     "budgetPeriod" "BudgetPeriod",
ADD COLUMN     "goal" "BusinessGoal",
ADD COLUMN     "pauseReason" TEXT,
ADD COLUMN     "pausedAt" TIMESTAMP(3);

-- Map the old scale onto the new one. Where the old scale was more permissive
-- than any new value cleanly corresponds to, the mapping rounds towards LESS
-- autonomy, never more.
--   MANUAL     -> MANUAL        (unchanged)
--   ASSISTED   -> ASK_ME_FIRST  (publishing already required approval)
--   SUPERVISED -> ASK_ME_FIRST  (rounds down: campaigns were automatic)
--   AUTONOMOUS -> AUTOPILOT     (unchanged in spirit)
UPDATE "businesses" SET "automationMode" =
  CASE "automationLevel"::text
    WHEN 'MANUAL'     THEN 'MANUAL'::"AutomationMode"
    WHEN 'ASSISTED'   THEN 'ASK_ME_FIRST'::"AutomationMode"
    WHEN 'SUPERVISED' THEN 'ASK_ME_FIRST'::"AutomationMode"
    WHEN 'AUTONOMOUS' THEN 'AUTOPILOT'::"AutomationMode"
    ELSE 'ASK_ME_FIRST'::"AutomationMode"
  END;

ALTER TABLE "businesses" DROP COLUMN "automationLevel";

-- DropEnum
DROP TYPE "AutomationLevel";

-- CreateTable
CREATE TABLE "provider_settings" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "capability" "ProviderCapability" NOT NULL,
    "providerKey" TEXT NOT NULL,
    "tier" "ProviderTier" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "maxDailyCostCents" INTEGER,
    "maxMonthlyCostCents" INTEGER,
    "enabledBy" UUID,
    "enabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_records" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "businessId" UUID,
    "kind" "CostKind" NOT NULL,
    "capability" "ProviderCapability" NOT NULL,
    "providerKey" TEXT NOT NULL,
    "tier" "ProviderTier" NOT NULL,
    "model" TEXT,
    "units" INTEGER NOT NULL DEFAULT 0,
    "unitLabel" TEXT,
    "estimatedCostCents" INTEGER NOT NULL DEFAULT 0,
    "actualCostCents" INTEGER,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "succeeded" BOOLEAN NOT NULL DEFAULT true,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" "ActivitySeverity" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_settings_workspaceId_capability_idx" ON "provider_settings"("workspaceId", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "provider_settings_workspaceId_capability_providerKey_key" ON "provider_settings"("workspaceId", "capability", "providerKey");

-- CreateIndex
CREATE INDEX "cost_records_workspaceId_createdAt_idx" ON "cost_records"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "cost_records_businessId_createdAt_idx" ON "cost_records"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "cost_records_workspaceId_tier_createdAt_idx" ON "cost_records"("workspaceId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "cost_records_capability_createdAt_idx" ON "cost_records"("capability", "createdAt");

-- CreateIndex
CREATE INDEX "activity_events_businessId_createdAt_idx" ON "activity_events"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_events_businessId_needsAttention_idx" ON "activity_events"("businessId", "needsAttention");

-- AddForeignKey
ALTER TABLE "provider_settings" ADD CONSTRAINT "provider_settings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

