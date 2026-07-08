const request = require('supertest');
const app = require('../../src/app');
const { truncateAll, closeDb } = require('../helpers/db');

describe('login rate limiting', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeDb();
  });

  test('blocks guest login after 5 failed attempts for the same email - even with the correct password', async () => {
    await request(app)
      .post('/v1/auth/register')
      .send({ first_name: 'Test', email: 'ratelimited@test.com', password: 'correct-password-123' });

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/v1/auth/login')
        .send({ email: 'ratelimited@test.com', password: 'wrong-password' });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'ratelimited@test.com', password: 'correct-password-123' });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  test('failed attempts against one email do not block a different email', async () => {
    await request(app)
      .post('/v1/auth/register')
      .send({ first_name: 'Victim', email: 'victim@test.com', password: 'correct-password-123' });
    await request(app)
      .post('/v1/auth/register')
      .send({ first_name: 'Other', email: 'other@test.com', password: 'correct-password-123' });

    for (let i = 0; i < 5; i++) {
      await request(app).post('/v1/auth/login').send({ email: 'victim@test.com', password: 'wrong-password' });
    }

    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'other@test.com', password: 'correct-password-123' });
    expect(res.status).toBe(200);
  });

  test('rate limit bucketing is case-insensitive on the email address', async () => {
    await request(app)
      .post('/v1/auth/register')
      .send({ first_name: 'Test', email: 'casetest@test.com', password: 'correct-password-123' });

    for (let i = 0; i < 5; i++) {
      await request(app).post('/v1/auth/login').send({ email: 'CaseTest@Test.com', password: 'wrong-password' });
    }

    const blocked = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'casetest@test.com', password: 'correct-password-123' });
    expect(blocked.status).toBe(429);
  });

  test('a successful login is not itself counted as a failure', async () => {
    await request(app)
      .post('/v1/auth/register')
      .send({ first_name: 'Test', email: 'happy@test.com', password: 'correct-password-123' });

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/v1/auth/login')
        .send({ email: 'happy@test.com', password: 'correct-password-123' });
      expect(res.status).toBe(200);
    }
  });
});
