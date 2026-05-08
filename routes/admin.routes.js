const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/authorization.middleware');
const authController = require('../controllers/auth.controller');
const { validateLogin, validateAdminSignup } = require('../validations/auth.validation');

// Import admin controllers
const adminController = require('../controllers/admin.controller');
const popularDestController = require('../controllers/popularDestination.controller');

// Strict rate limit on admin signup — max 3 attempts per hour per IP
const adminSignupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { success: false, message: 'Too many admin signup attempts' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public admin routes (no authentication required)
router.post('/signup', adminSignupLimiter, validateAdminSignup, adminController.adminSignup);
router.post('/login', validateLogin, authController.adminLogin);
router.get('/pricing/platform-fee/public', adminController.getCurrentPlatformFeeRate);

// Apply admin authentication to all other routes
router.use(protect);
router.use(isAdmin);

// Dashboard routes
router.get('/dashboard/stats', adminController.getDashboardStats);

// Platform fee management routes
router.get('/pricing/platform-fee', adminController.getCurrentPlatformFeeRate);
router.put('/pricing/platform-fee', adminController.updatePlatformFeeRate);
router.get('/pricing/platform-fee/history', adminController.getPlatformFeeHistory);

// User management routes
router.get('/users', adminController.getUsers);
router.put('/users/:userId/status', adminController.updateUserStatus);
router.get('/users/:userId', adminController.getUser);
router.put('/users/:userId', adminController.updateUser);

// Host management routes
router.get('/hosts', adminController.getHosts);
router.put('/hosts/:hostId/approve', adminController.approveHost);
router.put('/hosts/:hostId/reject', adminController.rejectHost);

// Property management routes
router.get('/properties', adminController.getProperties);
router.put('/listings/:listingId/approve', adminController.approveListing);
router.put('/listings/:listingId/reject', adminController.rejectListing);
router.patch('/properties/:id/featured', adminController.toggleFeatured);
router.patch('/properties/:id/sponsored', adminController.toggleSponsored);

// Badge management routes
router.get('/badges/available', adminController.getAvailableBadges);
router.get('/properties/:propertyId/badges', adminController.getPropertyBadges);
router.put('/properties/:propertyId/badges', adminController.updatePropertyBadges);
router.post('/properties/:propertyId/badges', adminController.addPropertyBadge);
router.delete('/properties/:propertyId/badges', adminController.removePropertyBadge);
router.patch('/properties/:propertyId/badges/toggle', adminController.toggleAdminBadges);

// Booking management routes
router.get('/bookings', adminController.getBookings);
router.post('/bookings/:bookingId/refund', adminController.refundBooking);

// KYC management routes
router.get('/kyc', adminController.getKYC);
router.get('/kyc/:userId', adminController.getKYCById);
router.put('/kyc/:kycId/verify', adminController.verifyKYC);
router.put('/kyc/:kycId/reject', adminController.rejectKYC);

// Payment management routes
router.get('/payments', adminController.getPayments);
router.post('/payments/:paymentId/payout', adminController.processPayout);

// Review management routes
router.get('/reviews', adminController.getReviews);
router.put('/reviews/:reviewId/flag', adminController.flagReview);
router.delete('/reviews/:reviewId', adminController.deleteReview);

// Settings routes
router.get('/settings', adminController.getSettings);
router.put('/settings', adminController.updateSettings);

// Analytics and reports routes
router.get('/analytics', adminController.getAnalytics);
router.get('/reports', adminController.getReports);

// System routes
router.get('/activities/recent', adminController.getRecentActivities);
router.get('/system/health', adminController.getSystemHealth);

// Payment audit routes
router.get('/audit/payments', adminController.getPaymentAuditDashboard);
router.get('/audit/validation-failures', adminController.getValidationFailures);
router.get('/audit/payments/:paymentId', adminController.getPaymentAuditDetails);

// Popular Destinations management routes
router.get('/popular-destinations', popularDestController.getAdminDestinations);
router.post('/popular-destinations', popularDestController.createDestination);
router.put('/popular-destinations/:id', popularDestController.updateDestination);
router.delete('/popular-destinations/:id', popularDestController.deleteDestination);
router.patch('/popular-destinations/:id/toggle', popularDestController.toggleActive);
router.patch('/popular-destinations/reorder', popularDestController.reorderDestinations);

module.exports = router;