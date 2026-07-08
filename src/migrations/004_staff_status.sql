-- Adds the ability to disable a staff account without deleting it.
-- Run with: npm run migrate

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
