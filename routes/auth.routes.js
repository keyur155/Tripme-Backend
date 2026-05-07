const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/auth.controller');
const { auth } = require('../middlewares/auth.middleware');
const { validateRegistration, validateLogin, validatePasswordReset } = require('../validations/auth.validation');

// Strict rate limit for password reset to prevent email flooding
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // 3 attempts per window per IP
  message: { success: false, message: 'Too many password reset requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public routes
router.post('/register', validateRegistration, authController.registerUser);
router.post('/login', validateLogin, authController.loginUser);
// Sends link to reset password
router.post('/forgot-password', passwordResetLimiter, authController.forgotPassword);
// Check the validity of the reset token
router.get('/reset-password/:token', authController.validateResetToken);
// Reset password
router.post('/reset-password/:token', validatePasswordReset, authController.resetPassword);
router.get('/verify-email/:token', authController.verifyEmail);
router.post('/resend-verification', passwordResetLimiter, authController.resendVerificationEmail);

// Social authentication
router.post('/google', authController.socialLogin);
router.post('/facebook', authController.socialLogin);
router.post('/apple', authController.socialLogin);

// Protected routes (require authentication)
router.use(auth);

// User session management
router.get('/me', authController.getCurrentUser);
router.put('/profile', authController.updateProfile);
router.put('/password', authController.changePassword);
router.post('/logout', authController.logoutUser);
router.post('/logout-all', authController.logoutAllDevices);

// Account management
router.delete('/account', authController.deleteAccount);
router.post('/deactivate', authController.deactivateAccount);
router.post('/reactivate', authController.reactivateAccount);

// Two-factor authentication
router.post('/2fa/enable', authController.enable2FA);
router.post('/2fa/disable', authController.disable2FA);
router.post('/2fa/verify', authController.verify2FA);

// Session management
router.get('/sessions', authController.getActiveSessions);
router.delete('/sessions/:sessionId', authController.terminateSession);

module.exports = router;
