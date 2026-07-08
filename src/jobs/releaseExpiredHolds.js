require('dotenv').config();
const pool = require('../db');

/**
 * Finds every 'pending' booking whose 15-minute inventory hold
 * (hold_expires_at, set in bookingService.createBooking) has lapsed, and
 * marks it 'expired'. Any payment attempt still 'pending' against one of
 * those bookings is marked 'failed' at the same time, so it doesn't sit
 * around looking actionable in the CRM.
 *
 * IMPORTANT - what this job is NOT for: overbooking prevention already
 * works without it. availabilityService's overlap query only counts a
 * 'pending' booking while `hold_expires_at > now()` (see OVERLAP_COUNT_SQL),
 * so an expired-but-not-yet-swept hold is already invisible to new
 * availability checks the instant it lapses. This job exists purely for
 * data hygiene: without it, stale 'pending' rows that will never be paid
 * pile up forever in the bookings table and clutter the CRM's booking list
 * and reports.
 *
 * Concurrency note: safe to run overlapping/parallel invocations. The
 * UPDATE's WHERE clause is re-evaluated by Postgres at the moment it
 * acquires each row's lock, not when the query was first parsed - so if a
 * payment webhook confirms a booking in the same instant this job is
 * scanning it, only one of the two statements ends up matching that row.
 * There's no window where a booking can end up both 'confirmed' and
 * 'expired'.
 */
async function releaseExpiredHolds() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const expiredBookings = await client.query(
      `UPDATE bookings
       SET status = 'expired'
       WHERE status = 'pending' AND hold_expires_at < now()
       RETURNING id, booking_code`
    );

    if (expiredBookings.rows.length > 0) {
      const bookingIds = expiredBookings.rows.map((b) => b.id);
      await client.query(
        `UPDATE payments
         SET status = 'failed'
         WHERE booking_id = ANY($1::uuid[]) AND status = 'pending'`,
        [bookingIds]
      );
    }

    await client.query('COMMIT');
    return expiredBookings.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const expired = await releaseExpiredHolds();
  const timestamp = new Date().toISOString();
  if (expired.length === 0) {
    console.log(`[${timestamp}] release-expired-holds: nothing to do`);
  } else {
    const codes = expired.map((b) => b.booking_code).join(', ');
    console.log(`[${timestamp}] release-expired-holds: expired ${expired.length} booking(s): ${codes}`);
  }
  await pool.end();
}

// Runs when invoked directly (`node src/jobs/releaseExpiredHolds.js`), but
// stays import-safe (no side effects) if something else ever needs to call
// releaseExpiredHolds() directly - e.g. a test, or a scheduler library.
if (require.main === module) {
  main().catch((err) => {
    console.error('release-expired-holds job failed:', err);
    process.exit(1);
  });
}

module.exports = { releaseExpiredHolds };
