const express = require('express');
const router = express.Router();
const bookingService = require('../services/bookingService');
const cancellationService = require('../services/cancellationService');
const AppError = require('../utils/AppError');
const { requireAuth } = require('../middleware/auth');

// POST /v1/bookings
// Header: Idempotency-Key: <uuid>  (recommended - safe to retry on network errors)
router.post('/bookings', async (req, res, next) => {
  try {
    const idempotencyKey = req.header('Idempotency-Key') || null;
    const { branch_id, room_type_id, checkin, checkout, guests_count, guest, special_request } = req.body;

    const result = await bookingService.createBooking({
      branchId: branch_id,
      roomTypeId: room_type_id,
      checkin,
      checkout,
      guestsCount: guests_count,
      guest,
      specialRequest: special_request,
      idempotencyKey,
    });

    res.status(result.statusCode).json(result.body);
  } catch (err) {
    next(err);
  }
});

// GET /v1/bookings/:id
router.get('/bookings/:id', async (req, res, next) => {
  try {
    const booking = await bookingService.getBookingById(req.params.id);
    res.status(200).json(booking);
  } catch (err) {
    next(err);
  }
});

// PATCH /v1/bookings/:id/cancel
// body: { reason }
// A guest can cancel their own booking; staff can cancel bookings within
// their branch scope (hq_admin: any branch). Ownership/scope is enforced
// inside cancellationService.cancelBooking, not just by which token type
// is allowed to call this route.
router.patch('/bookings/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const actor =
      req.auth.type === 'guest'
        ? { type: 'guest', id: req.auth.sub }
        : { type: 'staff', id: req.auth.sub, role: req.auth.role, branchId: req.auth.branch_id };

    const result = await cancellationService.cancelBooking({
      bookingId: req.params.id,
      actor,
      reason: req.body.reason,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
