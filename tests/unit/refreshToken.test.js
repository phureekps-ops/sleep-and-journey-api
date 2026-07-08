const { generateRefreshToken, hashRefreshToken } = require('../../src/utils/refreshToken');

describe('refresh tokens', () => {
  test('the stored hash matches independently hashing the plaintext', () => {
    const { token, tokenHash } = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(tokenHash);
  });

  test('two generated tokens never collide', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  test('expiry is roughly REFRESH_TOKEN_TTL_DAYS days out', () => {
    const { expiresAt } = generateRefreshToken();
    const days = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });
});
