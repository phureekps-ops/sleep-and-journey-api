const pool = require('../db');
const AppError = require('../utils/AppError');
const omise = require('./paymentGateway/omiseClient');
const twoCtwoP = require('./paymentGateway/twoCtwoPClient');
const loyaltyService = require('./loyaltyService');

const THB_TO_SATANG = 100;

function buildPaymentResponse({ bookingId, paymentId, method, gatewayResult }) {
  if (method === 'qr') {
    return {
      booking_id: bookingId,
      payment_id: paymentId,
      method,
      qr_image_url: gatewayResult?.source?.scannable_code?.image?.download_uri || null,
      expires_at: gatewayResult?.expires_at || null,
    };
  }
  if (method === 'card') {
    // 3-D Secure cards come back with an authorize_uri the client must redirect to.
    if (gatewayResult.authorize_uri) {
      return { booking_id: bookingId, payment_id: paymentId, method, redirect_url: gatewayResult.authorize_uri };
    }
    return { booking_id: bookingId, payment_id: paymentId, method, status: gatewayResult.status };
  }
  // transfer
  return {
    booking_id: bookingId,
    payment_id: paymentId,
    method: 'transfer',
    bank_account: {
      bank: 'ธนาคารกสิกรไทย',
      account_no: '012-3-45678-9',
      account_name: 'Sleep and Journey Co., Ltd.',
    },
    instructions: 'โอนเงินตามยอดที่แจ้ง แล้วแนบสลิปผ่านช่องทางแอดมิน เพื่อยืนยันการชำระเงินด้วยตนเอง',
  };
}

/**
 * POST /bookings/:id/payment
 * Starts (or, for cards without 3DS, completes) payment for a pending booking.
 * gateway defaults to 'omise' for backward compatibility with existing callers.
 */
