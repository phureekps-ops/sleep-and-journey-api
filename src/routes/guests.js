const express = require('express');
const router = express.Router();
const pool = require('../db');
const AppError = require('../utils/AppError');
const { requireAuth, requireGuest } = require('../middleware/auth');

// GET /v1/guests/me
router.get('/guests/me', requireAuth, requireGuest, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, email, phone, member_tier, points_balance, created_at
       FROM guests WHERE id = $1`,
      [req.auth.sub]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'GUEST_NOT_FOUND', 'ไม่พบบัญชีนี้');
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /v1/guests/me
router.patch('/guests/me', requireAuth, requireGuest, async (req, res, next) => {
  try {
    const { first_name, last_name, phone } = req.body;
    const result = await pool.query(
      `UPDATE guests SET
         first_name = COALESCE($2, first_name),
         last_name  = COALESCE($3, last_name),
         phone      = COALESCE($4, phone)
       WHERE id = $1
       RETURNING id, first_name, last_name, email, phone, member_tier, points_balance`,
      [req.auth.sub, first_name, last_name, phone]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'GUEST_NOT_FOUND', 'ไม่พบบัญชีนี้');
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
