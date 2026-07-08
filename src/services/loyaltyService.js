const pool = require('../db');
const AppError = require('../utils/AppError');

const EARN_RATE = 0.02; // 2% of the paid total, matching the Gold-tier rate from the loyalty design
const REDEMPTION_RATE = 1; // 1 point = ฿1 discount - simple and easy for a guest to reason about
const MIN_REDEEM_POINTS = 100;
const MAX_REDEEM_PERCENT = 0.5; // can never discount away more than half the booking

/**
 * Credits loyalty points for a booking that just got paid. Must be called
 * with the SAME transaction client the caller used to mark the booking
 * confirmed, so points and confirmation always succeed or fail together.
 */
async function earnPointsForBooking(client, { bookingId }) {
  const bookingRes = await client.query(`SELECT guest_id, total_price FROM bookings WHERE id = $1`, [bookingId]);
  if (bookingRes.rows.length === 0) return;

  const { guest_id: guestId, total_price: totalPrice } = bookingRes.rows[0];
  const pointsChange = Math.round(Number(totalPrice) * EARN_RATE);
  if (pointsChange <= 0) return;

  const guestRes = await client.query(
    `UPDATE guests SET points_balance = points_balance + $2 WHERE id = $1 RETURNING points_balance`,
    [guestId, pointsChange]
  );
  const balanceAfter = guestRes.rows[0].points_balance;

  await client.query(
    `INSERT INTO loyalty_transactions (guest_id, booking_id, points_change, balance_after, type)
     VALUES ($1, $2, $3, $4, 'earn')`,
    [guestId, bookingId, pointsChange, balanceAfter]
  );
}

/**
 * POST /loyalty/redeem - spends points as a discount against a booking that
 * hasn't been paid yet. Deliberately simple rules, each enforced here (not
 * just validated client-side):
 *   - one redemption per booking, ever (checked in-app, then guaranteed at
 *     the DB level by the partial unique index from migration 005)
 *   - only while the booking is still 'pending' (payment reads total_price
 *     fresh, so a discount applied here is simply what gets charged - no
 *     separate "redeemed amount" bookkeeping needed downstream)
 *   - can't discount away more than half the booking total
 *   - can't redeem more points than the guest actually has
 */
async function redeemPoints({ guestId, bookingId, points }) {
  if (!Number.isInteger(points) || points <= 0) {
    throw new AppError(422, 'INVALID_POINTS', 'points ต้องเป็นจำนวนเต็มบวก');
  }
  if (points < MIN_REDEEM_POINTS) {
    throw new AppError(422, 'BELOW_MINIMUM_REDEMPTION', `ต้องใช้แต้มอย่างน้อย ${MIN_REDEEM_POINTS} แต้มต่อครั้ง`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bookingRes = await client.query(
      `SELECT id, guest_id, status, total_price FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );
    if (bookingRes.rows.length === 0) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'ไม่พบการจองนี้');
    }
    const booking = bookingRes.rows[0];

    if (booking.guest_id !== guestId) {
      throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ใช้แต้มกับการจองนี้');
    }
    if (booking.status !== 'pending') {
      throw new AppError(
        409,
        'BOOKING_NOT_REDEEMABLE',
        `การจองนี้อยู่ในสถานะ '${booking.status}' ใช้แต้มแลกส่วนลดไม่ได้แล้ว`
      );
    }

    const alreadyRedeemed = await client.query(
      `SELECT id FROM loyalty_transactions WHERE booking_id = $1 AND type = 'redeem'`,
      [bookingId]
    );
    if (alreadyRedeemed.rows.length > 0) {
      throw new AppError(409, 'ALREADY_REDEEMED', 'การจองนี้ถูกใช้แต้มแลกส่วนลดไปแล้ว ใช้ได้ครั้งเดียวต่อการจอง');
    }

    const guestRes = await client.query(`SELECT points_balance FROM guests WHERE id = $1 FOR UPDATE`, [guestId]);
    if (guestRes.rows.length === 0) {
      throw new AppError(404, 'GUEST_NOT_FOUND', 'ไม่พบบัญชีสมาชิกนี้');
    }
    const currentBalance = guestRes.rows[0].points_balance;
    if (points > currentBalance) {
      throw new AppError(422, 'INSUFFICIENT_POINTS', 'แต้มสะสมไม่พอ', { available_points: currentBalance });
    }

    const maxDiscount = Math.floor(Number(booking.total_price) * MAX_REDEEM_PERCENT);
    const requestedDiscount = points * REDEMPTION_RATE;
    if (requestedDiscount > maxDiscount) {
      const maxPointsAllowed = Math.floor(maxDiscount / REDEMPTION_RATE);
      throw new AppError(
        422,
        'REDEMPTION_LIMIT_EXCEEDED',
        `ใช้แต้มแลกส่วนลดได้สูงสุด ${MAX_REDEEM_PERCENT * 100}% ของยอดจอง`,
        { max_points_allowed: maxPointsAllowed }
      );
    }

    const newBalance = currentBalance - points;
    await client.query(`UPDATE guests SET points_balance = $2 WHERE id = $1`, [guestId, newBalance]);

    try {
      await client.query(
        `INSERT INTO loyalty_transactions (guest_id, booking_id, points_change, balance_after, type)
         VALUES ($1, $2, $3, $4, 'redeem')`,
        [guestId, bookingId, -points, newBalance]
      );
    } catch (err) {
      // Two redeem requests for the same booking raced past the check above -
      // the partial unique index (migration 005) catches what the app-level
      // check couldn't. Surface it as the same clean error either way.
      if (err.code === '23505') {
        throw new AppError(409, 'ALREADY_REDEEMED', 'การจองนี้ถูกใช้แต้มแลกส่วนลดไปแล้ว ใช้ได้ครั้งเดียวต่อการจอง');
      }
      throw err;
    }

    const newTotalPrice = Number(booking.total_price) - requestedDiscount;
    await client.query(`UPDATE bookings SET total_price = $2 WHERE id = $1`, [bookingId, newTotalPrice]);

    await client.query('COMMIT');
    return {
      booking_id: bookingId,
      points_redeemed: points,
      discount_amount: requestedDiscount,
      new_total_price: newTotalPrice,
      points_balance: newBalance,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { earnPointsForBooking, redeemPoints };
