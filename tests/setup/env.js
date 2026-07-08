// Loaded via jest's `setupFiles` before any test file's module scope runs,
// so these env vars are in place before src/db.js or src/utils/jwt.js etc.
// ever read process.env.

require('dotenv').config({ path: '.env.test' });

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test_only_secret_do_not_use_in_prod';
process.env.ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
process.env.REFRESH_TOKEN_TTL_DAYS = process.env.REFRESH_TOKEN_TTL_DAYS || '30';

// Deliberately prefer DATABASE_URL_TEST over DATABASE_URL so a stray `npm
// test` can never accidentally point at your real dev/production database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST || 'postgres://postgres:postgres@localhost:5432/sleep_and_journey_test';
