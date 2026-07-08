const request = require('supertest');
const app = require('../../src/app');
const { pool, truncateAll, closeDb } = require('../helpers/db');
const { hashPassword } = require('../../src/utils/passwords');

describe('auth', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeDb();
  });

  test('register creates a guest with the 300-point welcome bonus', async () => {
    const res = await request(app)
      .post('/v1/auth/register')
      .send({ first_name: 'Somchai', email: 'somchai@test.com', password: 'longenoughpassword' });

    expect(res.status).toBe(201);
    expect(res.body.guest.points_balance).toBe(300);
    expect(res.body.guest.member_tier).toBe('silver');
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();

    const ledger = await pool.query(
      `SELECT points_change, type FROM loyalty_transactions WHERE guest_id = $1`,
      [res.body.guest.id]
    );
    expect(ledger.rows).toEqual([{ points_change: 300, type: 'bonus' }]);
  });

  test('rejects registering the same email twice', async () => {
    const payload = { first_name: 'Somchai', email: 'dup@test.com', password: 'longenoughpassword' };
    await request(app).post('/v1/auth/register').send(payload);
    const res = await request(app).post('/v1/auth/register').send(payload);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  test('rejects a password shorter than 8 characters', async () => {
    const res = await request(app)
      .post('/v1/auth/register')
      .send({ first_name: 'Somchai', email: 'short@test.com', password: '123' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
  });

  test('login fails the same way for a wrong password and an unknown email', async () => {
    await request(app)
      .post('/v1/auth/register')
      .send({ first_name: 'Somchai', email: 'login@test.com', password: 'correct-password-123' });

    const wrongPassword = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'login@test.com', password: 'wrong-password' });
    const unknownEmail = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'nobody@test.com', password: 'whatever' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe(unknownEmail.body.error.code);
  });

  test('refresh rotates the token - the old refresh_token can never be reused', async () => {
    const reg = await request(app)
      .post('/v1/auth/register')
      .send({ first_name: 'Somchai', email: 'rotate@test.com', password: 'correct-password-123' });
    const oldRefreshToken = reg.body.refresh_token;

    const firstRefresh = await request(app).post('/v1/auth/refresh').send({ refresh_token: oldRefreshToken });
    expect(firstRefresh.status).toBe(200);
    expect(firstRefresh.body.refresh_token).not.toBe(oldRefreshToken);

    const replay = await request(app).post('/v1/auth/refresh').send({ refresh_token: oldRefreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  test('logout revokes the refresh token immediately', async () => {
    const reg = await request(app)
      .post('/v1/auth/register')
      .send({ first_name: 'Somchai', email: 'logout@test.com', password: 'correct-password-123' });

    await request(app).post('/v1/auth/logout').send({ refresh_token: reg.body.refresh_token });

    const afterLogout = await request(app)
      .post('/v1/auth/refresh')
      .send({ refresh_token: reg.body.refresh_token });
    expect(afterLogout.status).toBe(401);
  });

  test('a disabled staff account cannot log in even with the correct password', async () => {
    await pool.query(
      `INSERT INTO staff (name, email, password_hash, role, is_active)
       VALUES ('Disabled Admin', 'disabled@test.com', $1, 'hq_admin', false)`,
      [hashPassword('correct-password-123')]
    );

    const res = await request(app)
      .post('/v1/admin/auth/login')
      .send({ email: 'disabled@test.com', password: 'correct-password-123' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  test('GET /guests/me requires a valid access token and never leaks the password hash', async () => {
    const noToken = await request(app).get('/v1/guests/me');
    expect(noToken.status).toBe(401);

    const reg = await request(app)
      .post('/v1/auth/register')
      .send({ first_name: 'Somchai', email: 'me@test.com', password: 'correct-password-123' });

    const withToken = await request(app)
      .get('/v1/guests/me')
      .set('Authorization', `Bearer ${reg.body.access_token}`);
    expect(withToken.status).toBe(200);
    expect(withToken.body.email).toBe('me@test.com');
    expect(withToken.body.password_hash).toBeUndefined();
  });
});
