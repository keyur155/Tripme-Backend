const express = require('express');
const router = express.Router();
const {
  subscribeEmail,
  getAllSubscriptions,
  unsubscribeEmail
} = require('../controllers/emailSubscription');
const {
  validateEmailSubscription,
  validateEmailUnsubscribe
} = require('../validations/emailSubscription.validation');

// Public routes
router.post('/subscribe', validateEmailSubscription, subscribeEmail);
router.post('/unsubscribe', validateEmailUnsubscribe, unsubscribeEmail);

// Admin only routes
router.get('admin/all', getAllSubscriptions);

module.exports = router;