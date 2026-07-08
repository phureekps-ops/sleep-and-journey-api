const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /v1/admin/bookings
// branch_staff / branch_manager: ALWAYS scoped to req.auth.branch_id, no
// matter what branch_id query param they send - this is enforced here, not
// just "defaulted", so a branch employee can never widen their own view.
// hq_admin: sees everything, optionally filterable by branch_id.
router.get(
  '/admin/bookings',
  requireAuth,
  requireRole('branch_staff', 'branch_manager', 'hq_admin'),
  async (req, res, next) => {
    try {
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const pageSize = Math.min(parseInt(req.query.page_size, 10) || 20, 100);
      const offset = (page - 1) * pageSize;

      const params = [];
      const where = [];

      if (req.auth.role === 'hq_admin') {
        if (req.query.branch_id) {
          params.push(req.query.branch_id);
          where.push(`branch_id = $${params.length}`);
        }
      } else {
        params.push(req.auth.branch_id);
        where.push(`branch_id = $${params.length}`);
      }

      if (req.query.status) {
        params.push(req.query.status);
        where.push(`status = $${params.length}`);
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM bookings ${whereSql}`, params);
      const dataRes = await pool.query(
        `SELECT id, booking_code, branch_id, room_type_id, guest_id, checkin_date, checkout_date,
                status, total_price, created_at
         FROM bookings
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ${pageSize} OFFSET ${offset}`,
        params
      );

      res.json({
        data: dataRes.rows,
        meta: { page, page_size: pageSize, total: countRes.rows[0].total },
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
