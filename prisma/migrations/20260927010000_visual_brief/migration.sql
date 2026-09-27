-- What the product looks like, written from its own photographs.
--
-- Additive and nullable, so this applies to a populated database without
-- touching a row.
--
-- Why it is stored on the product rather than left in `ai_decisions` with every
-- other generated thing: this is the one output an owner goes back to. They
-- paste it into an image tool, get a picture, change their mind about the
-- picture, and paste it again — so "the current description of how this looks"
-- has to be a thing you can look up, not a query for the latest row of a
-- particular kind whose subject is identified by a sentence in a summary field.
--
-- The decision record still exists alongside it, unchanged, so the question
-- "which call produced this, and what did it cost?" is still answerable.
--
-- The failure that earned this column: the engine produced an accurate reading
-- of a shop — soft slow-rising foam, 5.5 inches, sealed wrappers, twelve
-- Halloween designs, not edible, ages 14 and over — and an image generator fed
-- on it drew a bow-tied black cat and a Frankenstein head. Neither is sold.
-- Nothing had gone wrong with the writing: ad copy has nowhere to put
-- appearance, and a generator fills that silence with whatever the category
-- usually looks like. A brief is a different shape for a different job.

ALTER TABLE "products"
  ADD COLUMN "visualBrief"   JSONB,
  ADD COLUMN "visualBriefAt" TIMESTAMP(3);
