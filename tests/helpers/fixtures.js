const { v4: uuidv4 } = require('uuid');
const { pool } = require('./db');

async function createBranch(overrides = {}) {
  const id = overrides.id || uuidv4();
  await pool.query(`INSERT INTO branches (id, name, province, region) VALUES ($1, $2, $3, $4)`, [
    id,
    overrides.name || 'Test Branch',
    overrides.province || 'ทดสอบ',
    overrides.region || 'กลาง',
  ]);
  return id;
}

async function createRoomType(branchId, overrides = {}) {
  const id = overrides.id || uuidv4();
  await pool.query(
    `INSERT INTO room_types (id, branch_id, name, base_price, max_occupancy) VALUES ($1, $2, $3, $4, $5)`,
    [id, branchId, overrides.name || 'Standard Test Room', overrides.basePrice || 1000, overrides.maxOccupancy || 2]
  );
  return id;
}

async function createRooms(roomTypeId, count = 2) {
  const params = [];
  const rows = [];
  for (let i = 0; i < count; i++) {
    params.push(roomTypeId, `R${i + 1}`);
    rows.push(`($${params.length - 1}, $${params.length})`);
  }
  await pool.query(`INSERT INTO rooms (room_type_id, room_number) VALUES ${rows.join(', ')}`, params);
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = { createBranch, createRoomType, createRooms, dateOffset };
