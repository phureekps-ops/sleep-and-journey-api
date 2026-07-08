const request = require('supertest');
const app = require('../../src/app');
const { pool, truncateAll, closeDb } = require('../helpers/db');
const { createBranch, createRoomType, createRooms } = require('../helpers/fixtures');
const { hashPassword } = require('../../src/utils/passwords');

async function insertStaff({ role, branchId, email }) {
  await pool.query(`INSERT INTO staff (name, email, password_hash, role, branch_id) VALUES ($1, $2, $3, $4, $5)`, [
    'Test Staff',
    email,
    hashPassword('password123'),
    role,
    branchId || null,
  ]);
}

async function loginStaff(email) {
  const res = await request(app).post('/v1/admin/auth/login').send({ email, password: 'password123' });
  return res.body.access_token;
}

describe('admin bookings - branch scoping', () => {
  let branchA;
  let branchB;
  let roomTypeA;
  let roomTypeB;

  beforeEach(async () => {
    await truncateAll();
    branchA = await createBranch({ name: 'Branch A' });
    branchB = await createBranch({ name: 'Branch B' });
    roomTypeA = await createRoomType(branchA, { basePrice: 1000 });
    roomTypeB = await createRoomType(branchB, { basePrice: 1000 });
    await createRooms(roomTypeA, 3);
    await createRooms(roomTypeB, 3);

    await request(app)
      .post('/v1/bookings')
      .send({
        branch_id: branchA,
        room_type_id: roomTypeA,
        checkin: '2027-02-01',
        checkout: '2027-02-02',
        guest: { first_name: 'Guest', email: 'guestA@test.com' },
      });
    await request(app)
      .post('/v1/bookings')
      .send({
        branch_id: branchB,
        room_type_id: roomTypeB,
        checkin: '2027-02-01',
        checkout: '2027-02-02',
        guest: { first_name: 'Guest', email: 'guestB@test.com' },
      });
  });

  afterAll(async () => {
    await closeDb();
  });

  test('a branch_manager only ever sees their own branch, even asking for another explicitly', async () => {
    await insertStaff({ role: 'branch_manager', branchId: branchA, email: 'mgrA@test.com' });
    const token = await loginStaff('mgrA@test.com');

    const res = await request(app)
      .get(`/v1/admin/bookings?branch_id=${branchB}`) // trying to peek at branch B via the query param
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((b) => b.branch_id === branchA)).toBe(true);
  });

  test('hq_admin sees every branch by default, and can filter to one', async () => {
    await insertStaff({ role: 'hq_admin', branchId: null, email: 'hq@test.com' });
    const token = await loginStaff('hq@test.com');

    const all = await request(app).get('/v1/admin/bookings').set('Authorization', `Bearer ${token}`);
    expect(all.body.meta.total).toBe(2);

    const filtered = await request(app)
      .get(`/v1/admin/bookings?branch_id=${branchB}`)
      .set('Authorization', `Bearer ${token}`);
    expect(filtered.body.data.every((b) => b.branch_id === branchB)).toBe(true);
  });

  test('branch_staff cannot access staff management endpoints', async () => {
    await insertStaff({ role: 'branch_staff', branchId: branchA, email: 'staffA@test.com' });
    const token = await loginStaff('staffA@test.com');

    const res = await request(app).get('/v1/admin/staff').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('an hq_admin cannot disable their own account', async () => {
    await insertStaff({ role: 'hq_admin', branchId: null, email: 'self@test.com' });
    const token = await loginStaff('self@test.com');
    const meRes = await pool.query('SELECT id FROM staff WHERE email = $1', ['self@test.com']);
    const selfId = meRes.rows[0].id;

    const res = await request(app)
      .patch(`/v1/admin/staff/${selfId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_active: false });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_DISABLE_SELF');
  });
});
