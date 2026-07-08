const crypto = require('crypto');

const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);

// The refresh token itself is a long random string handed to the client.
// We only ever store its SHA-256 hash - same principle as password storage:
// a leaked database row should not let anyone impersonate the user.
function generateRefreshToken() {
  const token = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashRefreshToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, tokenHash, expiresAt };
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { generateRefreshToken, hashRefreshToken, REFRESH_TOKEN_TTL_DAYS };
