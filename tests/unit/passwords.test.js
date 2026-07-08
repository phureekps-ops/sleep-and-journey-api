const { hashPassword, verifyPassword } = require('../../src/utils/passwords');

describe('password hashing', () => {
  test('verifyPassword accepts the correct password', () => {
    const hash = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
  });

  test('verifyPassword rejects a wrong password', () => {
    const hash = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('wrong-password', hash)).toBe(false);
  });

  test('the same password produces a different hash each time (salted)', () => {
    const hash1 = hashPassword('same-password');
    const hash2 = hashPassword('same-password');
    expect(hash1).not.toBe(hash2);
    expect(verifyPassword('same-password', hash1)).toBe(true);
    expect(verifyPassword('same-password', hash2)).toBe(true);
  });
});
