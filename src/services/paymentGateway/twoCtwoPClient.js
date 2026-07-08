// 2C2P Payment Gateway (PGW) client.
//
// !!! VERSION CAVEAT - READ BEFORE USING WITH REAL MONEY !!!
// 2C2P's Payment Gateway API has gone through several major revisions.
// What's implemented below targets the JWT-based PGW 4.x shape (the request
// body itself is a JWT signed HS256 with your merchant secret key; the
// response and the backend notification are JWTs the same way). Field
// names, endpoint paths, required paymentChannel values, and even whether
// your merchant contract uses this shape AT ALL can differ. Before this
// touches real money:
//   1. Log in to the 2C2P merchant portal and pull YOUR account's current
//      API spec / Postman collection.
//   2. Diff every field name, URL, and claim below against it.
//   3. Test exhaustively against the 2C2P sandbox before going live.
// This is "the shape of the pattern", not a verified-correct integration.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const API_BASE = process.env.TWOCTWOP_API_BASE || 'https://sandbox-pgw.2c2p.com';

// --- Older/alternate pattern: plain HMAC-SHA256 over the raw request body ---
// Some 2C2P integrations (and other gateways generally) verify a webhook
// this way instead of the JWT approach below. Kept as a documented
// alternative in case your specific contract type uses it - see the JWT
// functions further down for what this project's webhook route actually
// calls today.
function verifySignature(rawBody, receivedSignature, secretKey) {
  if (!receivedSignature || !rawBody || !secretKey) return false;

  const expected = crypto.createHmac('sha256', secretKey).update(rawBody).digest('hex');

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(receivedSignature);
  if (expectedBuf.length !== receivedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

// --- JWT-based PGW 4.x pattern ---

function buildRequestToken(payload, secretKey) {
  return jwt.sign(payload, secretKey, { algorithm: 'HS256', noTimestamp: true });
}

/**
 * Starts a hosted-payment-page flow: 2C2P handles card/QR channel selection
 * on their own page, then redirects back to frontendReturnUrl and separately
 * POSTs a backend notification to backendReturnUrl (see
 * decodeBackendNotification below).
 */
async function createPaymentToken({
  merchantId,
  secretKey,
  invoiceNo,
  amount,
  currencyCode,
  description,
  frontendReturnUrl,
  backendReturnUrl,
}) {
  const requestPayload = {
    merchantID: merchantId,
    invoiceNo,
    description,
    amount: Number(amount).toFixed(2), // 2C2P expects a decimal string, e.g. "1500.00"
    currencyCode: currencyCode || 'THB',
    paymentChannel: ['CC', 'ALL'],
    frontendReturnUrl,
    backendReturnUrl,
  };
  const requestToken = buildRequestToken(requestPayload, secretKey);

  const res = await fetch(`${API_BASE}/payment/4.3/paymentToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: requestToken }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`2C2P paymentToken request failed (${res.status}): ${JSON.stringify(data)}`);
  }

  // The response body is itself a JWT, signed with the same secret key.
  const decoded = jwt.verify(data.payload, secretKey, { algorithms: ['HS256'] });
  if (decoded.respCode !== '0000') {
    throw new Error(`2C2P paymentToken rejected: ${decoded.respDesc || decoded.respCode}`);
  }
  return { webPaymentUrl: decoded.webPaymentUrl, paymentToken: decoded.paymentToken };
}

/**
 * Verifies and decodes 2C2P's backend payment notification. Throws
 * (jsonwebtoken's normal JsonWebTokenError/TokenExpiredError) if the
 * signature doesn't check out - callers MUST treat any throw here as "not a
 * genuine notification" and never act on the payload.
 */
function decodeBackendNotification(rawJwtPayload, secretKey) {
  return jwt.verify(rawJwtPayload, secretKey, { algorithms: ['HS256'] });
}

/**
 * Refunds all or part of a previously successful payment, identified by the
 * invoiceNo used when the payment token was created.
 */
async function requestRefund({ merchantId, secretKey, invoiceNo, amount, currencyCode }) {
  const requestPayload = {
    merchantID: merchantId,
    invoiceNo,
    actionAmount: Number(amount).toFixed(2),
    currencyCode: currencyCode || 'THB',
  };
  const requestToken = buildRequestToken(requestPayload, secretKey);

  const res = await fetch(`${API_BASE}/payment/4.3/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: requestToken }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`2C2P refund request failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return jwt.verify(data.payload, secretKey, { algorithms: ['HS256'] });
}

module.exports = { verifySignature, createPaymentToken, decodeBackendNotification, requestRefund };
