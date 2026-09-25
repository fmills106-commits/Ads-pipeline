-- Fixed-window rate-limit counters.
--
-- Kept in Postgres rather than Redis so no second datastore is needed, and in
-- a table rather than in memory because serverless invocations share none.
-- Rows are disposable: losing one re-opens a window, it corrupts nothing.

CREATE TABLE "rate_limits" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key")
);

-- Housekeeping deletes by expiry, so that is the only index needed beyond the
-- primary key the increment upserts against.
CREATE INDEX "rate_limits_expiresAt_idx" ON "rate_limits"("expiresAt");
