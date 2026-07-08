const request = require('supertest');
const app = require('../../src/app');
const { pool, truncateAll, closeDb } = require('../helpers/db');
const { createBranch, createRoomType, createRooms } = require('../helpers/fixtures');

async function registerGuest(email) {
  const res = await request(app)
    .post('/v1/auth/register')
    .send({ first_name: 'Test', email, password: 'longenoughpassword' });
  return res.body;
}

describe('POST /loyalty/redeem', () => {
  let branchId;
  let roomTypeId;
  let bookingId;
  let accessToken;

  beforeEach(async () => {
    await truncateAll();
    branchId = await createBranch();
    roomTypeId = await createRoomType(branchId, { basePrice: 2000 });
    await createRooms(roomTypeId, 2);

    const auth = await registerGuest('redeemer@test.com');
    accessToken = auth.access_token;

    // Give this guest plenty of points directly, bypassing the earn flow -
    // this test suite is about redemption rules, not how points are earned.
    await pool.query(`UPDATE guests SET points_balance = 5000 WHERE id = $1`, [auth.guest.id]);

    const bookingRes = await request(app)
      .post('/v1/bookings')
      .send({
        branch_id: branchId,
        room_type_id: roomTypeId,
        checkin: '2027-03-01',
        checkout: '2027-03-03', // 2 nights x 2000 = 4000 room total -> total_price 4708 after service+VAT
        guest: { first_name: 'Test', email: 'redeemer@test.com' },
      });
    bookingId = bookingRes.body.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  test('applies a discount, reducing both the points balance and the booking total by the same amount', async () => {
    const before = await pool.query('SELECT total_price FROM bookings WHERE id = $1', [bookingId]);

    const res = await request(app)
      .post('/v1/loyalty/redeem')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ booking_id: bookingId, points: 300 });

    expect(res.status).toBe(200);
    expect(res.body.discount_amount).toBe(300);
    expect(res.body.points_balance).toBe(5000 - 300);
    expect(Number(before.rows[0].total_price) - res.body.discount_amount).toBe(res.body.new_total_price);
  });

  test('cannot redeem twice against the same booking', async () => {
    await request(app)
      .post('/v1/loyalty/redeem')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ booking_id: bookingId, points: 200 });

    const second = await request(app)
      .post('/v1/loyalty/redeem')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ booking_id: bookingId, points: 200 });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_REDEEMED');
  });

  test('rejects redeeming more points than the guest actually has', async () => {
    const res = await request(app)
      .post('/v1/loyalty/redeem')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ booking_id: bookingId, points: 999999 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_POINTS');
    expect(res.body.error.details.available_points).toBe(5000);
  });

  test('rejects a discount larger than 50% of the booking total', async () => {
    const res = await request(app)
      .post('/v1/loyalty/redeem')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ booking_id: bookingId, points: 4000 }); // well above half of ~4708

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('REDEMPTION_LIMIT_EXCEEDED');
    expect(res.body.error.details.max_points_allowed).toBeDefined();
  });

  test('rejects a redemption below the minimum of 100 points', async () => {
    const res = await request(app)
      .post('/v1/loyalty/redeem')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ booking_id: bookingId, points: 50 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BELOW_MINIMUM_REDEMPTION');
  });

  test("rejects redeeming points against someone else's booking", async () => {
    const otherAuth = await registerGuest('other-guest@test.com');

    const res = await request(app)
      .post('/v1/loyalty/redeem')
      .set('Authorization', `Bearer ${otherAuth.access_token}`)
      .send({ booking_id: bookingId, points: 200 });

    expect(res.status).toBe(403);
  });

  test('requires authentication', async () => {
    const res = await request(app).post('/v1/loyalty/redeem').send({ booking_id: bookingId, points: 200 });
    expect(res.status).toBe(401);
  });
});
