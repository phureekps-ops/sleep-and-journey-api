const { generateBookingCode } = require('../../src/utils/bookingCode');

describe('generateBookingCode', () => {
  test('always starts with SJ-', () => {
    expect(generateBookingCode()).toMatch(/^SJ-/);
  });

  test('has 6 characters after the prefix', () => {
    const code = generateBookingCode();
    expect(code.slice(3)).toHaveLength(6);
  });

  test('never contains visually ambiguous characters (0, O, 1, I)', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateBookingCode()).not.toMatch(/[01OI]/);
    }
  });

  test('is randomized, not the same code every call', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateBookingCode()));
    // Astronomically unlikely to collide 10+ times out of 50 if the RNG is working.
    expect(codes.size).toBeGreaterThan(40);
  });
});
