const pool = require('../db');
const AppError = require('../utils/AppError');
const { hashPassword } = require('../utils/passwords');

const VALID_ROLES = ['branch_staff', 'branch_manager', 'hq_admin'];

async function createStaff({ name, email, password, role, branch_id }) {
  if (!name || !email || !password || !role) {
    throw new AppError(422, 'VALIDATION_ERROR', 'ต้องกรอกชื่อ อีเมล รหัสผ่าน และตำแหน่ง');
  }
  if (!VALID_ROLES.includes(role)) {
    throw new AppError(422, 'INVALID_ROLE', `role ต้องเป็นหนึ่งใน ${VALID_ROLES.join(', ')}`);
  }
  if (role !== 'hq_admin' && !branch_id) {
    throw new AppError(422, 'BRANCH_REQUIRED', 'พนักงานระดับสาขาต้องระบุ branch_id');
  }
  if (password.length < 8) {
    throw new AppError(422, 'WEAK_PASSWORD', 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  }

  const existing = await pool.query('SELECT id FROM staff WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'อีเมลนี้ถูกใช้เป็นบัญชีพนักงานแล้ว');
  }

  const passwordHash = hashPassword(password);
  const result = await pool.query(
    `INSERT INTO staff (name, email, password_hash, role, branch_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, email, role, branch_id, created_at`,
    [name, email, passwordHash, role, role === 'hq_admin' ? null : branch_id]
  );
  return result.rows[0];
}

async function listStaff() {
  const result = await pool.query(
    `SELECT s.id, s.name, s.email, s.role, s.branch_id, b.name AS branch_name, s.is_active, s.created_at
     FROM staff s
     LEFT JOIN branches b ON b.id = s.branch_id
     ORDER BY s.created_at DESC`
  );
  return result.rows;
}

/**
 * PATCH /admin/staff/:id - partial update. Any of name/email/role/branch_id/
 * password/is_active may be provided; omitted fields are left unchanged.
 *
 * Two safety rules enforced here (not just in the UI):
 *  1. A staff member can never disable their own account or change their
 *     own role through this endpoint - that would either lock everyone out
 *     (if they were the only hq_admin) or let someone quietly demote
 *     themselves and cover their tracks. Get a different hq_admin to do it.
 *  2. Disabling an account immediately revokes every refresh token it
 *     holds, so it can no longer mint new access tokens. Any access token
 *     already issued still works until it naturally expires (max 15
 *     minutes) - JWTs are stateless and can't be revoked mid-flight, so a
 *     short TTL is the mitigation, not an afterthought.
 */
async function updateStaff(id, updates, actingStaffId) {
  const { name, email, role, branch_id, password, is_active } = updates;

  const existingRes = await pool.query('SELECT id, role FROM staff WHERE id = $1', [id]);
  if (existingRes.rows.length === 0) {
    throw new AppError(404, 'STAFF_NOT_FOUND', 'ไม่พบบัญชีพนักงานนี้');
  }
  const isSelf = actingStaffId === id;

  if (role !== undefined && !VALID_ROLES.includes(role)) {
    throw new AppError(422, 'INVALID_ROLE', `role ต้องเป็นหนึ่งใน ${VALID_ROLES.join(', ')}`);
  }
  if (password !== undefined && password.length < 8) {
    throw new AppError(422, 'WEAK_PASSWORD', 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  }
  if (isSelf && is_active === false) {
    throw new AppError(409, 'CANNOT_DISABLE_SELF', 'ไม่สามารถปิดใช้งานบัญชีของตัวเองได้ ให้ hq_admin คนอื่นดำเนินการแทน');
  }
  if (isSelf && role !== undefined && role !== existingRes.rows[0].role) {
    throw new AppError(409, 'CANNOT_CHANGE_OWN_ROLE', 'ไม่สามารถเปลี่ยนตำแหน่งของตัวเองได้ ให้ hq_admin คนอื่นดำเนินการแทน');
  }
  if (role !== undefined && role !== 'hq_admin' && branch_id === undefined) {
    throw new AppError(422, 'BRANCH_REQUIRED', 'เมื่อเปลี่ยนเป็นตำแหน่งระดับสาขา ต้องระบุ branch_id มาด้วย');
  }
  if (email !== undefined) {
    const dupe = await pool.query('SELECT id FROM staff WHERE email = $1 AND id != $2', [email, id]);
    if (dupe.rows.length > 0) {
      throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'อีเมลนี้ถูกใช้โดยบัญชีอื่นแล้ว');
    }
  }

  const fields = [];
  const params = [];
  const setField = (column, value) => {
    params.push(value);
    fields.push(`${column} = $${params.length}`);
  };

  if (name !== undefined) setField('name', name);
  if (email !== undefined) setField('email', email);
  if (role !== undefined) setField('role', role);
  if (role === 'hq_admin') {
    setField('branch_id', null); // hq_admin is never scoped to a single branch
  } else if (branch_id !== undefined) {
    setField('branch_id', branch_id);
  }
  if (password !== undefined) setField('password_hash', hashPassword(password));
  if (is_active !== undefined) setField('is_active', is_active);

  if (fields.length === 0) {
    throw new AppError(422, 'NO_FIELDS_TO_UPDATE', 'ไม่มีข้อมูลที่จะอัปเดต');
  }

  params.push(id);
  const result = await pool.query(
    `UPDATE staff SET ${fields.join(', ')} WHERE id = $${params.length}
     RETURNING id, name, email, role, branch_id, is_active, created_at`,
    params
  );

  if (is_active === false) {
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE subject_type = 'staff' AND subject_id = $1 AND revoked_at IS NULL`,
      [id]
    );
  }

  return result.rows[0];
}

module.exports = { createStaff, listStaff, updateStaff };
