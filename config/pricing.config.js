/**
 * Centralized Pricing Configuration
 * This file defines all pricing constants and calculations used across the platform
 */

const PricingConfig = require('../models/PricingConfig');
const { toTwoDecimals, getCurrentPlatformFeeRate, calculatePricingBreakdown, calculateHourlyExtension, validatePricingConsistency } = require('../utils/pricingUtils');

const PRICING_CONFIG = {
  // NOTE: Fee rates (platformFeeRate, gstRate, processingFeeRate, processingFeeFixed)
  // are now managed exclusively via the PricingConfig DB model.
  // Use PricingConfig.getCurrentPricingConfig() to fetch them at runtime.

  // Currency settings
  DEFAULT_CURRENCY: 'INR',
  SUPPORTED_CURRENCIES: ['INR', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD'],
  
  // Minimum amounts
  MIN_BASE_PRICE: 1,
  MIN_CLEANING_FEE: 0,
  MIN_SERVICE_FEE: 0,
  MIN_SECURITY_DEPOSIT: 0,
  
  // Maximum amounts (for validation)
  MAX_BASE_PRICE: 1000000, // ₹10,00,000
  MAX_CLEANING_FEE: 10000, // ₹10,000
  MAX_SERVICE_FEE: 50000, // ₹50,000
  MAX_SECURITY_DEPOSIT: 50000, // ₹50,000
  
  // Hourly booking rates (percentage of daily rate)
  HOURLY_RATES: {
    SIX_HOURS: 0.30, // 30% of daily rate
    TWELVE_HOURS: 0.60, // 60% of daily rate
    EIGHTEEN_HOURS: 0.75 // 75% of daily rate
  },
  
  // Discount limits
  MAX_WEEKLY_DISCOUNT: 100, // 100% max
  MAX_MONTHLY_DISCOUNT: 100, // 100% max
  MAX_COUPON_DISCOUNT: 100, // 100% max
};

/**
 * Calculate pricing breakdown for a booking
 * @param {Object} params - Pricing parameters
 * @param {number} params.basePrice - Base price per night
 * @param {number} params.nights - Number of nights
 * @param {number} params.cleaningFee - Cleaning fee (set by host)
 * @param {number} params.serviceFee - Service fee (set by host)
 * @param {number} params.securityDeposit - Security deposit (set by host)
 * @param {number} params.extraGuestPrice - Extra guest price per night
 * @param {number} params.extraGuests - Number of extra guests
 * @param {number} params.hourlyExtension - Hourly extension cost
 * @param {number} params.discountAmount - Discount amount
 * @param {string} params.currency - Currency code
 * @returns {Object} Complete pricing breakdown
 */
async function calculatePricingBreakdownWrapper(params) {
  // Use shared utility function
  return await calculatePricingBreakdown(params);
}

/**
 * Calculate hourly extension cost
 * @param {number} basePrice - Daily base price
 * @param {number} hours - Extension hours (6, 12, or 18)
 * @returns {number} Extension cost
 */
function calculateHourlyExtensionWrapper(basePrice, hours) {
  // Use shared utility function
  return calculateHourlyExtension(basePrice, hours);
}

/**
 * Calculate new checkout time based on hourly extension
 * @param {Date} originalCheckOut - Original checkout date
 * @param {number} extensionHours - Extension hours (6, 12, or 18)
 * @param {string} checkOutTime - Original checkout time (e.g., "11:00")
 * @returns {Object} New checkout information
 */
function calculateExtendedCheckout(originalCheckOut, extensionHours, checkOutTime = "11:00") {
  const checkoutDate = new Date(originalCheckOut);
  
  // Parse the checkout time
  const [hours, minutes] = checkOutTime.split(':').map(Number);
  checkoutDate.setHours(hours, minutes, 0, 0);
  
  // Add extension hours
  const newCheckoutTime = new Date(checkoutDate.getTime() + (extensionHours * 60 * 60 * 1000));
  
  // Check if checkout extends to next day
  const originalDate = new Date(originalCheckOut);
  originalDate.setHours(0, 0, 0, 0);
  const newDate = new Date(newCheckoutTime);
  newDate.setHours(0, 0, 0, 0);
  
  const isNextDay = newDate.getTime() > originalDate.getTime();
  
  // Format new checkout time
  const newCheckoutTimeString = newCheckoutTime.toTimeString().slice(0, 5);
  
  return {
    checkoutDate: isNextDay ? newDate : originalDate,
    checkoutTime: newCheckoutTimeString,
    isNextDay: isNextDay,
    extensionHours: extensionHours,
    originalCheckout: checkoutDate,
    newCheckout: newCheckoutTime
  };
}

/**
 * Get additional dates needed for hourly extension
 * @param {Date} originalCheckOut - Original checkout date
 * @param {number} extensionHours - Extension hours (6, 12, or 18)
 * @param {string} checkOutTime - Original checkout time
 * @returns {Array} Array of additional dates that need to be blocked
 */
function getAdditionalDatesForExtension(originalCheckOut, extensionHours, checkOutTime = "11:00") {
  const extensionInfo = calculateExtendedCheckout(originalCheckOut, extensionHours, checkOutTime);
  
  if (!extensionInfo.isNextDay) {
    return []; // No additional dates needed
  }
  
  // Return the additional date(s) that need to be blocked
  const additionalDates = [];
  const currentDate = new Date(originalCheckOut);
  currentDate.setHours(0, 0, 0, 0);
  
  const nextDate = new Date(currentDate);
  nextDate.setDate(nextDate.getDate() + 1);
  
  additionalDates.push(nextDate);
  
  return additionalDates;
}

/**
 * Validate pricing parameters
 * @param {Object} pricing - Pricing object to validate
 * @returns {Object} Validation result
 */
function validatePricing(pricing) {
  const errors = [];
  
  if (pricing.basePrice < PRICING_CONFIG.MIN_BASE_PRICE) {
    errors.push(`Base price must be at least ₹${PRICING_CONFIG.MIN_BASE_PRICE}`);
  }
  
  if (pricing.basePrice > PRICING_CONFIG.MAX_BASE_PRICE) {
    errors.push(`Base price cannot exceed ₹${PRICING_CONFIG.MAX_BASE_PRICE}`);
  }
  
  if (pricing.cleaningFee < PRICING_CONFIG.MIN_CLEANING_FEE) {
    errors.push(`Cleaning fee must be at least ₹${PRICING_CONFIG.MIN_CLEANING_FEE}`);
  }
  
  if (pricing.cleaningFee > PRICING_CONFIG.MAX_CLEANING_FEE) {
    errors.push(`Cleaning fee cannot exceed ₹${PRICING_CONFIG.MAX_CLEANING_FEE}`);
  }
  
  if (pricing.serviceFee < PRICING_CONFIG.MIN_SERVICE_FEE) {
    errors.push(`Service fee must be at least ₹${PRICING_CONFIG.MIN_SERVICE_FEE}`);
  }
  
  if (pricing.serviceFee > PRICING_CONFIG.MAX_SERVICE_FEE) {
    errors.push(`Service fee cannot exceed ₹${PRICING_CONFIG.MAX_SERVICE_FEE}`);
  }
  
  if (pricing.securityDeposit < PRICING_CONFIG.MIN_SECURITY_DEPOSIT) {
    errors.push(`Security deposit must be at least ₹${PRICING_CONFIG.MIN_SECURITY_DEPOSIT}`);
  }
  
  if (pricing.securityDeposit > PRICING_CONFIG.MAX_SECURITY_DEPOSIT) {
    errors.push(`Security deposit cannot exceed ₹${PRICING_CONFIG.MAX_SECURITY_DEPOSIT}`);
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

module.exports = {
  PRICING_CONFIG,
  calculatePricingBreakdown: calculatePricingBreakdownWrapper,
  calculateHourlyExtension: calculateHourlyExtensionWrapper,
  calculateExtendedCheckout,
  getAdditionalDatesForExtension,
  validatePricing,
  // Export shared utilities
  toTwoDecimals,
  getCurrentPlatformFeeRate,
  validatePricingConsistency
};
