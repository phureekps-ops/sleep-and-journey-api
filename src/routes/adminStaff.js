const express = require('express');
const router = express.Router();
const staffService = require('../services/staffService');
const { requireAuth, requireRole } = require('../middleware/auth');

// POST /v1/admin/staff - create a branch_staff / branch_manager / hq_admin account.
// hq_admin only - this replaces the npm run seed:staff CLI script for
// day-to-day use; keep the script around for creating the very first
// hq_admin account (before any staff can log in to call this endpoint).
router.post('/admin/staff', requireAuth, requireRole('hq_admin'), async (req, res, next) => {
  try {
    const staff = await staffService.createStaff(req.body);
    res.status(201).json(staff);
  } catch (err) {
    next(err);
  }
});

// GET /v1/admin/staff - list all staff accounts. hq_admin only.
router.get('/admin/staff', requireAuth, requireRole('hq_admin'), async (req, res, next) => {
  try {
    const staff = await staffService.listStaff();
    res.json({ data: staff });
  } catch (err) {
    next(err);
  }
});

// PATCH /v1/admin/staff/:id - edit or disable a staff account. hq_admin only.
// body: any subset of { name, email, role, branch_id, password, is_active }
router.patch('/admin/staff/:id', requireAuth, requireRole('hq_admin'), async (req, res, next) => {
  try {
    const staff = await staffService.updateStaff(req.params.id, req.body, req.auth.sub);
    res.json(staff);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
