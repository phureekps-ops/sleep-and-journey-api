require('dotenv').config();
const pool = require('../src/db');
const { hashPassword } = require('../src/utils/passwords');

async function main() {
  const [, , email, password, role = 'hq_admin', branchId = null] = process.argv;

  if (!email || !password) {
    console.error('Usage: node scripts/seed-staff.js <email> <password> [role] [branch_id]');
    console.error('  role defaults to hq_admin. Pass branch_id and role=branch_manager for a branch account.');
    process.exit(1);
  }

  const passwordHash = hashPassword(password);
  const name = email.split('@')[0];

  const result = await pool.query(
    `INSERT INTO staff (name, email, password_hash, role, branch_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
     RETURNING id, email, role, branch_id`,
    [name, email, passwordHash, role, branchId]
  );

  console.log('Staff account ready:', result.rows[0]);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
