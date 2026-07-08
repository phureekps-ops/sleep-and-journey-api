const request = require('supertest');
const app = require('../../src/app');
const { pool, truncateAll, closeDb } = require('../helpers/db');
const { createBranch, createRoomType, createRooms } = require('../helpers/fixtures');

describe('POST /bookings + GET /availability', () => {
  let branchId;
  let roomTypeId;

  beforeEach(async () => {
    await truncateAll();
    branchId = await createBranch();
    roomTypeId = await createRoomType(branchId, { basePrice: 1000 });
    await createRooms(roomTypeId, 2); // deliberately scarce - only 2 physical rooms
  });

  afterAll(async () => {
    await closeDb();
  });

  function bookingPayload(email) {
    return {
      branch_id: branchId,
      room_type_id: roomTypeId,
      checkin: '2027-01-10',
      checkout: '2027-01-12',
      guests_count: 2,
      guest: { first_name: 'Test', last_name: 'Guest', email, phone: '0800000000' },
    };
  }

  test('creates a pending booking with a correct price breakdown', async () => {
    const res = await request(app).post('/v1/bookings').send(bookingPayload('a@test.com'));

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.booking_code).toMatch(/^SJ-/);
    // 1000/night x 2 nights = 2000 room total, +10% service = 2200, +7% VAT = 2354
    expect(res.body.price_breakdown.room_total).toBe(2000);
    expect(res.body.price_breakdown.service_charge).toBe(200);
    expect(res.body.price_breakdown.total).toBe(2354);
  });

  test('rejects a booking where checkout is not after checkin', async () => {
    const payload = bookingPayload('b@test.com');
    payload.checkin = '2027-01-12';
    payload.checkout = '2027-01-10';

    const res = await request(app).post('/v1/bookings').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
  });

  test('an Idempotency-Key replay returns the same booking instead of creating a second one', async () => {
    const key = 'test-idempotency-key-1';
    const payload = bookingPayload('c@test.com');

    const first = await request(app).post('/v1/bookings').set('Idempotency-Key', key).send(payload);
    const second = await request(app).post('/v1/bookings').set('Idempotency-Key', key).send(payload);

    expect(first.body.id).toBe(second.body.id);
    const count = await pool.query('SELECT COUNT(*)::int AS c FROM bookings');
    expect(count.rows[0].c).toBe(1);
  });

  test('GET /availability reflects rooms_remaining going down as bookings are made', async () => {
    const before = await request(app).get(
      `/v1/availability?branch_id=${branchId}&checkin=2027-01-10&checkout=2027-01-12`
    );
    expect(before.body.data[0].room_types[0].rooms_remaining).toBe(2);

    await request(app).post('/v1/bookings').send(bookingPayload('d@test.com'));

    const after = await request(app).get(
      `/v1/availability?branch_id=${branchId}&checkin=2027-01-10&checkout=2027-01-12`
    );
    expect(after.body.data[0].room_types[0].rooms_remaining).toBe(1);
  });

  test('rejects a third booking once both physical rooms are already held', async () => {
    const first = await request(app).post('/v1/bookings').send(bookingPayload('e1@test.com'));
    const second = await request(app).post('/v1/bookings').send(bookingPayload('e2@test.com'));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const third = await request(app).post('/v1/bookings').send(bookingPayload('e3@test.com'));
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('ROOM_NOT_AVAILABLE');
  });

  test('never oversells the room type under concurrent requests (the overbooking-prevention test)', async () => {
    // Fire 5 simultaneous requests at a room type with only 2 physical
    // rooms. This is the test that actually exercises the
    // pg_advisory_xact_lock in bookingService.createBooking - without it,
    // more than 2 of these could race past the "is a room left?" check at
    // the same instant and all succeed.
    const attempts = Array.from({ length: 5 }, (_, i) =>
      request(app).post('/v1/bookings').send(bookingPayload(`race${i}@test.com`))
    );
    const results = await Promise.all(attempts);

    const succeeded = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);

    expect(succeeded).toHaveLength(2);
    expect(rejected).toHaveLength(3);

    const pendingCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM bookings WHERE room_type_id = $1 AND status = 'pending'`,
      [roomTypeId]
    );
    expect(pendingCount.rows[0].c).toBe(2);
  });
});
