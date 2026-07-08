-- Adds authentication, staff (CRM), and loyalty ledger on top of 001/002.
-- Run with: psql "$DATABASE_URL" -f src/migrations/003_auth.sql

ALTER TABLE guests
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255),
  ADD COLUMN IF NOT EXISTS member_tier VARCHAR(20) NOT NULL DEFAULT 'silver',
  ADD COLUMN IF NOT EXISTS points_balance INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS staff (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      UUID REFERENCES branches(id), -- NULL = HQ admin, sees every branch
  name           VARCHAR(100) NOT NULL,
  email          VARCHAR(150) NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  role           VARCHAR(20) NOT NULL, -- branch_staff | branch_manager | hq_admin
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refresh tokens are stored as a hash, never the raw token, exactly like a
-- password. A stolen row from a DB dump is useless without the plaintext
-- the client holds.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  VARCHAR(10) NOT NULL,     -- 'guest' | 'staff'
  subject_id    UUID NOT NULL,
  token_hash    VARCHAR(64) NOT NULL UNIQUE, -- sha256 hex digest
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_subject ON refresh_tokens (subject_type, subject_id);

-- Points ledger (never just a counter) so every change is auditable.
CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id        UUID NOT NULL REFERENCES guests(id),
  booking_id      UUID REFERENCES bookings(id),
  points_change   INT NOT NULL,
  balance_after   INT NOT NULL,
  type            VARCHAR(20) NOT NULL, -- earn | redeem | expire | bonus
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_guest ON loyalty_transactions (guest_id, created_at);

-- No staff accounts are seeded here on purpose - never put even a
-- placeholder password hash in a migration file. Create your first admin
-- with:  npm run seed:staff -- hq@sleepandjourney.com <password> hq_admin
