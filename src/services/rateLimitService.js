const pool = require('../db');
const AppError = require('../utils/AppError');

const WINDOW_MINUTES = 15;
const MAX_FAILED_ATTEMPTS_PER_EMAIL = 5; // stops brute-forcing one account
const MAX_FAILED_ATTEMPTS_PER_IP = 20; // stops one IP from spraying guesses across many emails

/**
 * Deliberately backed by Postgres rather than an in-memory store or Redis.
 * An in-memory counter (e.g. a plain object, or the popular
 * express-rate-limit default store) only works correctly on a single
 * process - the same problem flagged for the release-expired-holds cron
 * job: run more than one instance of this API behind a load balancer and
 * each instance would track its own separate counters, letting an attacker
 * get MAX_ATTEMPTS worth of tries per instance instead of in total. Since
 * Postgres is already the source of truth for everything else here, reusing
 * it avoids introducing a new piece of infrastructure just for this.
 */
async function assertNotRateLimited({ loginType, email, ip }) {
  const emailCountRes = await pool.query(
    `SELECT COUNT(*)::int AS c FROM login_attempts
     WHERE login_type = $1 AND email = $2 AND success = false
       AND created_at > now() - make_interval(mins => $3)`,
    [loginType, email, WINDOW_MINUTES]
  );
  if (emailCountRes.rows[0].c >= MAX_FAILED_ATTEMPTS_PER_EMAIL) {
    throw new AppError(
      429,
      'TOO_MANY_ATTEMPTS',
      `พยายามเข้าสู่ระบบผิดพลาดหลายครั้งเกินไป กรุณาลองใหม่ภายใน ${WINDOW_MINUTES} นาที`,
      { retry_after_minutes: WINDOW_MINUTES }
    );
  }

  const ipCountRes = await pool.query(
    `SELECT COUNT(*)::int AS c FROM login_attempts
     WHERE ip_address = $1 AND success = false
       AND created_at > now() - make_interval(mins => $2)`,
    [ip, WINDOW_MINUTES]
  );
  if (ipCountRes.rows[0].c >= MAX_FAILED_ATTEMPTS_PER_IP) {
    throw new AppError(
      429,
      'TOO_MANY_ATTEMPTS',
      `มีการพยายามเข้าสู่ระบบผิดพลาดจากอุปกรณ์นี้มากเกินไป กรุณาลองใหม่ภายใน ${WINDOW_MINUTES} นาที`,
      { retry_after_minutes: WINDOW_MINUTES }
    );
  }
}

async function recordAttempt({ loginType, email, ip, success }) {
  if (!email) return; // nothing meaningful to bucket a malformed request under
  await pool.query(
    `INSERT INTO login_attempts (login_type, email, ip_address, success) VALUES ($1, $2, $3, $4)`,
    [loginType, email, ip || 'unknown', success]
  );
}

const REGISTRATION_WINDOW_MINUTES = 60;
const MAX_REGISTRATIONS_PER_IP = 5;

/**
 * Registration is a different shape of problem than login: there's no
 * "wrong password" signal to count, because a spam script just uses a new
 * email every time and every request looks superficially valid. So instead
 * of counting failures, this counts EVERY attempt (success or failure) from
 * an IP within the window - a duplicate-email rejection still costs server
 * work and can be used to enumerate registered emails, so it counts too.
 */
async function assertRegistrationNotRateLimited({ ip }) {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS c FROM registration_attempts
     WHERE ip_address = $1 AND created_at > now() - make_interval(mins => $2)`,
    [ip, REGISTRATION_WINDOW_MINUTES]
  );
  if (res.rows[0].c >= MAX_REGISTRATIONS_PER_IP) {
    throw new AppError(
      429,
      'TOO_MANY_REGISTRATIONS',
      `มีการสมัครสมาชิกจากอุปกรณ์นี้บ่อยเกินไป กรุณาลองใหม่ภายใน ${REGISTRATION_WINDOW_MINUTES} นาที`,
      { retry_after_minutes: REGISTRATION_WINDOW_MINUTES }
    );
  }
}

async function recordRegistrationAttempt({ ip }) {
  await pool.query(`INSERT INTO registration_attempts (ip_address) VALUES ($1)`, [ip || 'unknown']);
}

module.exports = {
  assertNotRateLimited,
  recordAttempt,
  assertRegistrationNotRateLimited,
  recordRegistrationAttempt,
  WINDOW_MINUTES,
  REGISTRATION_WINDOW_MINUTES,
};
