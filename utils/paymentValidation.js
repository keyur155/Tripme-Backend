/**
 * Comprehensive Payment Validation System
 * Ensures consistency across all payment calculations
 */

const { calculatePricingBreakdown } = require('../config/pricing.config');

/**
 * Validate payment amount consistency
 * NEW BUSINESS MODEL:
 * - Customer pays: subtotal + GST + processingFee (NO platformFee)
 * - Host receives: FULL subtotal
 * - Platform earns: ONLY processingFee
 * @param {Object} payment - Payment record
 * @param {Object} booking - Booking record
 * @returns {Object} Validation result
 */
function validatePaymentConsistency(payment, booking) {
  const errors = [];
  const warnings = [];
  
  // NEW FORMULA: Customer pays subtotal + GST + processingFee (NO platformFee)
  const expectedAmount = booking.subtotal + 
                        booking.gst + 
                        booking.processingFee - 
                        (booking.discountAmount || 0);
  
  // Check if payment amount matches expected amount
  const amountDifference = Math.abs(payment.amount - expectedAmount);
  if (amountDifference > 1) { // Allow for ₹1 rounding differences
    errors.push(`Payment amount mismatch: Expected ${expectedAmount}, Got ${payment.amount}, Difference: ${amountDifference}`);
  }
  
  // Validate subtotal consistency
  if (Math.abs(payment.subtotal - booking.subtotal) > 0.01) {
    errors.push(`Subtotal mismatch: Payment ${payment.subtotal} vs Booking ${booking.subtotal}`);
  }
  
  // Validate GST consistency
  if (Math.abs(payment.taxes - booking.gst) > 0.01) {
    errors.push(`GST mismatch: Payment ${payment.taxes} vs Booking ${booking.gst}`);
  }
  
  // Validate processing fee consistency
  if (Math.abs(payment.processingFee - booking.processingFee) > 0.01) {
    errors.push(`Processing fee mismatch: Payment ${payment.processingFee} vs Booking ${booking.processingFee}`);
  }
  
  // NEW: Validate platformFee is 0 (deprecated)
  if (payment.commission && payment.commission.platformFee > 0) {
    warnings.push(`DEPRECATED: platformFee should be 0, found ${payment.commission.platformFee}`);
  }
  
  // NEW: Validate hostEarning equals subtotal
  if (payment.commission && Math.abs(payment.commission.hostEarning - booking.subtotal) > 0.01) {
    errors.push(`Host earning mismatch: Expected ${booking.subtotal} (full subtotal), Got ${payment.commission.hostEarning}`);
  }
  
  // NEW: Validate payout.amount equals subtotal
  if (payment.payout && Math.abs(payment.payout.amount - booking.subtotal) > 0.01) {
    errors.push(`Payout amount mismatch: Expected ${booking.subtotal} (full subtotal), Got ${payment.payout.amount}`);
  }
  
  // Validate discount consistency
  if (Math.abs((payment.discountAmount || 0) - (booking.discountAmount || 0)) > 0.01) {
    errors.push(`Discount mismatch: Payment ${payment.discountAmount || 0} vs Booking ${booking.discountAmount || 0}`);
  }
  
  // NEW FORMULA: Payment calculation without platformFee
  const paymentCalculation = (payment.subtotal || 0) + 
                           (payment.taxes || 0) + 
                           (payment.processingFee || 0) - 
                           (payment.discountAmount || 0);
  
  if (Math.abs(payment.amount - paymentCalculation) > 1) {
    errors.push(`Payment amount calculation error: Expected ${paymentCalculation}, Got ${payment.amount}`);
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    expectedAmount,
    actualAmount: payment.amount,
    difference: amountDifference
  };
}

/**
 * Validate booking pricing consistency
 * @param {Object} booking - Booking record
 * @returns {Object} Validation result
 */
