const pool = require('../db');
const AppError = require('../utils/AppError');
const omise = require('./paymentGateway/omiseClient');
const twoCtwoP = require('./paymentGateway/twoCtwoPClient');

// Simple, easy-to-quote cancellation policy. A real property chain would
// likely vary this per rate plan / season, but every booking uses the same
// three tiers here so guests always know what to expect before they cancel.
const FULL_REFUND_HOURS = 72; // 3+ days before check-in: no fee, full refund
const PARTIAL_REFUND_HOURS = 24; // 1-3 days before check-in: 50% fee
const PARTIAL_REFUND_RATE = 0.5;

function calculateCancellationFee(hoursUntilCheckin, amountPaid) {
  if (hoursUntilCheckin >= FULL_REFUND_HOURS) {
    return { fee: 0, refundAmount: amountPaid };
  }
  if (hoursUntilCheckin >= PARTIAL_REFUND_HOURS) {
    const fee = Math.round(amountPaid * PARTIAL_REFUND_RATE);
    return { fee, refundAmount: amountPaid - fee };
  }
  return { fee: amountPaid, refundAmount: 0 }; // inside 24 hours (or already past check-in): no refund
}

/**
 * PATCH /bookings/:id/cancel
 *
 * actor: { type:'guest', id } for a guest cancelling their own booking, or
 * { type:'staff', id, role, branchId } for a staff member cancelling on a
 * guest's behalf - branch-scoped exactly like adminBookings.js: a
 * non-hq_admin staff member can only cancel bookings at their own branch.
 */
async function cancelBooking({ bookingId, actor, reason }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bookingRes = await client.query(
      `SELECT id, guest_id, branch_id, status, total_price, checkin_date FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );
    if (bookingRes.rows.length === 0) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'ไม่พบการจองนี้');
    }
    const booking = bookingRes.rows[0];

    if (actor.type === 'guest' && booking.guest_id !== actor.id) {
      throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ยกเลิกการจองนี้');
    }
    if (actor.type === 'staff' && actor.role !== 'hq_admin' && booking.branch_id !== actor.branchId) {
      throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ยกเลิกการจองของสาขาอื่น');
    }
    if (['cancelled', 'completed', 'expired'].includes(booking.status)) {
      throw new AppError(409, 'CANNOT_CANCEL', `การจองนี้อยู่ในสถานะ '${booking.status}' ไม่สามารถยกเลิกได้`);
    }

    // A 'pending' booking that was never paid has nothing to refund - it
    // just gets cancelled outright (its hold would have expired on its own
    // anyway; this just does it immediately at the guest's request).
    const paymentRes = await client.query(
      `SELECT id, amount, gateway, gateway_charge_id, gateway_ref FROM payments
       WHERE booking_id = $1 AND status = 'paid'
       ORDER BY paid_at DESC LIMIT 1
       FOR UPDATE`,
      [bookingId]
    );

    let cancellationFee = 0;
    let refundAmount = 0;
    let refundStatus = 'not_applicable';

    if (paymentRes.rows.length > 0) {
      const payment = paymentRes.rows[0];
      const hoursUntilCheckin = (new Date(booking.checkin_date) - Date.now()) / (1000 * 60 * 60);
      const calc = calculateCancellationFee(hoursUntilCheckin, Number(payment.amount));
      cancellationFee = calc.fee;
      refundAmount = calc.refundAmount;

      if (refundAmount > 0) {
        if (payment.gateway === 'omise' && payment.gateway_charge_id) {
          try {
            await omise.refundCharge(payment.gateway_charge_id, Math.round(refundAmount * 100));
            refundStatus = 'processing'; // Omise settles refunds asynchronously - this just means the request was accepted
          } catch (err) {
            // A gateway hiccup should not block the cancellation itself -
            // the room still gets released - but the refund needs a human
            // to check on it rather than silently vanishing.
            refundStatus = 'failed_needs_manual_review';
            console.error(`Refund request failed for booking ${bookingId}:`, err.message);
          }
        } else if (payment.gateway === '2c2p' && payment.gateway_ref) {
          try {
            await twoCtwoP.requestRefund({
              merchantId: process.env.TWOCTWOP_MERCHANT_ID,
              secretKey: process.env.TWOCTWOP_SECRET_KEY,
              invoiceNo: payment.gateway_ref,
              amount: refundAmount,
              currencyCode: 'THB',
            });
            refundStatus = 'processing';
          } catch (err) {
            refundStatus = 'failed_needs_manual_review';
            console.error(`2C2P refund request failed for booking ${bookingId}:`, err.message);
          }
        } else {
          // Bank transfers were never automated on the way in (see
          // paymentService's 'manual' gateway) - refunding one is a human
          // wiring money back, not an API call.
          refundStatus = 'manual_required';
        }

        await client.query(`UPDATE payments SET status = 'refunded' WHERE id = $1`, [payment.id]);

        // Claw back any loyalty points earned from this booking - a guest
        // shouldn't keep points for money that came back to them. Simplified
        // rule: any refund (full or partial) reverses the FULL amount earned,
        // not a pro-rated slice - easier to explain than it is valuable to
        // guests trying to game partial refunds for point farming.
        const earnedRes = await client.query(
          `SELECT points_change FROM loyalty_transactions WHERE booking_id = $1 AND type = 'earn'`,
          [bookingId]
        );
        if (earnedRes.rows.length > 0 && booking.guest_id) {
          const pointsToClaw = earnedRes.rows[0].points_change;
          const guestRes = await client.query(
            `SELECT points_balance FROM guests WHERE id = $1 FOR UPDATE`,
            [booking.guest_id]
          );
          const currentBalance = guestRes.rows[0].points_balance;
          const clawed = Math.min(pointsToClaw, currentBalance); // never take the balance negative
          if (clawed > 0) {
            const newBalance = currentBalance - clawed;
            await client.query(`UPDATE guests SET points_balance = $2 WHERE id = $1`, [booking.guest_id, newBalance]);
            await client.query(
              `INSERT INTO loyalty_transactions (guest_id, booking_id, points_change, balance_after, type)
               VALUES ($1, $2, $3, $4, 'adjustment')`,
              [booking.guest_id, bookingId, -clawed, newBalance]
            );
          }
        }
      } else {
        refundStatus = 'none';
      }
    }

    await client.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [bookingId]);

    await client.query(
      `INSERT INTO booking_cancellations
         (booking_id, cancelled_by_type, cancelled_by_id, reason, cancellation_fee, refund_amount, refund_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [bookingId, actor.type, actor.id, reason || null, cancellationFee, refundAmount, refundStatus]
    );

    await client.query('COMMIT');
    return {
      id: bookingId,
      status: 'cancelled',
      cancellation_fee: cancellationFee,
      refund_amount: refundAmount,
      refund_status: refundStatus,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { cancelBooking, calculateCancellationFee };
