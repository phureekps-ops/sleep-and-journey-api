const express = require('express');
const router = express.Router();
const paymentService = require('../services/paymentService');
const twoCtwoP = require('../services/paymentGateway/twoCtwoPClient');
const AppError = require('../utils/AppError');

// POST /v1/webhooks/payment/omise
// Omise posts its event envelope as JSON. We never trust it directly - see
// paymentService.confirmFromOmiseWebhook, which re-fetches the charge status
// from Omise's API before changing anything.
router.post('/webhooks/payment/omise', async (req, res, next) => {
  try {
    const result = await paymentService.confirmFromOmiseWebhook(req.body);
    // Always 200 on a payload we could parse and handle (even if "not our charge") -
    // returning an error status here would make Omise retry forever.
    res.status(200).json({ received: true, ...result });
  } catch (err) {
    next(err);
  }
});

// POST /v1/webhooks/payment/2c2p
// 2C2P's backend notification body is expected as { "payload": "<jwt>" } -
// the JWT itself is what's signed with your merchant secret key (matching
// the same request/response shape used in initiate2c2pPayment and
// requestRefund). decodeBackendNotification throws on any signature or
// structure mismatch; that thrown error is treated as an invalid/forged
// notification and never reaches confirmFrom2c2pWebhook.
router.post('/webhooks/payment/2c2p', async (req, res, next) => {
  try {
    const jwtPayload = req.body && req.body.payload;
    if (!jwtPayload) {
      throw new AppError(400, 'INVALID_WEBHOOK_PAYLOAD', 'ไม่พบ payload (JWT) ใน backend notification');
    }

    let decoded;
    try {
      decoded = twoCtwoP.decodeBackendNotification(jwtPayload, process.env.TWOCTWOP_SECRET_KEY);
    } catch (verifyErr) {
      throw new AppError(400, 'INVALID_SIGNATURE', 'ตรวจสอบลายเซ็น JWT ของ 2C2P ไม่ผ่าน ปฏิเสธการประมวลผล');
    }

    const result = await paymentService.confirmFrom2c2pWebhook(decoded);
    res.status(200).json({ received: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