async function validateBookingPricing(booking) {
  const errors = [];
  const warnings = [];
  
  // Recalculate pricing using the same logic as booking creation
  const pricingParams = {
    basePrice: booking.listing?.pricing?.basePrice || booking.service?.pricing?.basePrice || 0,
    nights: booking.bookingDuration === 'daily' ? 
      Math.ceil((new Date(booking.checkOut) - new Date(booking.checkIn)) / (1000 * 60 * 60 * 24)) : 1,
    cleaningFee: booking.cleaningFee || 0,
    serviceFee: booking.serviceFee || 0,
    securityDeposit: booking.securityDeposit || 0,
    extraGuestPrice: booking.listing?.pricing?.extraGuestPrice || booking.service?.pricing?.extraGuestPrice || 0,
    extraGuests: booking.guests?.adults > 1 ? booking.guests.adults - 1 : 0,
    hourlyExtension: booking.hourlyExtension?.cost || 0,
    discountAmount: booking.discountAmount || 0,
    currency: booking.currency || 'INR'
  };
  
  const calculatedPricing = await calculatePricingBreakdown(pricingParams);
  
  // Validate subtotal
  if (Math.abs(booking.subtotal - calculatedPricing.subtotal) > 0.01) {
    errors.push(`Subtotal mismatch: Expected ${calculatedPricing.subtotal}, Got ${booking.subtotal}`);
  }
  
  // NEW: platformFee should be 0 (deprecated)
  if (booking.platformFee > 0) {
    warnings.push(`DEPRECATED: platformFee should be 0, found ${booking.platformFee}`);
  }
  
  // Validate GST
  if (Math.abs(booking.gst - calculatedPricing.gst) > 0.01) {
    errors.push(`GST mismatch: Expected ${calculatedPricing.gst}, Got ${booking.gst}`);
  }
  
  // Validate processing fee
  if (Math.abs(booking.processingFee - calculatedPricing.processingFee) > 0.01) {
    errors.push(`Processing fee mismatch: Expected ${calculatedPricing.processingFee}, Got ${booking.processingFee}`);
  }
  
  // Validate total amount
  if (Math.abs(booking.totalAmount - calculatedPricing.totalAmount) > 0.01) {
    errors.push(`Total amount mismatch: Expected ${calculatedPricing.totalAmount}, Got ${booking.totalAmount}`);
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    calculatedPricing,
    bookingPricing: {
      subtotal: booking.subtotal,
      platformFee: 0, // DEPRECATED
      gst: booking.gst,
      processingFee: booking.processingFee,
      totalAmount: booking.totalAmount,
      hostEarning: booking.subtotal // Host receives FULL subtotal
    }
  };
}

/**
 * Validate coupon discount calculation
 * @param {Object} coupon - Coupon record
 * @param {number} subtotal - Subtotal amount
 * @param {number} appliedDiscount - Applied discount amount
 * @returns {Object} Validation result
 */
function validateCouponDiscount(coupon, subtotal, appliedDiscount) {
  const errors = [];
  const warnings = [];
  
  let expectedDiscount = 0;
  
  if (coupon.discountType === 'percentage') {
    expectedDiscount = (subtotal * coupon.amount) / 100;
    const maxDiscount = coupon.maxDiscount || expectedDiscount;
    expectedDiscount = Math.min(expectedDiscount, maxDiscount);
  } else {
    expectedDiscount = coupon.amount;
  }
  
  const discountDifference = Math.abs(appliedDiscount - expectedDiscount);
  if (discountDifference > 0.01) {
    errors.push(`Coupon discount mismatch: Expected ${expectedDiscount}, Got ${appliedDiscount}`);
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    expectedDiscount,
    appliedDiscount,
    difference: discountDifference
  };
}

/**
 * Comprehensive payment system validation
 * @param {Object} payment - Payment record
 * @param {Object} booking - Booking record
 * @param {Object} coupon - Coupon record (optional)
 * @returns {Object} Complete validation result
 */
async function validatePaymentSystem(payment, booking, coupon = null) {
  const results = {
    paymentConsistency: validatePaymentConsistency(payment, booking),
    bookingPricing: await validateBookingPricing(booking),
    couponValidation: coupon ? validateCouponDiscount(coupon, booking.subtotal, booking.discountAmount || 0) : null,
    overallValid: true,
    criticalIssues: [],
    warnings: []
  };
  
  // Collect all errors
  results.criticalIssues = [
    ...results.paymentConsistency.errors,
    ...results.bookingPricing.errors,
    ...(results.couponValidation?.errors || [])
  ];
  
  // Collect all warnings
  results.warnings = [
    ...results.paymentConsistency.warnings,
    ...results.bookingPricing.warnings,
    ...(results.couponValidation?.warnings || [])
  ];
  
  // Determine overall validity
  results.overallValid = results.criticalIssues.length === 0;
  
  return results;
}

/**
 * Fix payment amount if it's incorrect
 * NEW BUSINESS MODEL: platformFee=0, hostEarning=subtotal
 * @param {Object} payment - Payment record to fix
 * @param {Object} booking - Booking record
 * @returns {Object} Fixed payment data
 */
function fixPaymentAmount(payment, booking) {
  // NEW FORMULA: No platformFee in customer total
  const correctAmount = booking.subtotal + 
                       booking.gst + 
                       booking.processingFee - 
                       (booking.discountAmount || 0);
  
  return {
    amount: correctAmount,
    subtotal: booking.subtotal,
    taxes: booking.gst,
    gst: booking.gst,
    processingFee: booking.processingFee,
    serviceFee: booking.serviceFee || 0,
    cleaningFee: booking.cleaningFee || 0,
    securityDeposit: booking.securityDeposit || 0,
    discountAmount: booking.discountAmount || 0,
    commission: {
      platformFee: 0, // DEPRECATED: No longer charged
      hostEarning: booking.subtotal, // Host receives FULL subtotal
      processingFee: booking.processingFee
    },
    payout: {
      amount: booking.subtotal // Host receives FULL subtotal
    }
  };
}

module.exports = {
  validatePaymentConsistency,
  validateBookingPricing,
  validateCouponDiscount,
  validatePaymentSystem,
  fixPaymentAmount
};
