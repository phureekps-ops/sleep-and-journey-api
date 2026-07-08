-- Belt-and-suspenders alongside the application-level check in
-- loyaltyService.redeemPoints: even if two redeem requests for the same
-- booking somehow race past the app-level "already redeemed?" check at the
-- same instant, only one INSERT can succeed - the second hits this unique
-- index and fails with a 23505 error, which redeemPoints catches and turns
-- into a normal ALREADY_REDEEMED response instead of a raw 500.
CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_redeem_unique_per_booking
  ON loyalty_transactions (booking_id)
  WHERE type = 'redeem';
