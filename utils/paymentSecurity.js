/**
 * Payment Security Utilities
 * Comprehensive security measures for payment processing
 */

const crypto = require('crypto');
const { calculatePricingBreakdown } = require('../config/pricing.config');

/**
 * Generate secure payment session ID
 */
function generatePaymentSessionId() {
  return crypto.randomUUID();
}

/**
 * Generate idempotency key for payment requests
 */
function generateIdempotencyKey() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate secure payment token
 */
function generatePaymentToken(paymentData) {
  const data = JSON.stringify(paymentData);
  const hash = crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(data)
    .digest('hex');
  return hash;
}

/**
 * Verify payment token
 */
function verifyPaymentToken(paymentData, token) {
  const expectedToken = generatePaymentToken(paymentData);
  return crypto.timingSafeEqual(
    Buffer.from(token, 'hex'),
    Buffer.from(expectedToken, 'hex')
  );
}

/**
 * Comprehensive payment amount verification
 */
async function verifyPaymentAmount(paymentData, bookingData) {
  const errors = [];
  const warnings = [];
  
  // Recalculate expected amount from booking data
  const expectedPricing = await calculatePricingBreakdown({
    basePrice: bookingData.basePrice,
    nights: bookingData.nights,
    cleaningFee: bookingData.cleaningFee,
    serviceFee: bookingData.serviceFee,
    securityDeposit: bookingData.securityDeposit,
    extraGuestPrice: bookingData.extraGuestPrice,
    extraGuests: bookingData.extraGuests,
    hourlyExtension: bookingData.hourlyExtension,
    discountAmount: bookingData.discountAmount,
    currency: bookingData.currency
  });
  
  // Verify total amount
  const amountDifference = Math.abs(paymentData.amount - expectedPricing.totalAmount);
  if (amountDifference > 0.01) {
    errors.push(`Amount mismatch: Expected ${expectedPricing.totalAmount}, Got ${paymentData.amount}`);
  }
  
  // Verify subtotal
  if (Math.abs(paymentData.subtotal - expectedPricing.subtotal) > 0.01) {
    errors.push(`Subtotal mismatch: Expected ${expectedPricing.subtotal}, Got ${paymentData.subtotal}`);
  }
  
  // Verify platform fee
  if (Math.abs(paymentData.platformFee - expectedPricing.platformFee) > 0.01) {
    errors.push(`Platform fee mismatch: Expected ${expectedPricing.platformFee}, Got ${paymentData.platformFee}`);
  }
  
  // Verify GST
  if (Math.abs(paymentData.gst - expectedPricing.gst) > 0.01) {
    errors.push(`GST mismatch: Expected ${expectedPricing.gst}, Got ${paymentData.gst}`);
  }
  
  // Verify processing fee
  if (Math.abs(paymentData.processingFee - expectedPricing.processingFee) > 0.01) {
    errors.push(`Processing fee mismatch: Expected ${expectedPricing.processingFee}, Got ${paymentData.processingFee}`);
  }
  
  // Verify discount
  if (Math.abs((paymentData.discountAmount || 0) - (expectedPricing.discountAmount || 0)) > 0.01) {
    errors.push(`Discount mismatch: Expected ${expectedPricing.discountAmount || 0}, Got ${paymentData.discountAmount || 0}`);
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    expectedAmount: expectedPricing.totalAmount,
    actualAmount: paymentData.amount,
    difference: amountDifference,
    expectedPricing
  };
}

/**
 * Validate booking parameters for security
 */