async function initiatePayment({ bookingId, method, cardToken, gateway = 'omise' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bookingRes = await client.query(
      `SELECT id, status, total_price, hold_expires_at FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );
    if (bookingRes.rows.length === 0) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', 'ไม่พบการจองนี้');
    }
    const booking = bookingRes.rows[0];

    if (booking.status !== 'pending') {
      throw new AppError(
        409,
        'BOOKING_NOT_PAYABLE',
        `การจองนี้อยู่ในสถานะ '${booking.status}' ไม่สามารถชำระเงินได้`
      );
    }
    if (booking.hold_expires_at && new Date(booking.hold_expires_at) < new Date()) {
      throw new AppError(409, 'HOLD_EXPIRED', 'เวลาที่ระบบถือห้องไว้หมดอายุแล้ว กรุณาทำการจองใหม่');
    }

    const response =
      gateway === '2c2p'
        ? await initiate2c2pPayment({ client, bookingId, booking })
        : await initiateOmisePayment({ client, bookingId, booking, method, cardToken });

    await client.query('COMMIT');
    return response;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function initiateOmisePayment({ client, bookingId, booking, method, cardToken }) {
  const amountSatang = Math.round(Number(booking.total_price) * THB_TO_SATANG);
  let gatewayResult;

  if (method === 'qr') {
    gatewayResult = await omise.createPromptPayCharge({
      amountSatang,
      currency: 'THB',
      description: `Sleep&Journey booking ${bookingId}`,
    });
  } else if (method === 'card') {
    if (!cardToken) {
      throw new AppError(
        422,
        'CARD_TOKEN_REQUIRED',
        'การชำระด้วยบัตรต้องส่ง card_token ที่สร้างฝั่ง client ด้วย Omise.js ก่อน (ห้ามส่งเลขบัตรตรงมาที่ server)'
      );
    }
    gatewayResult = await omise.createCardCharge({
      amountSatang,
      currency: 'THB',
      cardToken,
      description: `Sleep&Journey booking ${bookingId}`,
    });
  } else if (method === 'transfer') {
    gatewayResult = { id: null, status: 'pending' };
  } else {
    throw new AppError(422, 'INVALID_METHOD', "method ต้องเป็น 'card', 'qr' หรือ 'transfer'");
  }

  const gatewayName = method === 'transfer' ? 'manual' : 'omise';
  const paymentRes = await client.query(
    `INSERT INTO payments (booking_id, amount, currency, method, status, gateway, gateway_charge_id)
     VALUES ($1, $2, 'THB', $3, 'pending', $4, $5)
     RETURNING id`,
    [bookingId, booking.total_price, method, gatewayName, gatewayResult.id || null]
  );
  const paymentId = paymentRes.rows[0].id;

  // Some card charges (no 3DS challenge required) resolve synchronously.
  // Confirm right away rather than waiting on a webhook that may be delayed.
  if (method === 'card' && gatewayResult.status === 'successful') {
    await client.query(`UPDATE payments SET status = 'paid', paid_at = now() WHERE id = $1`, [paymentId]);
    await client.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [bookingId]);
    await loyaltyService.earnPointsForBooking(client, { bookingId });
  }

  return buildPaymentResponse({ bookingId, paymentId, method, gatewayResult });
}

/**
 * 2C2P's flow is fundamentally a redirect, not a direct charge: the
 * customer picks their own payment channel (card, QR, etc.) on 2C2P's
 * hosted page, so there's no "method" branching here like the Omise path.
 */
async function initiate2c2pPayment({ client, bookingId, booking }) {
  if (!process.env.TWOCTWOP_BACKEND_RETURN_URL) {
    throw new AppError(
      500,
      'GATEWAY_NOT_CONFIGURED',
      'ยังไม่ได้ตั้งค่า TWOCTWOP_BACKEND_RETURN_URL - ดูหัวข้อการชำระเงินผ่าน 2C2P ใน README'
    );
  }

  // 2C2P's invoiceNo has a length/character-set limit per their spec -
  // verify the exact constraint against your account's docs. This strips
  // hyphens from the booking's UUID and truncates as a reasonable default.
  const invoiceNo = `SJ${bookingId.replace(/-/g, '').slice(0, 16)}`;

  const { webPaymentUrl } = await twoCtwoP.createPaymentToken({
    merchantId: process.env.TWOCTWOP_MERCHANT_ID,
    secretKey: process.env.TWOCTWOP_SECRET_KEY,
    invoiceNo,
    amount: Number(booking.total_price),
    currencyCode: 'THB',
    description: `Sleep&Journey booking ${bookingId}`,
    frontendReturnUrl: process.env.TWOCTWOP_FRONTEND_RETURN_URL,
    backendReturnUrl: process.env.TWOCTWOP_BACKEND_RETURN_URL,
  });

  const paymentRes = await client.query(
    `INSERT INTO payments (booking_id, amount, currency, method, status, gateway, gateway_ref)
     VALUES ($1, $2, 'THB', 'redirect', 'pending', '2c2p', $3)
     RETURNING id`,
    [bookingId, booking.total_price, invoiceNo]
  );

  return {
    booking_id: bookingId,
    payment_id: paymentRes.rows[0].id,
    method: 'redirect',
    gateway: '2c2p',
    redirect_url: webPaymentUrl,
  };
}



/**
 * POST /webhooks/payment/omise
 * `event` is Omise's raw event envelope, e.g. { id, key: 'charge.complete', data: { id: 'chrg_xxx', ... } }
 * We do NOT trust event.data.status directly - we re-fetch the charge from
 * Omise using the id it references, and act on that response instead.
 */
async function confirmFromOmiseWebhook(event) {
  const chargeId = event?.data?.id;
  if (!chargeId) {
    throw new AppError(400, 'INVALID_WEBHOOK_PAYLOAD', 'ไม่พบ charge id ใน webhook payload');
  }

  const charge = await omise.fetchChargeStatus(chargeId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // De-duplicate by (gateway, event.id) so a retried webhook delivery is a pure no-op.
    if (event.id) {
      const dupe = await client.query(
        `INSERT INTO webhook_events (gateway, event_id, payload)
         VALUES ('omise', $1, $2)
         ON CONFLICT (gateway, event_id) DO NOTHING
         RETURNING id`,
        [event.id, event]
      );
      if (dupe.rows.length === 0) {
        await client.query('COMMIT');
        return { handled: true, duplicate: true };
      }
    }

    const paymentRes = await client.query(
      `SELECT id, booking_id, status FROM payments WHERE gateway_charge_id = $1 FOR UPDATE`,
      [chargeId]
    );
    if (paymentRes.rows.length === 0) {
      await client.query('COMMIT');
      return { handled: false, reason: 'no matching payment for this charge id' };
    }
    const payment = paymentRes.rows[0];

    if (payment.status === 'paid') {
      await client.query('COMMIT');
      return { handled: true, alreadyProcessed: true };
    }

    if (charge.status === 'successful' || charge.paid === true) {
      await client.query(`UPDATE payments SET status = 'paid', paid_at = now() WHERE id = $1`, [payment.id]);
      await client.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [payment.booking_id]);
      await loyaltyService.earnPointsForBooking(client, { bookingId: payment.booking_id });
    } else if (charge.status === 'failed' || charge.failure_code) {
      await client.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [payment.id]);
    }
    // Any other status (e.g. still 'pending' 3DS) - leave as-is, a later webhook will settle it.

    await client.query('COMMIT');
    return { handled: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * POST /webhooks/payment/2c2p
 * `payload` is 2C2P's backend notification, already verified and decoded
 * from its signed JWT by the route handler (twoCtwoP.decodeBackendNotification)
 * before this function is ever called - never pass raw, unverified request
 * bodies in here. `payload.invoiceNo` matches the value generated and
 * stored in payments.gateway_ref by initiate2c2pPayment above.
 */
async function confirmFrom2c2pWebhook(payload) {
  const invoiceNo = payload?.invoiceNo;
  const eventId = payload?.transactionId || invoiceNo;
  if (!invoiceNo) {
    throw new AppError(400, 'INVALID_WEBHOOK_PAYLOAD', 'ไม่พบ invoiceNo ใน webhook payload');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (eventId) {
      const dupe = await client.query(
        `INSERT INTO webhook_events (gateway, event_id, payload)
         VALUES ('2c2p', $1, $2)
         ON CONFLICT (gateway, event_id) DO NOTHING
         RETURNING id`,
        [eventId, payload]
      );
      if (dupe.rows.length === 0) {
        await client.query('COMMIT');
        return { handled: true, duplicate: true };
      }
    }

    const paymentRes = await client.query(
      `SELECT id, booking_id, status FROM payments WHERE gateway_ref = $1 FOR UPDATE`,
      [invoiceNo]
    );
    if (paymentRes.rows.length === 0) {
      await client.query('COMMIT');
      return { handled: false, reason: 'no matching payment for this invoiceNo' };
    }
    const payment = paymentRes.rows[0];

    if (payment.status === 'paid') {
      await client.query('COMMIT');
      return { handled: true, alreadyProcessed: true };
    }

    // 2C2P's actual success indicator is a response/status code field per
    // their API version (e.g. respCode '0000'). Map that exact field here.
    const isSuccess = payload.status === 'success' || payload.respCode === '0000';

    if (isSuccess) {
      await client.query(`UPDATE payments SET status = 'paid', paid_at = now() WHERE id = $1`, [payment.id]);
      await client.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [payment.booking_id]);
      await loyaltyService.earnPointsForBooking(client, { bookingId: payment.booking_id });
    } else {
      await client.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [payment.id]);
    }

    await client.query('COMMIT');
    return { handled: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { initiatePayment, confirmFromOmiseWebhook, confirmFrom2c2pWebhook };
