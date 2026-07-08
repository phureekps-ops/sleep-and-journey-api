const express = require('express');
const router = express.Router();
const availabilityService = require('../services/availabilityService');

// GET /v1/availability?branch_id=...&checkin=2026-08-10&checkout=2026-08-12
router.get('/availability', async (req, res, next) => {
  try {
    const { branch_id, province, checkin, checkout } = req.query;
    const data = await availabilityService.getAvailability({
      branchId: branch_id,
      province,
      checkin,
      checkout,
    });
    res.status(200).json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
