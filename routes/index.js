//main router for the application 

const router = require('express').Router();
const authenticate = require('../middleware/authenticate');

// PUBLIC: only these

router.get('/health', (req, res) => {
  const io = req.app.get('io');
  res.json({
    status: 'ok',
    instance: process.env.INSTANCE_ID || `port-${process.env.PORT || 3000}`,
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    connections: io ? io.engine.clientsCount : 0,
    capacity: Number(process.env.MAX_CONN) || 50,
  });
});

router.use('/auth', require('./auth'));

// PROTECTED: everything registered below this line needs a valid token
router.use(authenticate);
router.use('/messages', require('./messages'));

module.exports = router;