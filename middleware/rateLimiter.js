//applies rate limiting to the register and login endpoints to prevent brute force attacks

const rateLimit = require('express-rate-limit');

const disabled = () => process.env.RATE_LIMIT_DISABLED === 'true';

const make = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7', // sends RateLimit headers and Retry-After
    legacyHeaders: false,
    skip: disabled,             // lets us switch it off for load tests
    message: { error: message },
  });

exports.registerLimiter = make(
  Number(process.env.REGISTER_WINDOW_MS) || 60 * 60 * 1000, // 1 hour
  Number(process.env.REGISTER_MAX) || 5,
  'Too many sign-up attempts from this IP. Please try again later.'
);

exports.loginLimiter = make(
  Number(process.env.LOGIN_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  Number(process.env.LOGIN_MAX) || 20,
  'Too many login attempts. Please try again later.'
);