-- Audit trail for cancellations: who cancelled, why, and what happened to
-- the money. Kept separate from `bookings` (which only needs the current
-- status) so history survives even if a booking is later re-queried by
-- staff investigating a dispute.

CREATE TABLE IF NOT EXISTS booking_cancellations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          UUID NOT NULL REFERENCES bookings(id),
  cancelled_by_type   VARCHAR(10) NOT NULL, -- 'guest' | 'staff'
  cancelled_by_id     UUID NOT NULL,
  reason              TEXT,
  cancellation_fee    NUMERIC(10,2) NOT NULL DEFAULT 0,
  refund_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  refund_status       VARCHAR(30) NOT NULL, -- not_applicable | none | processing | manual_required | failed_needs_manual_review
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_cancellations_booking ON booking_cancellations (booking_id);
