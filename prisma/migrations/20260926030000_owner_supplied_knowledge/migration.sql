-- What the owner knows that their website does not say.
--
-- Additive and nullable, so this applies to a populated database without
-- touching a row.
--
-- `products.owner_description` is deliberately NOT a change to
-- `products.description`. That column holds what the page said, with a source
-- URL and an extraction method behind it, and a scan overwrites it — as it
-- should, because it is a record of the page. An owner's own words about their
-- product are a different kind of statement: they have no source URL, they are
-- not evidence of anything on the site, and a rescan must never silently
-- replace them. Two columns keeps both true, and keeps "verified fact" meaning
-- what it says.
--
-- The owner's version outranks the scraped one wherever both exist, because
-- the person selling the thing knows more about it than its product page does.

ALTER TABLE "products" ADD COLUMN "ownerDescription" TEXT;

-- When the owner last said something about this product, so the interface can
-- show that their words are being used rather than the page's.
ALTER TABLE "products" ADD COLUMN "ownerDescribedAt" TIMESTAMP(3);
