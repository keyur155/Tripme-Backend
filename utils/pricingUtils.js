/**
 * Shared Pricing Utilities
 * Centralized pricing calculations and utilities for backend
 */

const PricingConfig = require('../models/PricingConfig');
const { logger } = require('../config/logger');

/**
 * Round to two decimal places consistently
 * @param {number} value - Value to round
 * @returns {number} Rounded value
 */
function toTwoDecimals(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Get current platform fee rate from database
 * @returns {Promise<number>} Current platform fee rate
 */
async function getCurrentPlatformFeeRate() {
  try {
    const rate = await PricingConfig.getCurrentPlatformFeeRate();
    return rate;
  } catch (error) {
    logger.error('Error fetching platform fee rate, using model default', { error: error.message });
    return 0.03; // Schema default fallback
  }
}

/**
 * Get full current fee configuration (platform, GST, processing)
 * Falls back to defaults if DB is missing.
 */
async function getCurrentFeeConfig() {
  try {
    const cfg = await PricingConfig.getCurrentPricingConfig();
    return cfg;
  } catch (error) {
    logger.error('Error fetching pricing config, using PricingConfig schema defaults', { error: error.message });
    // Return the same defaults defined in the PricingConfig model schema
    return {
      platformFeeRate: 0.03,
      gstRate: 0.18,
      processingFeeRate: 0.029,
      processingFeeFixed: 30
    };
  }
}

/**
 * Calculate 24-hour based pricing breakdown
 * @param {Object} params - Pricing parameters for 24-hour booking
 * @returns {Promise<Object>} Complete pricing breakdown
 */
async function calculate24HourPricing(params) {
  const {
    basePrice24Hour,
    totalHours = 24,
    extraGuestPrice = 0,
    extraGuests = 0,
    cleaningFee = 0,
    serviceFee = 0,
    securityDeposit = 0,
    hourlyExtension = 0,
    discountAmount = 0,
    currency = 'INR'
  } = params;

  // Get current fee config from database
  const { platformFeeRate, gstRate, processingFeeRate, processingFeeFixed } = await getCurrentFeeConfig();

  // Base calculation for 24 hours
  let baseAmount = basePrice24Hour;
  
  // Add extra hours beyond 24 (using existing extension logic)
  let extraHoursCost = 0;
  if (totalHours > 24) {
    const extraHours = totalHours - 24;
    extraHoursCost = calculateHourlyExtension(basePrice24Hour, extraHours);
    // Do NOT add to baseAmount here so it shows separately in the UI breakdown
  }
  
  // Add extra guest charges
  if (extraGuests > 0) {
    baseAmount += extraGuestPrice * extraGuests;
  }
  
  // Add host-set fees (excluding security deposit - it's held separately)
  const hostFees = cleaningFee + serviceFee;
  
  // Add hourly extension
  const extensionCost = (hourlyExtension || 0) + extraHoursCost;
  
  // Calculate subtotal for host earning (excluding security deposit)
  const hostSubtotal = baseAmount + hostFees + extensionCost - discountAmount;
  
  // Calculate total subtotal (including security deposit for customer payment)
  const totalSubtotal = hostSubtotal + securityDeposit;
  
  // Calculate TripMe service fee (on host subtotal only, not security deposit)
  const platformFee = toTwoDecimals(hostSubtotal * platformFeeRate);
  
  // Calculate GST (configurable, on total subtotal including security deposit)
  const gst = toTwoDecimals(totalSubtotal * gstRate);
  
  // Calculate processing fee (configurable rate + fixed on total subtotal)
  const processingFee = toTwoDecimals(totalSubtotal * processingFeeRate + processingFeeFixed);
  
  // Calculate total amount (what customer pays)
  const totalAmount = toTwoDecimals(totalSubtotal + platformFee + gst + processingFee);
  
  // Calculate host earning (host subtotal minus TripMe service fee - security deposit is held separately)
  const hostEarning = toTwoDecimals(hostSubtotal - platformFee);
  
  // Calculate platform revenue (TripMe service fee + processing fee)
  const platformRevenue = toTwoDecimals(platformFee + processingFee);

  return {
    // Base pricing
    baseAmount: toTwoDecimals(baseAmount),
    totalHours,
    extraGuests,
    extraGuestCost: toTwoDecimals(extraGuestPrice * extraGuests),
    
    // Host-set fees
    cleaningFee: toTwoDecimals(cleaningFee),
    serviceFee: toTwoDecimals(serviceFee),
    securityDeposit: toTwoDecimals(securityDeposit),
    hostFees: toTwoDecimals(hostFees),
    
    // Extensions and discounts
    hourlyExtension: toTwoDecimals(extensionCost),
    discountAmount: toTwoDecimals(discountAmount),
    
    // Subtotal (before platform fee and taxes)
    subtotal: toTwoDecimals(totalSubtotal),
    hostSubtotal: toTwoDecimals(hostSubtotal),
    
    // TripMe service fees
    platformFee: toTwoDecimals(platformFee),
    processingFee: toTwoDecimals(processingFee),
    platformRevenue: toTwoDecimals(platformRevenue),
    
    // Taxes
    gst: toTwoDecimals(gst),
    
    // Final amounts
    totalAmount: toTwoDecimals(totalAmount),
    hostEarning: toTwoDecimals(hostEarning),
    
    // Currency
    currency,
    
    // Rate used for calculation
    platformFeeRate,
    gstRate,
    processingFeeRate,
    processingFeeFixed,
    
    // Breakdown for display
    breakdown: {
      // What customer sees
      customerBreakdown: {
        baseAmount: toTwoDecimals(baseAmount),
        cleaningFee: toTwoDecimals(cleaningFee),
        serviceFee: toTwoDecimals(serviceFee),
        securityDeposit: toTwoDecimals(securityDeposit),
        hourlyExtension: toTwoDecimals(extensionCost),
        discountAmount: toTwoDecimals(discountAmount),
        subtotal: toTwoDecimals(totalSubtotal),
        platformFee: toTwoDecimals(platformFee),
        gst: toTwoDecimals(gst),
        processingFee: toTwoDecimals(processingFee),
        totalAmount: toTwoDecimals(totalAmount)
      },
      
      // What host sees
      hostBreakdown: {
        baseAmount: toTwoDecimals(baseAmount),
        cleaningFee: toTwoDecimals(cleaningFee),
        serviceFee: toTwoDecimals(serviceFee),
        securityDeposit: toTwoDecimals(securityDeposit),
        hourlyExtension: toTwoDecimals(extensionCost),
        discountAmount: toTwoDecimals(discountAmount),
        subtotal: toTwoDecimals(hostSubtotal),
        platformFee: toTwoDecimals(platformFee),
        hostEarning: toTwoDecimals(hostEarning)
      },
      
      // What TripMe sees
      platformBreakdown: {
        platformFee: toTwoDecimals(platformFee),
        processingFee: toTwoDecimals(processingFee),
        gst: toTwoDecimals(gst),
        platformRevenue: toTwoDecimals(platformRevenue)
      }
    }
  };
}

/**
 * Calculate pricing breakdown with dynamic platform fee rate
 * @param {Object} params - Pricing parameters
 * @returns {Promise<Object>} Complete pricing breakdown
 */
async function calculatePricingBreakdown(params) {
  const {
    basePrice,
    nights = 1,
    cleaningFee = 0,
    serviceFee = 0,
    securityDeposit = 0,
    extraGuestPrice = 0,
    extraGuests = 0,
    hourlyExtension = 0,
    discountAmount = 0,
    currency = 'INR',
    bookingType,
    basePrice24Hour,
    totalHours
  } = params;

  // Use 24-hour pricing for new system
  if (bookingType === '24hour' || totalHours) {
    return await calculate24HourPricing(params);
  }

  // Get current fee config from database
  const { platformFeeRate, gstRate, processingFeeRate, processingFeeFixed } = await getCurrentFeeConfig();

  // Calculate base amount
  let baseAmount = basePrice * nights;
  
  // Add extra guest charges
  if (extraGuests > 0) {
    baseAmount += extraGuestPrice * extraGuests * nights;
  }
  
  // Add host-set fees (excluding security deposit - it's held separately)
  const hostFees = cleaningFee + serviceFee;
  
  // Add hourly extension
  const extensionCost = hourlyExtension || 0;
  
  // Calculate subtotal for host earning (excluding security deposit)
  const hostSubtotal = baseAmount + hostFees + extensionCost - discountAmount;
  
  // Calculate total subtotal (including security deposit for customer payment)
  const totalSubtotal = hostSubtotal + securityDeposit;
  
  // Calculate TripMe service fee (on host subtotal only, not security deposit)
  const platformFee = toTwoDecimals(hostSubtotal * platformFeeRate);
  
  // Calculate GST (configurable, on total subtotal including security deposit)
  const gst = toTwoDecimals(totalSubtotal * gstRate);
  
  // Calculate processing fee (configurable rate + fixed on total subtotal)
  const processingFee = toTwoDecimals(totalSubtotal * processingFeeRate + processingFeeFixed);
  
  // Calculate total amount (what customer pays)
  const totalAmount = toTwoDecimals(totalSubtotal + platformFee + gst + processingFee);
  
  // Calculate host earning (host subtotal minus TripMe service fee - security deposit is held separately)
  const hostEarning = toTwoDecimals(hostSubtotal - platformFee);
  
  // Calculate platform revenue (TripMe service fee + processing fee)
  const platformRevenue = toTwoDecimals(platformFee + processingFee);

  return {
    // Base pricing
    baseAmount: toTwoDecimals(baseAmount),
    nights,
    extraGuests,
    extraGuestCost: toTwoDecimals(extraGuestPrice * extraGuests * nights),
    
    // Host-set fees
    cleaningFee: toTwoDecimals(cleaningFee),
    serviceFee: toTwoDecimals(serviceFee),
    securityDeposit: toTwoDecimals(securityDeposit),
    hostFees: toTwoDecimals(hostFees),
    
    // Extensions and discounts
    hourlyExtension: toTwoDecimals(extensionCost),
    discountAmount: toTwoDecimals(discountAmount),
    
    // Subtotal (before platform fee and taxes)
    subtotal: toTwoDecimals(totalSubtotal),
    hostSubtotal: toTwoDecimals(hostSubtotal),
    
    // TripMe service fees
    platformFee: toTwoDecimals(platformFee),
    processingFee: toTwoDecimals(processingFee),
    platformRevenue: toTwoDecimals(platformRevenue),
    
    // Taxes
    gst: toTwoDecimals(gst),
    
    // Final amounts
    totalAmount: toTwoDecimals(totalAmount),
    hostEarning: toTwoDecimals(hostEarning),
    
    // Currency
    currency,
    
    // Rate used for calculation
    platformFeeRate: platformFeeRate,
    
    // Breakdown for display
    breakdown: {
      // What customer sees
      customerBreakdown: {
        baseAmount: toTwoDecimals(baseAmount),
        cleaningFee: toTwoDecimals(cleaningFee),
        serviceFee: toTwoDecimals(serviceFee),
        securityDeposit: toTwoDecimals(securityDeposit),
        hourlyExtension: toTwoDecimals(extensionCost),
        discountAmount: toTwoDecimals(discountAmount),
        subtotal: toTwoDecimals(totalSubtotal),
        platformFee: toTwoDecimals(platformFee),
        gst: toTwoDecimals(gst),
        processingFee: toTwoDecimals(processingFee),
        totalAmount: toTwoDecimals(totalAmount)
      },
      
      // What host sees
      hostBreakdown: {
        baseAmount: toTwoDecimals(baseAmount),
        cleaningFee: toTwoDecimals(cleaningFee),
        serviceFee: toTwoDecimals(serviceFee),
        securityDeposit: toTwoDecimals(securityDeposit),
        hourlyExtension: toTwoDecimals(extensionCost),
        discountAmount: toTwoDecimals(discountAmount),
        subtotal: toTwoDecimals(hostSubtotal),
        platformFee: toTwoDecimals(platformFee),
        hostEarning: toTwoDecimals(hostEarning)
      },
      
      // What TripMe sees
      platformBreakdown: {
        platformFee: toTwoDecimals(platformFee),
        processingFee: toTwoDecimals(processingFee),
        gst: toTwoDecimals(gst),
        platformRevenue: toTwoDecimals(platformRevenue)
      }
    }
  };
}

/**
 * Calculate hourly extension cost using shared rates
 * @param {number} basePrice - Daily base price
 * @param {number} hours - Extension hours (6, 12, or 18)
 * @returns {number} Extension cost
 */
function calculateHourlyExtension(basePrice, hours) {
  const HOURLY_RATES = {
    6: 0.30,   // 30% of daily rate
    12: 0.60,  // 60% of daily rate
    18: 0.75   // 75% of daily rate
  };
  
  const rate = HOURLY_RATES[hours] || 0;
  return toTwoDecimals(basePrice * rate);
}

/**
 * Validate pricing calculation consistency
 * @param {Object} frontendPricing - Frontend calculation result
 * @param {Object} backendPricing - Backend calculation result
 * @returns {Object} Validation result
 */
function validatePricingConsistency(frontendPricing, backendPricing) {
  const errors = [];
  const tolerance = 0.01; // 1 paisa tolerance
  
  // Check key values
  const checks = [
    { name: 'subtotal', frontend: frontendPricing.subtotal, backend: backendPricing.subtotal },
    { name: 'platformFee', frontend: frontendPricing.platformFee, backend: backendPricing.platformFee },
    { name: 'gst', frontend: frontendPricing.gst, backend: backendPricing.gst },
    { name: 'processingFee', frontend: frontendPricing.processingFee, backend: backendPricing.processingFee },
    { name: 'totalAmount', frontend: frontendPricing.totalAmount, backend: backendPricing.totalAmount }
  ];
  
  for (const check of checks) {
    const difference = Math.abs(check.frontend - check.backend);
    if (difference > tolerance) {
      errors.push({
        field: check.name,
        frontend: check.frontend,
        backend: check.backend,
        difference: difference
      });
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    tolerance
  };
}

/**
 * Calculate total hours including extensions
 * @param {number} baseHours - Base hours (default: 24)
 * @param {number} extensionHours - Extension hours (6, 12, or 18)
 * @returns {number} Total hours
 */
function calculateTotalHours(baseHours = 24, extensionHours = 0) {
  return baseHours + extensionHours;
}

/**
 * Calculate checkout time based on check-in and total hours
 * @param {Date} checkInDateTime - Check-in date and time
 * @param {number} totalHours - Total booking hours
 * @returns {Date} Checkout date and time
 */
function calculateCheckoutTime(checkInDateTime, totalHours) {
  const checkoutTime = new Date(checkInDateTime);
  checkoutTime.setHours(checkoutTime.getHours() + totalHours);
  return checkoutTime;
}

/**
 * Calculate next available time (checkout + buffer time)
 * @param {Date} checkOutDateTime - Checkout date and time
 * @param {number} bufferHours - Buffer hours for property preparation
 * @returns {Date} Next available time
 */
function calculateNextAvailableTime(checkOutDateTime, bufferHours = 2) {
  const nextAvailable = new Date(checkOutDateTime);
  nextAvailable.setHours(nextAvailable.getHours() + bufferHours);
  return nextAvailable;
}

/**
 * Validate 24-hour booking parameters
 * @param {Object} params - Booking parameters
 * @returns {Object} Validation result
 */
function validate24HourBooking(params) {
  const errors = [];
  const { checkInDateTime, totalHours, minHours = 24, maxHours = 168 } = params;
  
  if (!checkInDateTime) {
    errors.push('Check-in date and time is required');
  } else {
    const checkIn = new Date(checkInDateTime);
    const now = new Date();
    
    // Allow up to 1 hour in the past to account for payment processing delays.
    // e.g., user selects check-in time on room page, then completes payment a few minutes later.
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    if (checkIn < oneHourAgo) {
      errors.push('Check-in time cannot be more than 1 hour in the past');
    }
  }
  
  if (totalHours < minHours) {
    errors.push(`Minimum booking duration is ${minHours} hours`);
  }
  
  if (totalHours > maxHours) {
    errors.push(`Maximum booking duration is ${maxHours} hours`);
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

module.exports = {
  toTwoDecimals,
  getCurrentPlatformFeeRate,
  calculatePricingBreakdown,
  calculate24HourPricing,
  calculateHourlyExtension,
  calculateTotalHours,
  calculateCheckoutTime,
  calculateNextAvailableTime,
  validate24HourBooking,
  validatePricingConsistency
};




