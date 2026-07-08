const pool = require('../../src/db');

// Wipes every table between tests so each test starts from a clean slate.
// CASCADE handles the foreign keys without needing to list tables in
// dependency order.
async function truncateAll() {
  await pool.query(`
    TRUNCATE TABLE
      webhook_events,
      booking_cancellations,
      loyalty_transactions,
      payments,
      refresh_tokens,
      bookings,
      rooms,
      room_types,
      staff,
      guests,
      branches,
      login_attempts,
      registration_attempts
    CASCADE
  `);
}

async function closeDb() {
  await pool.end();
}

module.exports = { pool, truncateAll, closeDb };
