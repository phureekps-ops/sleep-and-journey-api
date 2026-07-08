-- Backs rate limiting on /auth/login and /admin/auth/login. Every attempt
-- (success or failure) is logged; rateLimitService only counts failures
-- within a rolling window, so this doubles as a basic audit trail of login
-- activity too.

CREATE TABLE IF NOT EXISTS login_attempts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login_type   VARCHAR(10) NOT NULL, -- 'guest' | 'staff'
  email        VARCHAR(150) NOT NULL, -- stored lowercased for rate-limit bucketing only
  ip_address   VARCHAR(45) NOT NULL,  -- long enough for an IPv6 address
  success      BOOLEAN NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts (login_type, email, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts (ip_address, created_at);
