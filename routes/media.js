const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const controller = require('../controllers/mediaController');

const imageBody = express.raw({ type: ['image/png', 'image/jpeg'], limit: '5mb' });

router.use(authenticate);
router.post('/', imageBody, controller.uploadMessage);
router.post('/profile', imageBody, controller.uploadProfile);
router.get('/profile/:xid', controller.downloadProfile);
router.get('/:mediaId', controller.downloadMessage);
router.post('/:mediaId/downloaded', controller.acknowledgeMessageDownload);

module.exports = router;

