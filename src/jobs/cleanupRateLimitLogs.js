require('dotenv').config();
const pool = require('../db');

const RETENTION_DAYS = 30;

/**
 * Deletes login_attempts / registration_attempts rows older than
 * RETENTION_DAYS. Both tables exist purely to back rolling-window rate
 * limiting (15-minute window for login, 60-minute for registration - see
 * rateLimitService.js) - nothing in the app ever reads a row older than an
 * hour, so this is pure housekeeping to stop the tables growing forever,
 * not something that affects rate-limiting correctness if it runs late.
 *
 * Safe to run concurrently with the app itself and with overlapping
 * invocations of this same job: a DELETE ... WHERE created_at < X needs no
 * special locking beyond what Postgres already does for any DELETE.
 */
async function cleanupRateLimitLogs() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const loginResult = await client.query(
      `DELETE FROM login_attempts WHERE created_at < now() - make_interval(days => $1)`,
      [RETENTION_DAYS]
    );
    const registrationResult = await client.query(
      `DELETE FROM registration_attempts WHERE created_at < now() - make_interval(days => $1)`,
      [RETENTION_DAYS]
    );

    await client.query('COMMIT');
    return {
      loginAttemptsDeleted: loginResult.rowCount,
      registrationAttemptsDeleted: registrationResult.rowCount,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const result = await cleanupRateLimitLogs();
  const timestamp = new Date().toISOString();
  console.log(
    `[${timestamp}] cleanup-rate-limit-logs: deleted ${result.loginAttemptsDeleted} login_attempts row(s), ` +
      `${result.registrationAttemptsDeleted} registration_attempts row(s)`
  );
  await pool.end();
}

// Runs when invoked directly (`node src/jobs/cleanupRateLimitLogs.js`), but
// stays import-safe if something else ever needs to call
// cleanupRateLimitLogs() directly - e.g. a test.
if (require.main === module) {
  main().catch((err) => {
    console.error('cleanup-rate-limit-logs job failed:', err);
    process.exit(1);
  });
}

module.exports = { cleanupRateLimitLogs, RETENTION_DAYS };
