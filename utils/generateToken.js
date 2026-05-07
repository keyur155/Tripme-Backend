const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Generate JWT token
const generateJWTToken = (payload, expiresIn = '7d') => {
  try {
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn,
      issuer: 'tripme-api',
      audience: 'tripme-users'
    });
    return token;
  } catch (error) {
    throw new Error('Error generating JWT token');
  }
};

// Verify JWT token
const verifyJWTToken = (token) => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded;
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
};

// Generate access token (short-lived)
const generateAccessToken = (userId, role) => {
  const payload = {
    userId,
    role,
    type: 'access'
  };
  return generateJWTToken(payload, '15m'); // 15 minutes
};

// Generate refresh token (long-lived)
const generateRefreshToken = (userId) => {
  const payload = {
    userId,
    type: 'refresh'
  };
  return generateJWTToken(payload, '30d'); // 30 days
};

// Generate email verification token
const generateEmailVerificationToken = (userId) => {
  const payload = {
    userId,
    type: 'email'
  };
  return generateJWTToken(payload, '24h'); // 24 hours
};

// Generate password reset token
const generatePasswordResetToken = (userId) => {
  const payload = {
    userId,
    type: 'password_reset'
  };
  return generateJWTToken(payload, '1h'); // 1 hour
};

// Generate two-factor authentication token
const generate2FAToken = (userId) => {
  const payload = {
    userId,
    type: '2fa'
  };
  return generateJWTToken(payload, '5m'); // 5 minutes
};

// Generate API key
const generateAPIKey = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Generate random token (for email verification, password reset, etc.)
const generateRandomToken = (length = 32) => {
  return crypto.randomBytes(length).toString('hex');
};

// Generate numeric verification code
const generateVerificationCode = (length = 6) => {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

// Generate secure random string
const generateSecureString = (length = 16) => {
  return crypto.randomBytes(length).toString('base64url');
};

// Generate session token
const generateSessionToken = (userId, deviceInfo = {}) => {
  const payload = {
    userId,
    type: 'session',
    deviceInfo,
    sessionId: generateSecureString(24)
  };
  return generateJWTToken(payload, '7d'); // 7 days
};

// Generate invitation token
const generateInvitationToken = (inviterId, inviteeEmail, role = 'user') => {
  const payload = {
    inviterId,
    inviteeEmail,
    role,
    type: 'invitation'
  };
  return generateJWTToken(payload, '7d'); // 7 days
};

// Generate temporary access token (for file uploads, etc.)
const generateTemporaryToken = (userId, permissions = []) => {
  const payload = {
    userId,
    type: 'temporary',
    permissions,
    tempId: generateSecureString(16)
  };
  return generateJWTToken(payload, '1h'); // 1 hour
};

// Generate webhook signature
const generateWebhookSignature = (payload, secret) => {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(payload));
  return hmac.digest('hex');
};

// Verify webhook signature
const verifyWebhookSignature = (payload, signature, secret) => {
  const expectedSignature = generateWebhookSignature(payload, secret);
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
};

// Generate OAuth state token
const generateOAuthStateToken = () => {
  return generateSecureString(32);
};

// Generate CSRF token
const generateCSRFToken = (userId) => {
  const payload = {
    userId,
    type: 'csrf',
    nonce: generateSecureString(16)
  };
  return generateJWTToken(payload, '1h'); // 1 hour
};

// Generate file upload token
const generateFileUploadToken = (userId, allowedTypes = [], maxSize = 10485760) => {
  const payload = {
    userId,
    type: 'file_upload',
    allowedTypes,
    maxSize,
    uploadId: generateSecureString(16)
  };
  return generateJWTToken(payload, '30m'); // 30 minutes
};

// Generate payment intent token
const generatePaymentIntentToken = (userId, amount, currency = 'INR') => {
  const payload = {
    userId,
    type: 'payment_intent',
    amount,
    currency,
    intentId: generateSecureString(16)
  };
  return generateJWTToken(payload, '15m'); // 15 minutes
};

// Token utilities
const isTokenExpired = (token) => {
  try {
    const decoded = jwt.decode(token);
    if (!decoded || !decoded.exp) return true;
    return Date.now() >= decoded.exp * 1000;
  } catch (error) {
    return true;
  }
};

const getTokenPayload = (token) => {
  try {
    return jwt.decode(token);
  } catch (error) {
    return null;
  }
};

const extractTokenFromHeader = (authHeader) => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
};

// Token blacklist (in production, use Redis instead of in-memory Set)
const MAX_BLACKLIST_SIZE = 10000;
const tokenBlacklist = new Set();

const blacklistToken = (token) => {
  // Prevent unbounded growth — evict expired tokens first
  if (tokenBlacklist.size >= MAX_BLACKLIST_SIZE) {
    cleanupBlacklist();
  }
  // If still over limit after cleanup, skip (stale tokens will expire naturally)
  if (tokenBlacklist.size < MAX_BLACKLIST_SIZE) {
    tokenBlacklist.add(token);
  }
};

const isTokenBlacklisted = (token) => {
  return tokenBlacklist.has(token);
};

// Clean up expired tokens from blacklist (run periodically)
const cleanupBlacklist = () => {
  for (const token of tokenBlacklist) {
    if (isTokenExpired(token)) {
      tokenBlacklist.delete(token);
    }
  }
};

// Set up periodic cleanup — store ref so it can be cleared on shutdown
const _blacklistCleanupInterval = setInterval(cleanupBlacklist, 60 * 60 * 1000);
_blacklistCleanupInterval.unref(); // Don't keep process alive just for this

module.exports = {
  generateJWTToken,
  verifyJWTToken,
  generateAccessToken,
  generateRefreshToken,
  generateEmailVerificationToken,
  generatePasswordResetToken,
  generate2FAToken,
  generateAPIKey,
  generateRandomToken,
  generateVerificationCode,
  generateSecureString,
  generateSessionToken,
  generateInvitationToken,
  generateTemporaryToken,
  generateWebhookSignature,
  verifyWebhookSignature,
  generateOAuthStateToken,
  generateCSRFToken,
  generateFileUploadToken,
  generatePaymentIntentToken,
  isTokenExpired,
  getTokenPayload,
  extractTokenFromHeader,
  blacklistToken,
  isTokenBlacklisted,
  cleanupBlacklist
};
