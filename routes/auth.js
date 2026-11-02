//POST /register, POST /login, GET /me

const router = require('express').Router();
const authenticate = require('../middleware/authenticate');
const controller = require('../controllers/authController');
const { registerLimiter, loginLimiter } = require('../middleware/rateLimiter');

router.post('/register', registerLimiter, controller.register);
router.post('/login', loginLimiter, controller.login);
router.get('/me', authenticate, controller.me);
router.post('/logout', authenticate, controller.logout);

module.exports = router;