-- An owner's own API key, held here instead of in the hosting environment.
--
-- Additive and nullable, so this applies to a populated database without
-- touching a row. A deployment that keeps its key in the environment carries
-- four nulls per provider row and behaves exactly as before.
--
-- Why this exists. Enabling the paid writer took three steps and the middle one
-- was a wall: open the hosting platform's environment-variable panel, paste a
-- secret into a form that cannot tell a good paste from a bad one, and
-- redeploy. That is the same panel that had already broken this project's
-- deployment once with a malformed connection string, and it is not something a
-- shop owner should have to touch to turn on a feature. With the key here, the
-- owner pastes it into Settings and presses a button.
--
-- What is stored is the ciphertext from `encryptSecret`, bound by its
-- authenticated-additional-data to this workspace and provider key, so a row
-- copied to another workspace fails to decrypt rather than quietly working. The
-- plaintext is never written here, never returned to a browser, and never
-- logged. `secretHint` holds the last four characters only — enough for an owner
-- to recognise which key is installed, useless to anyone who obtains it.
--
-- This does not weaken the three switches in front of paid spend. A stored key
-- satisfies exactly one of them, the same one an environment variable
-- satisfied: credentials exist. Zero-cost mode and per-workspace enablement are
-- untouched, so pasting a key still spends nothing on its own.

ALTER TABLE "provider_settings"
  ADD COLUMN "secretCiphertext" TEXT,
  ADD COLUMN "secretHint"       TEXT,
  ADD COLUMN "secretSetBy"      UUID,
  ADD COLUMN "secretSetAt"      TIMESTAMP(3);
