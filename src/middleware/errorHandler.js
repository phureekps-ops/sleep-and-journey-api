const AppError = require('../utils/AppError');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  // Postgres check constraint (e.g. checkout_date > checkin_date) slipping through
  if (err.code === '23514') {
    return res.status(400).json({
      error: { code: 'INVALID_DATE_RANGE', message: 'checkout must be after checkin' },
    });
  }

  console.error('Unhandled error:', err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดที่ไม่คาดคิด กรุณาลองใหม่อีกครั้ง' },
  });
}

module.exports = errorHandler;