function validateBookingParameters(bookingData) {
  const errors = [];
  const warnings = [];
  
  // Only use the explicit bookingDuration flag — daily bookings also send checkInDateTime
  // for late check-in pricing, so we must NOT infer 24-hour mode from checkInDateTime alone.
  const is24Hour = bookingData.bookingDuration === '24hour';

  // Validate dates / times
  if (is24Hour) {
    if (!bookingData.checkInDateTime) {
      errors.push('Check-in datetime is required for 24-hour booking');
    } else {
      const checkInDt = new Date(bookingData.checkInDateTime);
      const now = new Date();
      if (checkInDt < now) {
        errors.push('24-hour check-in time cannot be in the past');
      }
    }
  } else if (bookingData.checkIn && bookingData.checkOut) {
    const checkIn = new Date(bookingData.checkIn);
    const checkOut = new Date(bookingData.checkOut);
    const now = new Date();
    
    // FIXED: Normalize to date-only for comparison so same-day check-in is allowed
    const checkInDateOnly = new Date(checkIn.getFullYear(), checkIn.getMonth(), checkIn.getDate());
    const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    if (checkInDateOnly < todayOnly) {
      errors.push('Check-in date cannot be in the past');
    }
    
    if (checkOut <= checkIn) {
      errors.push('Check-out date must be after check-in date');
    }
    
    // Check for reasonable booking duration (max 1 year)
    const maxDuration = 365 * 24 * 60 * 60 * 1000; // 1 year in milliseconds
    if (checkOut - checkIn > maxDuration) {
      errors.push('Booking duration cannot exceed 1 year');
    }
  }
  
  // Validate guest count
  if (bookingData.guests) {
    const { adults, children, infants } = bookingData.guests;
    
    if (adults < 1 || adults > 20) {
      errors.push('Adult count must be between 1 and 20');
    }
    
    if (children < 0 || children > 10) {
      errors.push('Children count must be between 0 and 10');
    }
    
    if (infants < 0 || infants > 5) {
      errors.push('Infants count must be between 0 and 5');
    }
    
    if (adults + children + infants > 25) {
      errors.push('Total guest count cannot exceed 25');
    }
  }
  
  // Validate pricing parameters
  if (bookingData.basePrice && bookingData.basePrice < 0) {
    errors.push('Base price cannot be negative');
  }
  
  if (bookingData.basePrice && bookingData.basePrice > 1000000) {
    errors.push('Base price cannot exceed ₹10,00,000');
  }
  
  // Validate hourly extension
  if (bookingData.hourlyExtension !== undefined && bookingData.hourlyExtension !== null) {
    const validHours = [0, 6, 12, 18, 24];
    const hours = typeof bookingData.hourlyExtension === 'number'
      ? bookingData.hourlyExtension
      : bookingData.hourlyExtension.hours;
    if (!validHours.includes(hours)) {
      errors.push('Hourly extension must be 6, 12, or 18 hours');
    }
  }

  // Validate 24h extensionHours if provided separately
  if (bookingData.extensionHours !== undefined && bookingData.extensionHours !== null) {
    const validHours = [0, 6, 12, 18, 24];
    if (!validHours.includes(bookingData.extensionHours)) {
      errors.push('Extension hours must be 6, 12, or 18 hours');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Generate secure webhook signature
 */
function generateWebhookSignature(payload, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return hmac.digest('hex');
}

/**
 * Verify webhook signature
 */
function verifyWebhookSignature(payload, signature, secret) {
  const expectedSignature = generateWebhookSignature(payload, secret);
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
}

/**
 * Rate limiting for payment attempts
 */
class PaymentRateLimit {
  constructor() {
    this.attempts = new Map();
    this.maxAttempts = 5; // Max attempts per 15 minutes
    this.windowMs = 15 * 60 * 1000; // 15 minutes
  }
  
  isAllowed(userId) {
    const now = Date.now();
    const userAttempts = this.attempts.get(userId) || [];
    
    // Remove old attempts outside the window
    const validAttempts = userAttempts.filter(time => now - time < this.windowMs);
    
    if (validAttempts.length >= this.maxAttempts) {
      return false;
    }
    
    // Add current attempt
    validAttempts.push(now);
    this.attempts.set(userId, validAttempts);
    
    return true;
  }
  
  getRemainingAttempts(userId) {
    const now = Date.now();
    const userAttempts = this.attempts.get(userId) || [];
    const validAttempts = userAttempts.filter(time => now - time < this.windowMs);
    return Math.max(0, this.maxAttempts - validAttempts.length);
  }
  
  reset(userId) {
    this.attempts.delete(userId);
  }
}

/**
 * Payment session management
 */
class PaymentSessionManager {
  constructor() {
    this.sessions = new Map();
    this.sessionTimeout = 30 * 60 * 1000; // 30 minutes
  }
  
  createSession(paymentData) {
    const sessionId = generatePaymentSessionId();
    const session = {
      id: sessionId,
      data: paymentData,
      createdAt: Date.now(),
      status: 'pending',
      attempts: 0
    };
    
    this.sessions.set(sessionId, session);
    
    // Auto-cleanup after timeout
    setTimeout(() => {
      this.sessions.delete(sessionId);
    }, this.sessionTimeout);
    
    return sessionId;
  }
  
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    
    // Check if session expired
    if (Date.now() - session.createdAt > this.sessionTimeout) {
      this.sessions.delete(sessionId);
      return null;
    }
    
    return session;
  }
  
  updateSession(sessionId, updates) {
    const session = this.sessions.get(sessionId);
    if (session) {
      Object.assign(session, updates);
      session.updatedAt = Date.now();
    }
  }
  
  deleteSession(sessionId) {
    this.sessions.delete(sessionId);
  }
  
  cleanup() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.createdAt > this.sessionTimeout) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

// Global instances
const paymentRateLimit = new PaymentRateLimit();
const paymentSessionManager = new PaymentSessionManager();

// Cleanup expired sessions every 5 minutes
setInterval(() => {
  paymentSessionManager.cleanup();
}, 5 * 60 * 1000);

module.exports = {
  generatePaymentSessionId,
  generateIdempotencyKey,
  generatePaymentToken,
  verifyPaymentToken,
  verifyPaymentAmount,
  validateBookingParameters,
  generateWebhookSignature,
  verifyWebhookSignature,
  paymentRateLimit,
  paymentSessionManager
};
