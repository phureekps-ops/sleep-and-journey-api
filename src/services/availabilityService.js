const pool = require('../db');
const AppError = require('../utils/AppError');

/**
 * Two bookings for the same room type "overlap" (compete for the same
 * physical rooms) when: existing.checkin < new.checkout AND existing.checkout > new.checkin.
 * Only 'confirmed' bookings and *not-yet-expired* 'pending' holds count against inventory -
 * an expired pending hold released the room back to the pool.
 */
const OVERLAP_COUNT_SQL = `
  SELECT COUNT(*)::int AS count
  FROM bookings
  WHERE room_type_id = $1
    AND (status = 'confirmed' OR (status = 'pending' AND hold_expires_at > now()))
    AND checkin_date < $3
    AND checkout_date > $2
`;

async function getAvailability({ branchId, province, checkin, checkout }) {
  if (!checkin || !checkout || new Date(checkout) <= new Date(checkin)) {
    throw new AppError(400, 'INVALID_DATE_RANGE', 'checkout must be after checkin');
  }

  const branchParams = [];
  const whereClauses = [`b.status = 'active'`];
  if (branchId) {
    branchParams.push(branchId);
    whereClauses.push(`b.id = $${branchParams.length}`);
  } else if (province) {
    branchParams.push(province);
    whereClauses.push(`b.province = $${branchParams.length}`);
  }

  const branchesRes = await pool.query(
    `SELECT b.id, b.name FROM branches b WHERE ${whereClauses.join(' AND ')}`,
    branchParams
  );

  const nights = Math.round((new Date(checkout) - new Date(checkin)) / 86400000);

  const results = [];
  for (const branch of branchesRes.rows) {
    const roomTypesRes = await pool.query(
      `SELECT id, name, base_price, max_occupancy FROM room_types WHERE branch_id = $1`,
      [branch.id]
    );

    const roomTypes = [];
    for (const rt of roomTypesRes.rows) {
      const totalRoomsRes = await pool.query(
        `SELECT COUNT(*)::int AS total FROM rooms WHERE room_type_id = $1 AND status = 'available'`,
        [rt.id]
      );
      const totalRooms = totalRoomsRes.rows[0].total;

      const overlapRes = await pool.query(OVERLAP_COUNT_SQL, [rt.id, checkin, checkout]);
      const remaining = totalRooms - overlapRes.rows[0].count;

      if (remaining > 0) {
        const pricePerNight = Number(rt.base_price);
        roomTypes.push({
          room_type_id: rt.id,
          name: rt.name,
          price_per_night: pricePerNight,
          nights,
          total_price: Math.round(pricePerNight * nights),
          rooms_remaining: remaining,
        });
      }
    }

    if (roomTypes.length > 0) {
      results.push({ branch_id: branch.id, branch_name: branch.name, room_types: roomTypes });
    }
  }

  return results;
}

module.exports = { getAvailability, OVERLAP_COUNT_SQL };
