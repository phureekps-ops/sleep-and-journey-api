const pool = require('../db');
const AppError = require('../utils/AppError');
const { generateBookingCode } = require('../utils/bookingCode');
const { OVERLAP_COUNT_SQL } = require('./availabilityService');

const HOLD_MINUTES = 15;
const SERVICE_CHARGE_RATE = 0.10;
const VAT_RATE = 0.07;

/**
 * Creates a booking with status = 'pending' and a temporary inventory hold.
 *
 * Race-condition safety: two requests for the last remaining room of the
 * same room_type could otherwise both pass the "is there a room left?"
 * check before either one inserts its row. We prevent that with
 * pg_advisory_xact_lock(hashtext(room_type_id)) - it serializes every
 * booking attempt for that specific room type onto one at a time for the
 * duration of the transaction, and releases automatically on COMMIT/ROLLBACK.
 * This is cheaper than locking every row in `rooms`, and correct because
 * all booking attempts for a room type funnel through this same lock key.
 */
async function createBooking(input) {
  const { branchId, roomTypeId, checkin, checkout, guestsCount, guest, specialRequest, idempotencyKey } = input;

  if (!branchId || !roomTypeId || !checkin || !checkout || !guest || !guest.email) {
    throw new AppError(422, 'VALIDATION_ERROR', 'ข้อมูลการจองไม่ครบถ้วน');
  }
  if (new Date(checkout) <= new Date(checkin)) {
    throw new AppError(400, 'INVALID_DATE_RANGE', 'checkout ต้องอยู่หลัง checkin');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Idempotency check - if this key was already processed, return the
    //    exact same response instead of creating a second booking.
    if (idempotencyKey) {
      const existing = await client.query(
        'SELECT status_code, response_body FROM idempotency_keys WHERE key = $1',
        [idempotencyKey]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return { statusCode: existing.rows[0].status_code, body: existing.rows[0].response_body, cached: true };
      }
    }

    // 2. Serialize all concurrent booking attempts for this room type.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [roomTypeId]);

    // 3. Load the room type (also confirms it belongs to the given branch).
    const roomTypeRes = await client.query(
      `SELECT id, base_price FROM room_types WHERE id = $1 AND branch_id = $2`,
      [roomTypeId, branchId]
    );
    if (roomTypeRes.rows.length === 0) {
      throw new AppError(404, 'ROOM_TYPE_NOT_FOUND', 'ไม่พบประเภทห้องนี้ในสาขาที่ระบุ');
    }
    const roomType = roomTypeRes.rows[0];

    // 4. Check remaining inventory for the requested date range.
    //    Runs inside the advisory lock, so no other request for this
    //    room_type can insert a competing booking between this check
    //    and our own INSERT below.
    const totalRoomsRes = await client.query(
      `SELECT COUNT(*)::int AS total FROM rooms WHERE room_type_id = $1 AND status = 'available'`,
      [roomTypeId]
    );
    const totalRooms = totalRoomsRes.rows[0].total;

    const overlapRes = await client.query(OVERLAP_COUNT_SQL, [roomTypeId, checkin, checkout]);
    const remaining = totalRooms - overlapRes.rows[0].count;

    if (remaining <= 0) {
      throw new AppError(409, 'ROOM_NOT_AVAILABLE', 'ไม่มีห้องว่างสำหรับช่วงวันที่เลือก');
    }

    // 5. Upsert the guest by email (simplified - a real system would also
    //    support an authenticated guest_id passed straight through).
    const guestRes = await client.query(
      `INSERT INTO guests (first_name, last_name, email, phone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET first_name = EXCLUDED.first_name, phone = EXCLUDED.phone
       RETURNING id`,
      [guest.first_name, guest.last_name || null, guest.email, guest.phone || null]
    );
    const guestId = guestRes.rows[0].id;

    // 6. Price breakdown.
    const nights = Math.round((new Date(checkout) - new Date(checkin)) / 86400000);
    const roomTotal = Math.round(Number(roomType.base_price) * nights);
    const serviceCharge = Math.round(roomTotal * SERVICE_CHARGE_RATE);
    const vat = Math.round((roomTotal + serviceCharge) * VAT_RATE);
    const total = roomTotal + serviceCharge + vat;
    const holdExpiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);

    // 7. Insert the booking. Retry once on the (very unlikely) chance of a
    //    booking_code collision, since it is generated client-side.
    let booking;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const bookingCode = generateBookingCode();
        const insertRes = await client.query(
          `INSERT INTO bookings
             (booking_code, branch_id, room_type_id, guest_id, checkin_date, checkout_date,
              guests_count, status, total_price, special_request, hold_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)
           RETURNING id, booking_code, status, checkin_date, checkout_date, hold_expires_at`,
          [bookingCode, branchId, roomTypeId, guestId, checkin, checkout,
            guestsCount || 2, total, specialRequest || null, holdExpiresAt]
        );
        booking = insertRes.rows[0];
        break;
      } catch (err) {
        if (err.code === '23505' && err.constraint === 'bookings_booking_code_key' && attempt < 2) {
          continue; // collision on booking_code - regenerate and retry
        }
        throw err;
      }
    }

    const responseBody = {
      id: booking.id,
      booking_code: booking.booking_code,
      status: booking.status,
      branch_id: branchId,
      room_type_id: roomTypeId,
      checkin: booking.checkin_date,
      checkout: booking.checkout_date,
      price_breakdown: {
        room_total: roomTotal,
        service_charge: serviceCharge,
        vat,
        total,
      },
      hold_expires_at: booking.hold_expires_at,
    };

    // 8. Record the idempotency key + response in the same transaction so
    //    a retry with the same key is guaranteed to see it (or neither).
    if (idempotencyKey) {
      await client.query(
        `INSERT INTO idempotency_keys (key, status_code, response_body) VALUES ($1, $2, $3)`,
        [idempotencyKey, 201, responseBody]
      );
    }

    await client.query('COMMIT');
    return { statusCode: 201, body: responseBody, cached: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getBookingById(id) {
  const res = await pool.query(
    `SELECT b.*, g.first_name, g.last_name, g.email, g.phone
     FROM bookings b
     JOIN guests g ON g.id = b.guest_id
     WHERE b.id = $1`,
    [id]
  );
  if (res.rows.length === 0) {
    throw new AppError(404, 'BOOKING_NOT_FOUND', 'ไม่พบการจองนี้');
  }
  return res.rows[0];
}

module.exports = { createBooking, getBookingById };
