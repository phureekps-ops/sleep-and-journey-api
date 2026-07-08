jest.mock('../../src/services/paymentGateway/omiseClient', () => ({
  refundCharge: jest.fn().mockResolvedValue({ id: 'rfnd_test' }),
}));

const request = require('supertest');
const app = require('../../src/app');
const omiseClient = require('../../src/services/paymentGateway/omiseClient');
const { pool, truncateAll, closeDb } = require('../helpers/db');
const { createBranch, createRoomType, createRooms, dateOffset } = require('../helpers/fixtures');
const { hashPassword } = require('../../src/utils/passwords');

async function loginHqAdmin() {
  await pool.query(
    `INSERT INTO staff (name, email, password_hash, role) VALUES ('HQ', 'hqcancel@test.com', $1, 'hq_admin')`,
    [hashPassword('password123')]
  );
  const res = await request(app).post('/v1/admin/auth/login').send({ email: 'hqcancel@test.com', password: 'password123' });
  return res.body.access_token;
}

/**
 * Creates a booking and forces it directly into a "paid, confirmed" state
 * with a known round total_price - bypassing the real payment flow, since
 * this suite is about the cancellation/refund policy, not payment
 * initiation (that's covered by manual testing against real Omise test
 * keys, per the payment section of the README).
 */
async function setupPaidBooking(checkinOffsetDays, amount = 2000) {
  const branchId = await createBranch();
  const roomTypeId = await createRoomType(branchId, { basePrice: amount / 2 });
  await createRooms(roomTypeId, 2);

  const bookingRes = await request(app)
    .post('/v1/bookings')
    .send({
      branch_id: branchId,
      room_type_id: roomTypeId,
      checkin: dateOffset(checkinOffsetDays),
      checkout: dateOffset(checkinOffsetDays + 1),
      guest: { first_name: 'Test', email: `${Math.random().toString(36).slice(2)}@test.com` },
    });
  const bookingId = bookingRes.body.id;

  await pool.query(`UPDATE bookings SET total_price = $2, status = 'confirmed' WHERE id = $1`, [bookingId, amount]);
  await pool.query(
    `INSERT INTO payments (booking_id, amount, method, status, gateway, gateway_charge_id, paid_at)
     VALUES ($1, $2, 'card', 'paid', 'omise', 'chrg_test123', now())`,
    [bookingId, amount]
  );
  return bookingId;
}

describe('PATCH /bookings/:id/cancel', () => {
  beforeEach(async () => {
    await truncateAll();
    omiseClient.refundCharge.mockClear();
  });

  afterAll(async () => {
    await closeDb();
  });

  test('full refund, no fee, when cancelling 10+ days before check-in', async () => {
    const bookingId = await setupPaidBooking(10, 2000);
    const token = await loginHqAdmin();

    const res = await request(app)
      .patch(`/v1/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'test' });

    expect(res.status).toBe(200);
    expect(res.body.cancellation_fee).toBe(0);
    expect(res.body.refund_amount).toBe(2000);
    expect(res.body.refund_status).toBe('processing');
    expect(omiseClient.refundCharge).toHaveBeenCalledWith('chrg_test123', 200000); // baht -> satang
  });

  test('50% fee when cancelling ~2 days before check-in', async () => {
    const bookingId = await setupPaidBooking(2, 2000);
    const token = await loginHqAdmin();

    const res = await request(app)
      .patch(`/v1/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.cancellation_fee).toBe(1000);
    expect(res.body.refund_amount).toBe(1000);
  });

  test('no refund when cancelling on the day of check-in', async () => {
    const bookingId = await setupPaidBooking(0, 2000);
    const token = await loginHqAdmin();

    const res = await request(app)
      .patch(`/v1/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.cancellation_fee).toBe(2000);
    expect(res.body.refund_amount).toBe(0);
    expect(res.body.refund_status).toBe('none');
    expect(omiseClient.refundCharge).not.toHaveBeenCalled();
  });

  test('cannot cancel a booking twice', async () => {
    const bookingId = await setupPaidBooking(10, 2000);
    const token = await loginHqAdmin();

    await request(app).patch(`/v1/bookings/${bookingId}/cancel`).set('Authorization', `Bearer ${token}`).send({});
    const second = await request(app)
      .patch(`/v1/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CANNOT_CANCEL');
  });

  test('claws back loyalty points earned from a refunded booking', async () => {
    const bookingId = await setupPaidBooking(10, 2000);

    const bookingRow = await pool.query('SELECT guest_id FROM bookings WHERE id = $1', [bookingId]);
    const guestId = bookingRow.rows[0].guest_id;

    // Simulate that earnPointsForBooking already ran during a real payment
    // confirmation (40 points earned, balance was already at 500).
    await pool.query(`UPDATE guests SET points_balance = 500 WHERE id = $1`, [guestId]);
    await pool.query(
      `INSERT INTO loyalty_transactions (guest_id, booking_id, points_change, balance_after, type)
       VALUES ($1, $2, 40, 500, 'earn')`,
      [guestId, bookingId]
    );

    const token = await loginHqAdmin();
    await request(app).patch(`/v1/bookings/${bookingId}/cancel`).set('Authorization', `Bearer ${token}`).send({});

    const guestAfter = await pool.query('SELECT points_balance FROM guests WHERE id = $1', [guestId]);
    expect(guestAfter.rows[0].points_balance).toBe(460); // 500 - 40 clawed back

    const adjustment = await pool.query(
      `SELECT points_change FROM loyalty_transactions WHERE booking_id = $1 AND type = 'adjustment'`,
      [bookingId]
    );
    expect(adjustment.rows[0].points_change).toBe(-40);
  });

  test('cancelling a pending (never-paid) booking needs no refund at all', async () => {
    const branchId = await createBranch();
    const roomTypeId = await createRoomType(branchId, { basePrice: 1000 });
    await createRooms(roomTypeId, 1);

    const bookingRes = await request(app)
      .post('/v1/bookings')
      .send({
        branch_id: branchId,
        room_type_id: roomTypeId,
        checkin: dateOffset(10),
        checkout: dateOffset(11),
        guest: { first_name: 'Test', email: 'neverpaid@test.com' },
      });

    const token = await loginHqAdmin();
    const res = await request(app)
      .patch(`/v1/bookings/${bookingRes.body.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.refund_status).toBe('not_applicable');
    expect(omiseClient.refundCharge).not.toHaveBeenCalled();
  });
});
