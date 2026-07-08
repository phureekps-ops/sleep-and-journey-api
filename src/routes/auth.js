const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const rateLimitService = require('../services/rateLimitService');

// POST /v1/auth/register
router.post('/auth/register', async (req, res, next) => {
  const ip = req.ip;

  try {
    await rateLimitService.assertRegistrationNotRateLimited({ ip });
    const result = await authService.registerGuest(req.body);
    await rateLimitService.recordRegistrationAttempt({ ip });
    res.status(201).json(result);
  } catch (err) {
    if (err.code !== 'TOO_MANY_REGISTRATIONS') {
      // Duplicate-email and weak-password rejections still count toward the
      // cap (see rateLimitService.assertRegistrationNotRateLimited) - only
      // a rejection from the limiter itself is not a new attempt to log.
      await rateLimitService.recordRegistrationAttempt({ ip }).catch(() => {});
    }
    next(err);
  }
});

// POST /v1/auth/login
router.post('/auth/login', async (req, res, next) => {
  // Bucketed lowercased for rate-limit purposes only - the actual login
  // lookup in authService.loginGuest still uses req.body.email exactly as
  // typed, so this never changes which account someone logs into.
  const rateLimitKey = (req.body.email || '').trim().toLowerCase();
  const ip = req.ip;

  try {
    await rateLimitService.assertNotRateLimited({ loginType: 'guest', email: rateLimitKey, ip });
    const result = await authService.loginGuest(req.body);
    await rateLimitService.recordAttempt({ loginType: 'guest', email: rateLimitKey, ip, success: true });
    res.status(200).json(result);
  } catch (err) {
    if (err.code !== 'TOO_MANY_ATTEMPTS') {
      // A rejection from assertNotRateLimited isn't a new attempt to log,
      // it's the limiter doing its job - only log genuine login failures.
      await rateLimitService.recordAttempt({ loginType: 'guest', email: rateLimitKey, ip, success: false }).catch(() => {});
    }
    next(err);
  }
});

// POST /v1/auth/refresh
router.post('/auth/refresh', async (req, res, next) => {
  try {
    const result = await authService.refreshTokens(req.body.refresh_token);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /v1/auth/logout
router.post('/auth/logout', async (req, res, next) => {
  try {
    await authService.logout(req.body.refresh_token);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
