// Minimal Omise REST client using the built-in fetch (Node 18+).
// No SDK dependency needed - Omise's API is plain HTTP + Basic Auth.
// Docs: https://www.omise.co/api (field names/behaviour may change - verify
// against current docs before relying on this in production).

const OMISE_API_BASE = 'https://api.omise.co';

function authHeader(key) {
  return 'Basic ' + Buffer.from(`${key}:`).toString('base64');
}

async function omisePost(path, params, key) {
  const res = await fetch(`${OMISE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(key),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (!res.ok) {
    const message = data && data.message ? data.message : res.statusText;
    throw new Error(`Omise API error (${res.status}): ${message}`);
  }
  return data;
}

// method: 'card' - charges an already-tokenized card (token created client-side
// with Omise.js so the raw card number never touches our server).
async function createCardCharge({ amountSatang, currency, cardToken, description }) {
  return omisePost(
    '/charges',
    { amount: amountSatang, currency, card: cardToken, description },
    process.env.OMISE_SECRET_KEY
  );
}

// method: 'qr' - PromptPay is a two-step flow in Omise: create a "source"
// (the QR itself), then create a charge against that source.
async function createPromptPayCharge({ amountSatang, currency, description }) {
  const source = await omisePost(
    '/sources',
    { amount: amountSatang, currency, type: 'promptpay' },
    process.env.OMISE_PUBLIC_KEY
  );

  const charge = await omisePost(
    '/charges',
    { amount: amountSatang, currency, source: source.id, description },
    process.env.OMISE_SECRET_KEY
  );

  return charge; // charge.source.scannable_code.image.download_uri holds the QR PNG
}

// Omise webhooks are NOT cryptographically signed by default, so the body of
// an incoming webhook must never be trusted on its own for a money decision.
// The safe pattern: take the charge id the webhook mentions, then ask Omise
// directly (server-to-server, using our secret key) what that charge's real
// status is right now, and act on THAT response instead.
async function fetchChargeStatus(chargeId) {
  const res = await fetch(`${OMISE_API_BASE}/charges/${chargeId}`, {
    headers: { Authorization: authHeader(process.env.OMISE_SECRET_KEY) },
  });
  const data = await res.json();
  if (!res.ok) {
    const message = data && data.message ? data.message : res.statusText;
    throw new Error(`Omise API error (${res.status}): ${message}`);
  }
  return data;
}

// Refunds all or part of a successful charge. Omise refunds are processed
// asynchronously on their end (typically a few business days to actually
// land back on the customer's card/account) - a successful response here
// means "refund request accepted", not "money has arrived".
async function refundCharge(chargeId, amountSatang) {
  return omisePost(`/charges/${chargeId}/refunds`, { amount: amountSatang }, process.env.OMISE_SECRET_KEY);
}

module.exports = { createCardCharge, createPromptPayCharge, fetchChargeStatus, refundCharge };
