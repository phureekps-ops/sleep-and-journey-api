const express = require('express');
const router = express.Router();
const loyaltyService = require('../services/loyaltyService');
const { requireAuth, requireGuest } = require('../middleware/auth');

// POST /v1/loyalty/redeem
// body: { booking_id, points }
// Guest-only, and always against the caller's own booking - req.auth.sub
// (not anything the client sends) is what's checked against the booking's
// guest_id inside loyaltyService.redeemPoints.
router.post('/loyalty/redeem', requireAuth, requireGuest, async (req, res, next) => {
  try {
    const { booking_id, points } = req.body;
    const result = await loyaltyService.redeemPoints({
      guestId: req.auth.sub,
      bookingId: booking_id,
      points,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
