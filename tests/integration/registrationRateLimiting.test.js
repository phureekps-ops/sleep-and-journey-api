const request = require('supertest');
const app = require('../../src/app');
const { truncateAll, closeDb } = require('../helpers/db');

describe('registration rate limiting', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeDb();
  });

  test('blocks further registrations from the same IP once the limit is hit', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/v1/auth/register')
        .send({ first_name: 'Test', email: `spam${i}@test.com`, password: 'correct-password-123' });
      expect(res.status).toBe(201);
    }

    const blocked = await request(app)
      .post('/v1/auth/register')
      .send({ first_name: 'Test', email: 'spam-blocked@test.com', password: 'correct-password-123' });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REGISTRATIONS');
  });

  test('failed attempts (e.g. duplicate email) count toward the limit too', async () => {
    const payload = { first_name: 'Test', email: 'dup-spam@test.com', password: 'correct-password-123' };
    await request(app).post('/v1/auth/register').send(payload); // 1: succeeds

    for (let i = 0; i < 4; i++) {
      const res = await request(app).post('/v1/auth/register').send(payload); // 2-5: duplicate email, fails
      expect(res.status).toBe(409);
    }

    // That's 5 attempts total from this IP now - the 6th, even with a
    // brand new email, should be blocked before it's even processed.
    const blocked = await request(app)
      .post('/v1/auth/register')
      .send({ first_name: 'Test', email: 'fresh-email@test.com', password: 'correct-password-123' });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REGISTRATIONS');
  });
});
