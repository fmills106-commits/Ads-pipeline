-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PageType" AS ENUM ('HOME', 'PRODUCT', 'COLLECTION', 'ABOUT', 'FAQ', 'SHIPPING', 'RETURNS', 'CONTACT', 'POLICY', 'BLOG', 'OTHER');

-- CreateEnum
CREATE TYPE "Availability" AS ENUM ('IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ExtractionMethod" AS ENUM ('JSON_LD', 'OPENGRAPH', 'MICRODATA', 'HTML', 'TEXT_PATTERN', 'MERCHANT_PROVIDED');

-- AlterEnum
ALTER TYPE "CostKind" ADD VALUE 'WEB_FETCH';

-- AlterEnum
ALTER TYPE "ProviderCapability" ADD VALUE 'WEB_FETCH';

-- CreateTable
CREATE TABLE "websites" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "rootUrl" TEXT NOT NULL,
    "resolvedRootUrl" TEXT,
    "robotsTxt" TEXT,
    "robotsFetchedAt" TIMESTAMP(3),
    "sitemapUrls" TEXT[],
    "platformHint" TEXT,
    "lastScanAt" TIMESTAMP(3),
    "lastScanRunId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "websites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_runs" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "websiteId" UUID,
    "status" "ScanStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedUrl" TEXT NOT NULL,
    "jobId" UUID,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "pagesSkipped" INTEGER NOT NULL DEFAULT 0,
    "bytesFetched" INTEGER NOT NULL DEFAULT 0,
    "productsFound" INTEGER NOT NULL DEFAULT 0,
    "factsExtracted" INTEGER NOT NULL DEFAULT 0,
    "stopReason" TEXT,
    "warnings" JSONB,
    "error" JSONB,
    "changeSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_pages" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "websiteId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "finalUrl" TEXT,
    "pageType" "PageType" NOT NULL DEFAULT 'OTHER',
    "httpStatus" INTEGER NOT NULL,
    "title" TEXT,
    "metaDescription" TEXT,
    "extractedText" TEXT,
    "structuredData" JSONB,
    "contentHash" TEXT NOT NULL,
    "outboundLinkCount" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "websiteId" UUID NOT NULL,
    "productUrl" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceCents" INTEGER,
    "comparePriceCents" INTEGER,
    "currency" TEXT,
    "costCents" INTEGER,
    "availability" "Availability" NOT NULL DEFAULT 'UNKNOWN',
    "category" TEXT,
    "brand" TEXT,
    "sku" TEXT,
    "tags" TEXT[],
    "statedOffers" JSONB,
    "callsToAction" TEXT[],
    "contentHash" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "altText" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_versions" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedFields" TEXT[],
    "scanRunId" UUID,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_facts" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceExcerpt" TEXT,
    "method" "ExtractionMethod" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "scanRunId" UUID,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_facts" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceExcerpt" TEXT,
    "method" "ExtractionMethod" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "scanRunId" UUID,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_facts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "websites_businessId_idx" ON "websites"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "websites_businessId_rootUrl_key" ON "websites"("businessId", "rootUrl");

-- CreateIndex
CREATE INDEX "scan_runs_businessId_createdAt_idx" ON "scan_runs"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "scan_runs_websiteId_createdAt_idx" ON "scan_runs"("websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "scan_runs_status_idx" ON "scan_runs"("status");

-- CreateIndex
CREATE INDEX "website_pages_businessId_pageType_idx" ON "website_pages"("businessId", "pageType");

-- CreateIndex
CREATE INDEX "website_pages_websiteId_fetchedAt_idx" ON "website_pages"("websiteId", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "website_pages_websiteId_url_key" ON "website_pages"("websiteId", "url");

-- CreateIndex
CREATE INDEX "products_businessId_removedAt_idx" ON "products"("businessId", "removedAt");

-- CreateIndex
CREATE INDEX "products_websiteId_lastSeenAt_idx" ON "products"("websiteId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "products_websiteId_productUrl_key" ON "products"("websiteId", "productUrl");

-- CreateIndex
CREATE INDEX "product_images_productId_idx" ON "product_images"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "product_images_productId_sourceUrl_key" ON "product_images"("productId", "sourceUrl");

-- CreateIndex
CREATE INDEX "product_versions_productId_detectedAt_idx" ON "product_versions"("productId", "detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "product_versions_productId_versionNumber_key" ON "product_versions"("productId", "versionNumber");

-- CreateIndex
CREATE INDEX "business_facts_businessId_key_idx" ON "business_facts"("businessId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "business_facts_businessId_key_value_key" ON "business_facts"("businessId", "key", "value");

-- CreateIndex
CREATE INDEX "product_facts_productId_key_idx" ON "product_facts"("productId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "product_facts_productId_key_value_key" ON "product_facts"("productId", "key", "value");

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_pages" ADD CONSTRAINT "website_pages_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_pages" ADD CONSTRAINT "website_pages_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_facts" ADD CONSTRAINT "business_facts_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_facts" ADD CONSTRAINT "product_facts_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

