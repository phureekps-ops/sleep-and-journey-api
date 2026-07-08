-- Backs rate limiting on /auth/register. Simpler than login_attempts: every
-- attempt (success or failure) counts against the same IP, since even a
-- failed registration (e.g. duplicate email) still costs server work and
-- can be used to enumerate which emails already have accounts.

CREATE TABLE IF NOT EXISTS registration_attempts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address   VARCHAR(45) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_registration_attempts_ip ON registration_attempts (ip_address, created_at);
