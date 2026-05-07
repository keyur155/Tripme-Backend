const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/booking.controller');
const { auth } = require('../middlewares/auth.middleware');
const { validateBooking } = require('../validations/booking.validation');
const AuthorizationMiddleware = require('../middlewares/authorization.middleware');
const { bookingRateLimit } = require('../middlewares/rateLimit.middleware');
const { securityMiddleware } = require('../middlewares/security.middleware');

// Public routes (no authentication required)
// Hourly booking calculations and settings
router.post('/calculate-hourly-price', 
  securityMiddleware.auditLog('calculate_hourly_booking_price'),
  bookingController.calculateHourlyPrice
);

router.get('/property/:id/hourly-settings', 
  securityMiddleware.auditLog('get_hourly_booking_settings'),
  bookingController.getHourlySettings
);

// 24-hour booking availability (public)
router.post('/check-24hour-availability', 
  securityMiddleware.auditLog('check_24hour_availability'),
  bookingController.check24HourAvailability
);

router.get('/24hour-slots/:propertyId', 
  securityMiddleware.auditLog('get_24hour_time_slots'),
  bookingController.get24HourTimeSlots
);

// Protected routes (require authentication)
router.use(auth);

// Apply rate limiting to all booking routes
router.use(bookingRateLimit);

// Apply additional security measures
router.use(securityMiddleware.validateOrigin);
router.use(securityMiddleware.browserOnly);

// Booking statistics (must come before /:id routes)
router.get('/stats/overview', 
  securityMiddleware.auditLog('view_booking_stats'),
  bookingController.getBookingStats
);

// ── PRE-PAYMENT VALIDATION ─────────────────────────────────────────────────
// Must be called BEFORE creating a Razorpay order.
// Runs all booking checks (params, availability, 24-hour rules) with NO payment side-effects.
// If this passes, it is safe to open the Razorpay payment UI.
router.post('/pre-validate',
  bookingRateLimit,
  securityMiddleware.auditLog('pre_validate_booking'),
  bookingController.preValidateBooking
);

// Booking CRUD operations
router.post('/process-payment', 
  bookingRateLimit,
  securityMiddleware.auditLog('process_payment_and_create_booking'),
  validateBooking, 
  bookingController.processPaymentAndCreateBooking
);

// 24-hour booking
router.post('/process-24hour-payment', 
  bookingRateLimit,
  securityMiddleware.auditLog('process_24hour_booking'),
  validateBooking, 
  bookingController.process24HourBooking
);

router.post('/', 
  securityMiddleware.auditLog('create_booking'),
  validateBooking, 
  bookingController.createBooking
);
router.get('/', 
  securityMiddleware.auditLog('view_my_bookings'),
  bookingController.getMyBookings
);
router.get('/host', 
  securityMiddleware.auditLog('view_host_bookings'),
  bookingController.getHostBookings
);

// Booking calculations and pricing
router.post('/calculate-price', 
  securityMiddleware.auditLog('calculate_booking_price'),
  bookingController.calculateBookingPrice
);

// Download receipt (must come before /:id routes)
router.get('/:id/receipt', 
  securityMiddleware.auditLog('download_booking_receipt'),
  AuthorizationMiddleware.canAccessBooking, 
  bookingController.downloadReceipt
);

// Get cancellation information (must come before /:id routes)
router.get('/:id/cancellation-info', 
  securityMiddleware.auditLog('view_cancellation_info'),
  AuthorizationMiddleware.canAccessBooking, 
  bookingController.getCancellationInfo
);

// Booking status management and CRUD with ID
router.get('/:id', 
  securityMiddleware.auditLog('view_booking_details'),
  AuthorizationMiddleware.canAccessBooking, 
  bookingController.getBookingById
);
router.put('/:id/accept', 
  securityMiddleware.auditLog('accept_booking'),
  AuthorizationMiddleware.canAccessBooking, 
  bookingController.acceptBooking
);
router.put('/:id/reject', 
  securityMiddleware.auditLog('reject_booking'),
  AuthorizationMiddleware.canAccessBooking, 
  bookingController.rejectBooking
);
router.put('/:id/status', 
  securityMiddleware.auditLog('update_booking_status'),
  AuthorizationMiddleware.canAccessBooking, 
  bookingController.updateBookingStatus
);
router.post('/:id/check-in', 
  securityMiddleware.auditLog('check_in_guest'),
  AuthorizationMiddleware.canAccessBooking, 
  bookingController.checkInGuest
);
router.post('/:id/cancel', 
  securityMiddleware.auditLog('cancel_booking'),
  AuthorizationMiddleware.canAccessBooking, 
  bookingController.cancelBooking
);

// Refund routes
router.post('/:id/refund-security-deposit', 
  securityMiddleware.auditLog('refund_security_deposit'),
  AuthorizationMiddleware.canAccessBooking, 
  bookingController.refundSecurityDeposit
);

router.get('/refunds', 
  securityMiddleware.auditLog('view_refund_history'),
  bookingController.getRefundHistory
);

router.get('/:id/refund', 
  securityMiddleware.auditLog('view_booking_refund_details'),
  AuthorizationMiddleware.canAccessBooking, 
  bookingController.getBookingRefund
);

// Admin refund management routes
router.get('/admin/refunds/pending', 
  securityMiddleware.auditLog('view_pending_refunds'),
  bookingController.getPendingRefunds
);

router.put('/admin/refunds/:id/approve', 
  securityMiddleware.auditLog('approve_refund'),
  bookingController.approveRefund
);

router.put('/admin/refunds/:id/reject', 
  securityMiddleware.auditLog('reject_refund'),
  bookingController.rejectRefund
);

router.put('/admin/refunds/:id/processing', 
  securityMiddleware.auditLog('mark_refund_processing'),
  bookingController.markRefundAsProcessing
);

router.put('/admin/refunds/:id/complete', 
  securityMiddleware.auditLog('mark_refund_completed'),
  bookingController.markRefundAsCompleted
);

// Debug endpoint - REMOVED FOR PRODUCTION SECURITY
// router.get('/debug/user-context', (req, res) => { ... });

// Admin endpoint to manually release dates for a booking
router.post('/admin/:id/release-dates', 
  require('../middlewares/auth.middleware').adminOnly,
  require('../middlewares/security.middleware').auditLog('release_booking_dates'),
  bookingController.releaseBookingDates
);

module.exports = router; 