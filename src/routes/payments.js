const express = require('express');
const router = express.Router();
const paymentService = require('../services/paymentService');

// POST /v1/bookings/:id/payment
// body: { "method": "card" | "qr" | "transfer", "card_token": "tokn_xxx" (card only),
//         "gateway": "omise" | "2c2p" (optional, defaults to "omise") }
// When gateway is "2c2p", method is ignored - 2C2P's hosted payment page
// lets the customer pick their own channel, so there's nothing to branch on.
router.post('/bookings/:id/payment', async (req, res, next) => {
  try {
    const { method, card_token, gateway } = req.body;
    const result = await paymentService.initiatePayment({
      bookingId: req.params.id,
      method,
      cardToken: card_token,
      gateway,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
