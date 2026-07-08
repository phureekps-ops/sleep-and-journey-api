-- Sleep&Journey reservation system - core schema (booking flow subset)
-- Run with: npm run migrate  (requires DATABASE_URL env var)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS branches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(150) NOT NULL,
  province    VARCHAR(100) NOT NULL,
  region      VARCHAR(50)  NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_types (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      UUID NOT NULL REFERENCES branches(id),
  name           VARCHAR(100) NOT NULL,
  base_price     NUMERIC(10,2) NOT NULL,
  max_occupancy  SMALLINT NOT NULL DEFAULT 2,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_type_id  UUID NOT NULL REFERENCES room_types(id),
  room_number   VARCHAR(20) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'available'
);

CREATE TABLE IF NOT EXISTS guests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name  VARCHAR(100) NOT NULL,
  last_name   VARCHAR(100),
  email       VARCHAR(150) NOT NULL UNIQUE,
  phone       VARCHAR(20),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bookings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_code     VARCHAR(20) NOT NULL UNIQUE,
  branch_id        UUID NOT NULL REFERENCES branches(id),
  room_type_id     UUID NOT NULL REFERENCES room_types(id),
  guest_id         UUID NOT NULL REFERENCES guests(id),
  checkin_date     DATE NOT NULL,
  checkout_date    DATE NOT NULL,
  guests_count     SMALLINT NOT NULL DEFAULT 2,
  status           VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | confirmed | cancelled | completed | no_show
  total_price      NUMERIC(10,2) NOT NULL,
  special_request  TEXT,
  hold_expires_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_dates CHECK (checkout_date > checkin_date)
);

-- Speeds up the overlap-count query used by the locking logic in bookingService.js
CREATE INDEX IF NOT EXISTS idx_bookings_roomtype_dates
  ON bookings (room_type_id, checkin_date, checkout_date);

-- Backs idempotent POST /bookings: same Idempotency-Key always returns the same response
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key            VARCHAR(100) PRIMARY KEY,
  status_code    INT NOT NULL,
  response_body  JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Seed data for local testing ----------
-- One branch, one room type with only 2 physical rooms, so you can
-- deliberately trigger the "sold out" (409 ROOM_NOT_AVAILABLE) case.

INSERT INTO branches (id, name, province, region)
VALUES ('11111111-1111-1111-1111-111111111111', 'Sleep&Journey ภูเก็ต', 'ภูเก็ต', 'ใต้')
ON CONFLICT (id) DO NOTHING;

INSERT INTO room_types (id, branch_id, name, base_price, max_occupancy)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Pool Villa', 5170, 4)
ON CONFLICT (id) DO NOTHING;

INSERT INTO rooms (room_type_id, room_number)
SELECT '22222222-2222-2222-2222-222222222222', room_number
FROM (VALUES ('V01'), ('V02')) AS r(room_number)
WHERE NOT EXISTS (SELECT 1 FROM rooms WHERE room_type_id = '22222222-2222-2222-2222-222222222222');
