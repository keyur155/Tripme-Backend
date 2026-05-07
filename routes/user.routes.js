const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { auth } = require('../middlewares/auth.middleware');
const { roleAuth } = require('../middlewares/role.middleware');
const { validateUpdateProfile, validateKYC } = require('../validations/user.validation');
const AuthorizationMiddleware = require('../middlewares/authorization.middleware');

// Protected routes (require authentication)
router.use(auth);

// User profile management
router.get('/profile', userController.getUserProfile);
router.put('/profile', validateUpdateProfile, userController.updateUserProfile);

// get host by id
router.get('/host/:id', userController.getUserProfile);

// Become host
router.post('/become-host', userController.becomeHost);

// Wishlist
router.get('/wishlist', userController.getWishlist);

// Notifications
router.get('/notifications', userController.getNotifications);
router.put('/notifications/:id/read', userController.markNotificationRead);
router.put('/notifications/read-all', userController.markAllNotificationsRead);
router.delete('/notifications/:id', userController.deleteNotification);

// Dashboard and analytics
router.get('/dashboard', userController.getDashboardStats);
router.get('/analytics', userController.getUserAnalytics);

// Search users
router.get('/search', userController.searchUsers);

// Admin routes (admin only)
router.use(roleAuth(['admin']));
router.patch('/admin/:id/status', AuthorizationMiddleware.canAccessUserProfile, userController.updateUserStatus);
router.put('/admin/:id/verify-kyc', AuthorizationMiddleware.canAccessUserProfile, userController.verifyKYC);

module.exports = router;
