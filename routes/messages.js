// GET POST DELETE for messages with authenticaiton and validation

const router = require('express').Router();
const validateMessage = require('../middleware/validateMessage');
const controller = require('../controllers/messageController');

router.get('/', controller.getMessages);
router.get('/:id', controller.getMessage);
router.post('/', validateMessage, controller.createMessage);
router.delete('/:id', controller.deleteMessage);

module.exports = router;