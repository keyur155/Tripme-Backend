const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { auth, adminOnly } = require('../middlewares/auth.middleware');
const { validatePayment, validateRefund } = require('../validations/payment.validation');
const AuthorizationMiddleware = require('../middlewares/authorization.middleware');
const { bookingRateLimit, strictRateLimit } = require('../middlewares/rateLimit.middleware');

// Local helper to wrap Joi schemas as Express middleware
const validateBody = (schema) => (req, res, next) => {
  try {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map((d) => d.message)
      });
    }
    req.body = value;
    next();
  } catch (err) {
    return res.status(400).json({ success: false, message: 'Invalid request body' });
  }
};

// Payment webhooks (for payment gateway callbacks - NO AUTH REQUIRED)
// These must be before auth middleware as they are called by payment gateways
router.post('/webhook/stripe', express.raw({ type: 'application/json' }), paymentController.stripeWebhook);
router.post('/webhook/paypal', express.raw({ type: 'application/json' }), paymentController.paypalWebhook);
router.post('/webhook/razorpay', express.raw({ type: 'application/json' }), paymentController.razorpayWebhook);

// Protected routes (require authentication)
router.use(auth);

// Payment processing (with rate limiting)
router.post('/create-order', strictRateLimit, paymentController.createRazorpayOrder);
router.post('/process', strictRateLimit, validateBody(validatePayment), paymentController.processPayment);
router.post('/confirm/:paymentId', strictRateLimit, paymentController.confirmPayment);
router.post('/cancel/:paymentId', strictRateLimit, paymentController.cancelPayment);
router.post('/:paymentId/fail', strictRateLimit, paymentController.handlePaymentFailure);

// Payment methods management
router.get('/methods', paymentController.getPaymentMethods);
router.post('/methods', paymentController.addPaymentMethod);
router.put('/methods/:methodId', paymentController.updatePaymentMethod);
router.delete('/methods/:methodId', paymentController.deletePaymentMethod);
router.post('/methods/:methodId/set-default', paymentController.setDefaultPaymentMethod);

// Payment history and details
router.get('/', paymentController.getPaymentHistory);
router.get('/host', paymentController.getHostPayments); // New: Host payments
router.get('/:id', AuthorizationMiddleware.canAccessPayment, paymentController.getPaymentById);
router.get('/booking/:bookingId', AuthorizationMiddleware.canAccessBooking, paymentController.getBookingPayments);

// Refund management
router.post('/:paymentId/refund', AuthorizationMiddleware.canAccessPayment, validateBody(validateRefund), paymentController.processRefund);
router.get('/refunds', paymentController.getRefundHistory);
router.get('/refunds/:refundId', AuthorizationMiddleware.canAccessPayment, paymentController.getRefundById);


// Payment statistics and analytics
router.get('/stats/overview', paymentController.getPaymentStats);
router.get('/stats/monthly', paymentController.getMonthlyPaymentStats);
router.get('/stats/methods', paymentController.getPaymentMethodStats);

// Admin routes (admin only)
router.get('/admin/all', adminOnly, paymentController.getAllPayments);
router.get('/admin/payouts', adminOnly, paymentController.getPendingPayouts);
router.post('/admin/payouts/:payoutId/process', adminOnly, paymentController.processHostPayout);
router.get('/admin/stats', adminOnly, paymentController.getAdminPaymentStats);
router.patch('/admin/:paymentId/status', adminOnly, paymentController.updatePaymentStatus);

module.exports = router; 
