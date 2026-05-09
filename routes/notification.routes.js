const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notification.controller');
const { auth, adminOnly } = require('../middlewares/auth.middleware');
const AuthorizationMiddleware = require('../middlewares/authorization.middleware');

// Protected routes (require authentication)
router.use(auth);

// Notification management
router.get('/', notificationController.getMyNotifications);
router.get('/unread', notificationController.getUnreadNotifications);
router.get('/:id', AuthorizationMiddleware.canAccessNotification, notificationController.getNotificationById);
router.patch('/:id/read', AuthorizationMiddleware.canAccessNotification, notificationController.markAsRead);
router.patch('/read-all', notificationController.markAllAsRead);
router.delete('/:id', AuthorizationMiddleware.canAccessNotification, notificationController.deleteNotification);
router.delete('/clear-all', notificationController.clearAllNotifications);

// Notification preferences
router.get('/preferences', notificationController.getNotificationPreferences);
router.put('/preferences', notificationController.updateNotificationPreferences);

// Notification types and settings
router.get('/types', notificationController.getNotificationTypes);
router.post('/subscribe/:type', notificationController.subscribeToNotification);
router.delete('/subscribe/:type', notificationController.unsubscribeFromNotification);

// Push notifications
router.post('/push-token', notificationController.updatePushToken);
router.delete('/push-token', notificationController.removePushToken);

// Admin routes (admin only)
router.post('/admin/send', adminOnly, notificationController.sendNotification);
router.post('/admin/broadcast', adminOnly, notificationController.broadcastNotification);
router.get('/admin/sent', adminOnly, notificationController.getSentNotifications);

module.exports = router; 