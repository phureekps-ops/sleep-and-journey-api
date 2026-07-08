jest.mock('../../src/services/paymentGateway/twoCtwoPClient', () => ({
  createPaymentToken: jest.fn().mockResolvedValue({
    webPaymentUrl: 'https://sandbox-pgw.2c2p.com/pay/abc123',
    paymentToken: 'tok_abc',
  }),
  decodeBackendNotification: jest.fn(),
  requestRefund: jest.fn().mockResolvedValue({ respCode: '0000' }),
  verifySignature: jest.fn(),
}));

const request = require('supertest');
const app = require('../../src/app');
const twoCtwoP = require('../../src/services/paymentGateway/twoCtwoPClient');
const { hashPassword } = require('../../src/utils/passwords');
const { pool, truncateAll, closeDb } = require('../helpers/db');
const { createBranch, createRoomType, createRooms, dateOffset } = require('../helpers/fixtures');

async function createPendingBooking() {
  const branchId = await createBranch();
  const roomTypeId = await createRoomType(branchId, { basePrice: 2000 });
  await createRooms(roomTypeId, 2);

  const res = await request(app)
    .post('/v1/bookings')
    .send({
      branch_id: branchId,
      room_type_id: roomTypeId,
      checkin: dateOffset(10), // comfortably in the "full refund" tier for the cancellation test
      checkout: dateOffset(12),
      guest: { first_name: 'Test', email: `${Math.random().toString(36).slice(2)}@test.com` },
    });
  return res.body.id;
}

describe('2C2P payment initiation and refund', () => {
  const originalBackendUrl = process.env.TWOCTWOP_BACKEND_RETURN_URL;

  beforeEach(async () => {
    await truncateAll();
    process.env.TWOCTWOP_BACKEND_RETURN_URL = originalBackendUrl || 'https://example.com/v1/webhooks/payment/2c2p';
    process.env.TWOCTWOP_MERCHANT_ID = process.env.TWOCTWOP_MERCHANT_ID || 'TESTMERCHANT';
    process.env.TWOCTWOP_SECRET_KEY = process.env.TWOCTWOP_SECRET_KEY || 'test-2c2p-secret';
    twoCtwoP.createPaymentToken.mockClear();
    twoCtwoP.requestRefund.mockClear();
  });

  afterAll(async () => {
    process.env.TWOCTWOP_BACKEND_RETURN_URL = originalBackendUrl;
    await closeDb();
  });

  test('initiating a 2C2P payment returns a redirect_url and stores the invoiceNo as gateway_ref', async () => {
    const bookingId = await createPendingBooking();

    const res = await request(app).post(`/v1/bookings/${bookingId}/payment`).send({ gateway: '2c2p' });

    expect(res.status).toBe(200);
    expect(res.body.gateway).toBe('2c2p');
    expect(res.body.redirect_url).toBe('https://sandbox-pgw.2c2p.com/pay/abc123');
    expect(twoCtwoP.createPaymentToken).toHaveBeenCalledTimes(1);

    const payment = await pool.query(
      'SELECT gateway, method, status, gateway_ref FROM payments WHERE booking_id = $1',
      [bookingId]
    );
    expect(payment.rows[0]).toMatchObject({ gateway: '2c2p', method: 'redirect', status: 'pending' });
    expect(payment.rows[0].gateway_ref).toBeTruthy();
  });

  test('rejects initiation when TWOCTWOP_BACKEND_RETURN_URL is not configured', async () => {
    const bookingId = await createPendingBooking();
    delete process.env.TWOCTWOP_BACKEND_RETURN_URL;

    const res = await request(app).post(`/v1/bookings/${bookingId}/payment`).send({ gateway: '2c2p' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('GATEWAY_NOT_CONFIGURED');
  });

  test('cancelling a booking paid via 2C2P calls requestRefund with the stored invoiceNo', async () => {
    const bookingId = await createPendingBooking();
    await request(app).post(`/v1/bookings/${bookingId}/payment`).send({ gateway: '2c2p' });

    const paymentRow = await pool.query('SELECT gateway_ref FROM payments WHERE booking_id = $1', [bookingId]);
    const invoiceNo = paymentRow.rows[0].gateway_ref;

    // Simulate that a genuine backend notification already confirmed this payment.
    await pool.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [bookingId]);
    await pool.query(`UPDATE payments SET status = 'paid', paid_at = now() WHERE booking_id = $1`, [bookingId]);

    await pool.query(`INSERT INTO staff (name, email, password_hash, role) VALUES ('HQ', 'hq2c2ptest@test.com', $1, 'hq_admin')`, [
      hashPassword('password123'),
    ]);
    const login = await request(app)
      .post('/v1/admin/auth/login')
      .send({ email: 'hq2c2ptest@test.com', password: 'password123' });

    const cancelRes = await request(app)
      .patch(`/v1/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .send({});

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.refund_status).toBe('processing');
    expect(twoCtwoP.requestRefund).toHaveBeenCalledWith(expect.objectContaining({ invoiceNo }));
  });
});
