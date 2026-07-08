const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

function hashPassword(plainPassword) {
  return bcrypt.hashSync(plainPassword, SALT_ROUNDS);
}

function verifyPassword(plainPassword, storedHash) {
  return bcrypt.compareSync(plainPassword, storedHash);
}

module.exports = { hashPassword, verifyPassword };
