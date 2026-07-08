const { cleanupRateLimitLogs } = require('../../src/jobs/cleanupRateLimitLogs');
const { pool, truncateAll, closeDb } = require('../helpers/db');

describe('cleanupRateLimitLogs job', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeDb();
  });

  test('deletes rows older than 30 days and keeps recent ones', async () => {
    await pool.query(
      `INSERT INTO login_attempts (login_type, email, ip_address, success, created_at) VALUES
         ('guest', 'old@test.com', '127.0.0.1', false, now() - interval '31 days'),
         ('guest', 'recent@test.com', '127.0.0.1', false, now() - interval '2 days')`
    );
    await pool.query(
      `INSERT INTO registration_attempts (ip_address, created_at) VALUES
         ('127.0.0.1', now() - interval '31 days'),
         ('127.0.0.1', now() - interval '2 days')`
    );

    const result = await cleanupRateLimitLogs();

    expect(result.loginAttemptsDeleted).toBe(1);
    expect(result.registrationAttemptsDeleted).toBe(1);

    const remainingLogin = await pool.query('SELECT email FROM login_attempts');
    expect(remainingLogin.rows.map((r) => r.email)).toEqual(['recent@test.com']);

    const remainingRegistrationCount = await pool.query('SELECT COUNT(*)::int AS c FROM registration_attempts');
    expect(remainingRegistrationCount.rows[0].c).toBe(1);
  });

  test('deletes nothing when every row is recent', async () => {
    await pool.query(
      `INSERT INTO login_attempts (login_type, email, ip_address, success) VALUES ('guest', 'fresh@test.com', '127.0.0.1', false)`
    );

    const result = await cleanupRateLimitLogs();

    expect(result.loginAttemptsDeleted).toBe(0);
    const remaining = await pool.query('SELECT COUNT(*)::int AS c FROM login_attempts');
    expect(remaining.rows[0].c).toBe(1);
  });
});
