const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';

function signAccessToken(payload) {
  // payload: { sub, type: 'guest' | 'staff', role?, branch_id? }
  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

function verifyAccessToken(token) {
  // Throws (TokenExpiredError / JsonWebTokenError) on anything invalid -
  // callers should treat any throw as "not authenticated".
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET);
}

module.exports = { signAccessToken, verifyAccessToken };
