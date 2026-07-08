const pool = require('../db');
const AppError = require('../utils/AppError');
const { hashPassword, verifyPassword } = require('../utils/passwords');
const { signAccessToken } = require('../utils/jwt');
const { generateRefreshToken, hashRefreshToken } = require('../utils/refreshToken');

const WELCOME_BONUS_POINTS = 300;

// Issues a fresh access + refresh token pair, persisting the refresh token
// (hashed) so it can be looked up and revoked later. Must run inside the
// caller's open transaction so token issuance is atomic with whatever else
// the caller is doing (e.g. creating the guest row).
async function issueTokenPair(client, { subjectType, subjectId, claims }) {
  const accessToken = signAccessToken({ sub: subjectId, type: subjectType, ...claims });
  const { token: refreshToken, tokenHash, expiresAt } = generateRefreshToken();

  await client.query(
    `INSERT INTO refresh_tokens (subject_type, subject_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [subjectType, subjectId, tokenHash, expiresAt]
  );

  return { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer' };
}

async function registerGuest({ first_name, last_name, email, phone, password }) {
  if (!first_name || !email || !password) {
    throw new AppError(422, 'VALIDATION_ERROR', 'ต้องกรอกชื่อ อีเมล และรหัสผ่าน');
  }
  if (password.length < 8) {
    throw new AppError(422, 'WEAK_PASSWORD', 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM guests WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'อีเมลนี้ถูกใช้สมัครสมาชิกแล้ว');
    }

    const passwordHash = hashPassword(password);
    const guestRes = await client.query(
      `INSERT INTO guests (first_name, last_name, email, phone, password_hash, member_tier, points_balance)
       VALUES ($1, $2, $3, $4, $5, 'silver', $6)
       RETURNING id, first_name, last_name, email, member_tier, points_balance`,
      [first_name, last_name || null, email, phone || null, passwordHash, WELCOME_BONUS_POINTS]
    );
    const guest = guestRes.rows[0];

    await client.query(
      `INSERT INTO loyalty_transactions (guest_id, points_change, balance_after, type)
       VALUES ($1, $2, $2, 'bonus')`,
      [guest.id, WELCOME_BONUS_POINTS]
    );

    const tokens = await issueTokenPair(client, { subjectType: 'guest', subjectId: guest.id, claims: {} });

    await client.query('COMMIT');
    return { guest, ...tokens };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function loginGuest({ email, password }) {
  if (!email || !password) {
    throw new AppError(422, 'VALIDATION_ERROR', 'ต้องกรอกอีเมลและรหัสผ่าน');
  }

  const res = await pool.query(
    `SELECT id, first_name, last_name, email, member_tier, points_balance, password_hash
     FROM guests WHERE email = $1`,
    [email]
  );
  // Same error for "no such email" and "wrong password" - never reveal which one it was.
  if (res.rows.length === 0 || !res.rows[0].password_hash || !verifyPassword(password, res.rows[0].password_hash)) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  }
  const guest = res.rows[0];
  delete guest.password_hash;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tokens = await issueTokenPair(client, { subjectType: 'guest', subjectId: guest.id, claims: {} });
    await client.query('COMMIT');
    return { guest, ...tokens };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function loginStaff({ email, password }) {
  if (!email || !password) {
    throw new AppError(422, 'VALIDATION_ERROR', 'ต้องกรอกอีเมลและรหัสผ่าน');
  }

  const res = await pool.query(
    `SELECT id, name, email, role, branch_id, is_active, password_hash FROM staff WHERE email = $1`,
    [email]
  );
  if (res.rows.length === 0 || !verifyPassword(password, res.rows[0].password_hash)) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  }
  const staff = res.rows[0];
  delete staff.password_hash;

  // Checked only after the password is confirmed correct - this tells a
  // legitimate account holder why they're locked out, without giving a
  // wrong-password guesser any information about whether the account exists
  // or is disabled.
  if (!staff.is_active) {
    throw new AppError(403, 'ACCOUNT_DISABLED', 'บัญชีนี้ถูกปิดใช้งานแล้ว กรุณาติดต่อผู้ดูแลระบบ');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tokens = await issueTokenPair(client, {
      subjectType: 'staff',
      subjectId: staff.id,
      claims: { role: staff.role, branch_id: staff.branch_id },
    });
    await client.query('COMMIT');
    return { staff, ...tokens };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Rotation: a refresh token is single-use. Every call here revokes the one
 * presented and issues a brand new one. If a stolen refresh token is ever
 * replayed after the legitimate client already rotated it, the stolen copy
 * fails (already revoked) - a useful signal you could alert on.
 */
async function refreshTokens(refreshTokenPlain) {
  if (!refreshTokenPlain) {
    throw new AppError(401, 'REFRESH_TOKEN_REQUIRED', 'ต้องส่ง refresh_token');
  }
  const tokenHash = hashRefreshToken(refreshTokenPlain);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query(
      `SELECT id, subject_type, subject_id FROM refresh_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [tokenHash]
    );
    if (res.rows.length === 0) {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'refresh token ไม่ถูกต้องหรือหมดอายุแล้ว');
    }
    const row = res.rows[0];

    await client.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);

    let claims = {};
    if (row.subject_type === 'staff') {
      const staffRes = await client.query('SELECT role, branch_id, is_active FROM staff WHERE id = $1', [row.subject_id]);
      if (staffRes.rows.length === 0) {
        throw new AppError(401, 'SUBJECT_NOT_FOUND', 'ไม่พบบัญชีนี้แล้ว');
      }
      if (!staffRes.rows[0].is_active) {
        throw new AppError(403, 'ACCOUNT_DISABLED', 'บัญชีนี้ถูกปิดใช้งานแล้ว');
      }
      claims = { role: staffRes.rows[0].role, branch_id: staffRes.rows[0].branch_id };
    } else {
      const guestRes = await client.query('SELECT id FROM guests WHERE id = $1', [row.subject_id]);
      if (guestRes.rows.length === 0) {
        throw new AppError(401, 'SUBJECT_NOT_FOUND', 'ไม่พบบัญชีนี้แล้ว');
      }
    }

    const tokens = await issueTokenPair(client, {
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      claims,
    });

    await client.query('COMMIT');
    return tokens;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function logout(refreshTokenPlain) {
  if (!refreshTokenPlain) return;
  const tokenHash = hashRefreshToken(refreshTokenPlain);
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
}

module.exports = { registerGuest, loginGuest, loginStaff, refreshTokens, logout };
