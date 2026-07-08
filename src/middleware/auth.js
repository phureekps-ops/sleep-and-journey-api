const AppError = require('../utils/AppError');
const { verifyAccessToken } = require('../utils/jwt');

function requireAuth(req, res, next) {
  const header = req.header('Authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new AppError(401, 'UNAUTHORIZED', 'ต้องแนบ header Authorization: Bearer <token>'));
  }
  try {
    req.auth = verifyAccessToken(token); // { sub, type, role?, branch_id? }
    next();
  } catch (err) {
    next(new AppError(401, 'INVALID_TOKEN', 'token ไม่ถูกต้องหรือหมดอายุแล้ว'));
  }
}

function requireGuest(req, res, next) {
  if (!req.auth || req.auth.type !== 'guest') {
    return next(new AppError(403, 'FORBIDDEN', 'endpoint นี้ใช้ได้เฉพาะบัญชีลูกค้าเท่านั้น'));
  }
  next();
}

// Usage: requireRole('branch_manager', 'hq_admin')
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.auth || req.auth.type !== 'staff' || !allowedRoles.includes(req.auth.role)) {
      return next(new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์เข้าถึง endpoint นี้'));
    }
    next();
  };
}

module.exports = { requireAuth, requireGuest, requireRole };
