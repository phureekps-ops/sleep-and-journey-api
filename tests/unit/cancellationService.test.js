const { calculateCancellationFee } = require('../../src/services/cancellationService');

describe('calculateCancellationFee', () => {
  test('full refund when 72+ hours before check-in', () => {
    expect(calculateCancellationFee(100, 1000)).toEqual({ fee: 0, refundAmount: 1000 });
  });

  test('exactly 72 hours counts as full refund (boundary is inclusive)', () => {
    expect(calculateCancellationFee(72, 1000)).toEqual({ fee: 0, refundAmount: 1000 });
  });

  test('50% fee between 24 and 72 hours before check-in', () => {
    expect(calculateCancellationFee(48, 1000)).toEqual({ fee: 500, refundAmount: 500 });
  });

  test('exactly 24 hours still counts as partial refund (boundary is inclusive)', () => {
    expect(calculateCancellationFee(24, 1000)).toEqual({ fee: 500, refundAmount: 500 });
  });

  test('no refund inside 24 hours', () => {
    expect(calculateCancellationFee(5, 1000)).toEqual({ fee: 1000, refundAmount: 0 });
  });

  test('no refund once check-in has already passed (negative hours)', () => {
    expect(calculateCancellationFee(-3, 1000)).toEqual({ fee: 1000, refundAmount: 0 });
  });

  test('rounds the fee to the nearest baht rather than leaving fractional satang', () => {
    // 999 * 0.5 = 499.5 -> rounds to 500, refund is the remainder
    const result = calculateCancellationFee(30, 999);
    expect(result.fee).toBe(500);
    expect(result.refundAmount).toBe(499);
    expect(result.fee + result.refundAmount).toBe(999);
  });
});
