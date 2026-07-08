const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { verifySignature, decodeBackendNotification } = require('../../src/services/paymentGateway/twoCtwoPClient');

describe('2C2P signature verification (legacy HMAC pattern)', () => {
  const secret = 'shared-secret';
  const body = Buffer.from(JSON.stringify({ invoiceNo: 'INV001', status: 'success' }));

  test('accepts a correctly computed signature', () => {
    const validSig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifySignature(body, validSig, secret)).toBe(true);
  });

  test('rejects a tampered signature', () => {
    expect(verifySignature(body, 'deadbeef', secret)).toBe(false);
  });

  test('rejects a signature computed with the wrong secret', () => {
    const sigWithWrongSecret = crypto.createHmac('sha256', 'other-secret').update(body).digest('hex');
    expect(verifySignature(body, sigWithWrongSecret, secret)).toBe(false);
  });

  test('rejects when any required input is missing', () => {
    expect(verifySignature(null, 'abc', secret)).toBe(false);
    expect(verifySignature(body, null, secret)).toBe(false);
    expect(verifySignature(body, 'abc', null)).toBe(false);
  });
});

describe('2C2P backend notification decoding (JWT pattern)', () => {
  const secret = 'shared-secret';

  test('decodes a validly signed notification', () => {
    const token = jwt.sign({ invoiceNo: 'INV001', respCode: '0000' }, secret, { algorithm: 'HS256' });
    const decoded = decodeBackendNotification(token, secret);
    expect(decoded.invoiceNo).toBe('INV001');
    expect(decoded.respCode).toBe('0000');
  });

  test('throws when signed with the wrong secret - never trust an unverifiable notification', () => {
    const token = jwt.sign({ invoiceNo: 'INV001' }, 'wrong-secret', { algorithm: 'HS256' });
    expect(() => decodeBackendNotification(token, secret)).toThrow();
  });

  test('throws on a tampered token', () => {
    const token = jwt.sign({ invoiceNo: 'INV001' }, secret, { algorithm: 'HS256' });
    const tampered = token.slice(0, -2) + 'xx';
    expect(() => decodeBackendNotification(tampered, secret)).toThrow();
  });
});
