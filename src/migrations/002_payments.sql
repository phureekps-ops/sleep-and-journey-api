-- Adds payment tracking on top of 001_init.sql
-- Run with: psql "$DATABASE_URL" -f src/migrations/002_payments.sql

CREATE TABLE IF NOT EXISTS payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          UUID NOT NULL REFERENCES bookings(id),
  amount              NUMERIC(10,2) NOT NULL,
  currency            VARCHAR(3) NOT NULL DEFAULT 'THB',
  method              VARCHAR(20) NOT NULL,          -- card | qr | transfer
  status              VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | paid | failed | refunded
  gateway             VARCHAR(20) NOT NULL,           -- omise | 2c2p | manual
  gateway_charge_id   VARCHAR(100),                   -- e.g. Omise charge id (chrg_xxx)
  gateway_ref         VARCHAR(150),                   -- e.g. 2C2P invoiceNo, or any other external reference
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments (booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_gateway_charge ON payments (gateway_charge_id);
CREATE INDEX IF NOT EXISTS idx_payments_gateway_ref ON payments (gateway_ref);

-- Audit log of every webhook we received, keyed so the same event can never
-- be double-counted even if the gateway retries delivery.
CREATE TABLE IF NOT EXISTS webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway       VARCHAR(20) NOT NULL,
  event_id      VARCHAR(150) NOT NULL,
  payload       JSONB NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gateway, event_id)
);
