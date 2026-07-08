const express = require('express');
const availabilityRoutes = require('./routes/availability');
const bookingRoutes = require('./routes/bookings');
const paymentRoutes = require('./routes/payments');
const webhookRoutes = require('./routes/webhooks');
const authRoutes = require('./routes/auth');
const adminAuthRoutes = require('./routes/adminAuth');
const guestRoutes = require('./routes/guests');
const loyaltyRoutes = require('./routes/loyalty');
const adminBookingsRoutes = require('./routes/adminBookings');
const adminStaffRoutes = require('./routes/adminStaff');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// IMPORTANT for rate limiting (rateLimitService uses req.ip): if this app
// runs behind a reverse proxy or load balancer (nginx, Railway, an AWS ALB,
// etc.), req.ip will show the PROXY's address for every request unless you
// tell Express how many proxy hops to trust - and every login attempt would
// then look like it came from the same IP, making the per-IP limiter
// useless. Set TRUST_PROXY_HOPS to the number of proxies in front of this
// app (usually 1). Do NOT set this to `true` blindly - trusting an
// arbitrary X-Forwarded-For depth lets a client spoof their own IP.
if (process.env.TRUST_PROXY_HOPS) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
}

// Capture the raw request bytes alongside the parsed JSON - the 2C2P webhook
// signature must be verified over the exact bytes they sent, not a
// re-serialized copy of req.body.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/v1', availabilityRoutes);
app.use('/v1', bookingRoutes);
app.use('/v1', paymentRoutes);
app.use('/v1', webhookRoutes);
app.use('/v1', authRoutes);
app.use('/v1', adminAuthRoutes);
app.use('/v1', guestRoutes);
app.use('/v1', loyaltyRoutes);
app.use('/v1', adminBookingsRoutes);
app.use('/v1', adminStaffRoutes);

app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'ไม่พบ endpoint นี้' } });
});

app.use(errorHandler);

module.exports = app;
