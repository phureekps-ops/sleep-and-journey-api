const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const rateLimitService = require('../services/rateLimitService');

// POST /v1/admin/auth/login
// Staff accounts are never self-registered - they're created with
// `npm run seed:staff` (or, later, a proper HQ-only "create staff" endpoint).
router.post('/admin/auth/login', async (req, res, next) => {
  const rateLimitKey = (req.body.email || '').trim().toLowerCase();
  const ip = req.ip;

  try {
    await rateLimitService.assertNotRateLimited({ loginType: 'staff', email: rateLimitKey, ip });
    const result = await authService.loginStaff(req.body);
    await rateLimitService.recordAttempt({ loginType: 'staff', email: rateLimitKey, ip, success: true });
    res.status(200).json(result);
  } catch (err) {
    if (err.code !== 'TOO_MANY_ATTEMPTS') {
      await rateLimitService.recordAttempt({ loginType: 'staff', email: rateLimitKey, ip, success: false }).catch(() => {});
    }
    next(err);
  }
});

module.exports = router;
