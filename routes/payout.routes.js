const express = require('express');
const router = express.Router();
const payoutController = require('../controllers/payout.controller');
const { auth, adminOnly } = require('../middlewares/auth.middleware');

// Protected routes (require authentication)
router.use(auth);

// Host payout routes
router.get('/host', payoutController.getHostPayouts);
router.get('/:id', payoutController.getPayoutById);
router.put('/:id/method', payoutController.updatePayoutMethod);
router.post('/:id/cancel', payoutController.requestPayoutCancellation);

// Admin payout routes (admin only)
router.use(adminOnly);
router.get('/admin/all', payoutController.getAllPayouts);
router.get('/admin/stats', payoutController.getPayoutStats);
router.post('/admin/:id/confirm', payoutController.confirmPayoutDone);  // ← Mark payout done from Razorpay dashboard
router.post('/admin/:id/reverse', payoutController.reversePayout);
router.post('/admin/bulk-process', payoutController.bulkProcessPayouts);

module.exports = router;
