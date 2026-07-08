const { signAccessToken, verifyAccessToken } = require('../../src/utils/jwt');

describe('access tokens', () => {
  test('round-trips a guest payload', () => {
    const token = signAccessToken({ sub: 'guest_123', type: 'guest' });
    const decoded = verifyAccessToken(token);
    expect(decoded.sub).toBe('guest_123');
    expect(decoded.type).toBe('guest');
  });

  test('carries staff role and branch claims', () => {
    const token = signAccessToken({ sub: 'staff_1', type: 'staff', role: 'branch_manager', branch_id: 'b1' });
    const decoded = verifyAccessToken(token);
    expect(decoded.role).toBe('branch_manager');
    expect(decoded.branch_id).toBe('b1');
  });

  test('throws on a tampered token', () => {
    const token = signAccessToken({ sub: 'guest_123', type: 'guest' });
    const tampered = token.slice(0, -2) + 'xx';
    expect(() => verifyAccessToken(tampered)).toThrow();
  });

  test('throws on a token signed with a different secret', () => {
    const jwt = require('jsonwebtoken');
    const foreignToken = jwt.sign({ sub: 'guest_123', type: 'guest' }, 'a-completely-different-secret');
    expect(() => verifyAccessToken(foreignToken)).toThrow();
  });
});
