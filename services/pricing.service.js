/**
 * CENTRALIZED PRICING ENGINE - Single Source of Truth
 * 
 * ALL pricing calculations flow through this service.
 * Frontend NEVER calculates final payable amounts independently.
 * 
 * Pricing Order:
 * 1. Base property amount (basePrice × nights)
 * 2. Extra guest charges
 * 3. Host fees (cleaning, service, security deposit)
 * 4. Hourly extensions
 * 5. Addon services total + per-service GST
 * 6. Apply discount/coupon (before GST)
 * 7. Property GST calculation
 * 8. Processing/platform fees
 * 9. Final total
 */

const { toTwoDecimals, getCurrentPlatformFeeRate } = require('../utils/pricingUtils');
const PricingConfig = require('../models/PricingConfig');
const Service = require('../models/Service');

// Default GST rates by service type
const SERVICE_GST_RATES = {
  'transport': 0.05,       // 5% GST
  'transportation': 0.05,  // 5% GST
  'chef': 0.05,            // 5% GST (food services)
  'cleaning': 0.18,        // 18% GST
  'photographer': 0.18,    // 18% GST
  'tour-guide': 0.18,      // 18% GST
  'fitness': 0.18,         // 18% GST
  'yoga-teacher': 0.18,    // 18% GST
  'hairdresser': 0.18,     // 18% GST
  'music': 0.18,           // 18% GST
  'art': 0.18,             // 18% GST
  'other': 0.18,           // 18% GST (default)
};

/**
 * Get current fee configuration from DB
 */
async function getCurrentFeeConfig() {
  try {
    const config = await PricingConfig.findOne().sort({ updatedAt: -1 }).lean();
    if (config) {
      return {
        platformFeeRate: config.platformFeeRate ?? 0,
        gstRate: config.gstRate ?? 0.18,
        processingFeeRate: config.processingFeeRate ?? 0,
        processingFeeFixed: config.processingFeeFixed ?? 10,
      };
    }
  } catch (e) {
    // fallback
  }
  return {
    platformFeeRate: 0,
    gstRate: 0.18,
    processingFeeRate: 0,
    processingFeeFixed: 10,
  };
}

/**
 * Calculate addon service pricing with per-service GST
 * @param {Array} requestedAddons - [{serviceId, quantity, selectedSlot?}]
 * @param {Object} bookingContext - {checkIn, checkOut, guests, nights}
 * @param {Object} session - MongoDB session for transaction
 * @returns {Object} {validatedAddons, addonSubtotal, addonGST, addonTotal, addonBreakdown}
 */
async function calculateAddonServicePricing(requestedAddons, bookingContext, session = null) {
  if (!requestedAddons || !Array.isArray(requestedAddons) || requestedAddons.length === 0) {
    return {
      validatedAddons: [],
      addonSubtotal: 0,
      addonGST: 0,
      addonTotal: 0,
      addonBreakdown: []
    };
  }

  const addonServiceIds = requestedAddons.map(s => s.serviceId);
  const query = Service.find({
    _id: { $in: addonServiceIds },
    status: 'published',
    isPublished: true
  });
  if (session) query.session(session);
  const addonServiceDocs = await query.lean();

  // Validate all services exist
  if (addonServiceDocs.length !== addonServiceIds.length) {
    const foundIds = new Set(addonServiceDocs.map(s => s._id.toString()));
    const missing = addonServiceIds.filter(id => !foundIds.has(id));
    const err = new Error(`Some addon services are no longer available: ${missing.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const nights = bookingContext.nights || 1;
  const totalGuests = (bookingContext.guests?.adults || 1) + (bookingContext.guests?.children || 0);

  const validatedAddons = [];
  const addonBreakdown = [];
  let addonSubtotal = 0;
  let addonGST = 0;

  for (const requested of requestedAddons) {
    const serviceDoc = addonServiceDocs.find(s => s._id.toString() === requested.serviceId);
    const quantity = requested.quantity || 1;
    const basePrice = serviceDoc.pricing?.basePrice || 0;
    const perPersonPrice = serviceDoc.pricing?.perPersonPrice || 0;
    const includedGuests = serviceDoc.pricing?.includedGuests || 1;
    const durationUnit = serviceDoc.duration?.unit || 'hours';

    let unitPrice, pricingType, pricingLabel;

    if (durationUnit === 'days' || durationUnit === 'day') {
      unitPrice = basePrice * nights;
      pricingType = 'per-day';
      pricingLabel = `₹${basePrice}/day × ${nights} nights`;
    } else if (perPersonPrice > 0 && totalGuests > includedGuests) {
      const extraGuests = totalGuests - includedGuests;
      unitPrice = basePrice + (perPersonPrice * extraGuests);
      pricingType = 'per-guest';
      pricingLabel = `₹${basePrice} + ₹${perPersonPrice} × ${extraGuests} extra guests`;
    } else {
      unitPrice = basePrice;
      pricingType = 'fixed';
      pricingLabel = `₹${basePrice} fixed`;
    }

    const lineTotal = toTwoDecimals(unitPrice * quantity);

    // Per-service GST
    const serviceGSTRate = serviceDoc.pricing?.gstRate
      || SERVICE_GST_RATES[serviceDoc.serviceType]
      || SERVICE_GST_RATES['other'];
    const serviceTaxable = serviceDoc.pricing?.taxable !== false; // default true
    const serviceGST = serviceTaxable ? toTwoDecimals(lineTotal * serviceGSTRate) : 0;

    addonSubtotal += lineTotal;
    addonGST += serviceGST;

    const addonEntry = {
      service: serviceDoc._id,
      title: serviceDoc.title,
      serviceType: serviceDoc.serviceType,
      quantity,
      unitPrice: toTwoDecimals(unitPrice),
      lineTotal,
      pricingType,
      pricingLabel,
      gstRate: serviceGSTRate,
      gstAmount: serviceGST,
      totalWithGST: toTwoDecimals(lineTotal + serviceGST),
      selectedSlot: requested.selectedSlot || null,
      status: 'pending'
    };

    validatedAddons.push(addonEntry);
    addonBreakdown.push({
      serviceId: serviceDoc._id.toString(),
      title: serviceDoc.title,
      serviceType: serviceDoc.serviceType,
      quantity,
      unitPrice: toTwoDecimals(unitPrice),
      lineTotal,
      gstRate: serviceGSTRate,
      gstAmount: serviceGST,
      totalWithGST: toTwoDecimals(lineTotal + serviceGST)
    });
  }

  return {
    validatedAddons,
    addonSubtotal: toTwoDecimals(addonSubtotal),
    addonGST: toTwoDecimals(addonGST),
    addonTotal: toTwoDecimals(addonSubtotal + addonGST),
    addonBreakdown
  };
}

/**
 * MASTER pricing calculation - includes property + addons + discount + GST
 * This is the SINGLE SOURCE OF TRUTH for all pricing.
 *
 * @param {Object} params
 * @param {number} params.basePrice - Property base price per night
 * @param {number} params.nights - Number of nights
 * @param {number} params.cleaningFee
 * @param {number} params.serviceFee
 * @param {number} params.securityDeposit
 * @param {number} params.extraGuestPrice
 * @param {number} params.extraGuests
 * @param {number} params.hourlyExtension
 * @param {number} params.discountAmount
 * @param {Array}  params.addonServices - [{serviceId, quantity, selectedSlot}]
 * @param {Object} params.bookingContext - {checkIn, checkOut, guests, nights}
 * @param {Object} session - MongoDB session
 * @returns {Object} Complete pricing breakdown
 */
async function calculateFullBookingPrice(params, session = null) {
  const {
    basePrice = 0,
    nights = 1,
    cleaningFee = 0,
    serviceFee = 0,
    securityDeposit = 0,
    extraGuestPrice = 0,
    extraGuests = 0,
    hourlyExtension = 0,
    discountAmount = 0,
    currency = 'INR',
    addonServices = [],
    bookingContext = {}
  } = params;

  const feeConfig = await getCurrentFeeConfig();

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Property base amount
  // ═══════════════════════════════════════════════════════════════════════════
  const propertyBaseAmount = toTwoDecimals(basePrice * nights);
  const extraGuestCost = extraGuests > 0
    ? toTwoDecimals(extraGuestPrice * extraGuests * nights)
    : 0;
  const hostFees = toTwoDecimals(cleaningFee + serviceFee);
  const extensionCost = toTwoDecimals(hourlyExtension || 0);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: Property subtotal BEFORE discount
  // ═══════════════════════════════════════════════════════════════════════════
  const propertySubtotalBeforeDiscount = toTwoDecimals(
    propertyBaseAmount + extraGuestCost + hostFees + extensionCost
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: Apply discount (BEFORE GST, BEFORE addons)
  // ═══════════════════════════════════════════════════════════════════════════
  const effectiveDiscount = toTwoDecimals(Math.min(discountAmount, propertySubtotalBeforeDiscount));
  const propertySubtotalAfterDiscount = toTwoDecimals(propertySubtotalBeforeDiscount - effectiveDiscount);

  // Add security deposit (separate, not discountable)
  const propertySubtotalWithDeposit = toTwoDecimals(propertySubtotalAfterDiscount + securityDeposit);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: Property GST (on subtotal after discount)
  // ═══════════════════════════════════════════════════════════════════════════
  const propertyGST = toTwoDecimals(propertySubtotalWithDeposit * feeConfig.gstRate);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5: Processing fee (platform revenue)
  // ═══════════════════════════════════════════════════════════════════════════
  const processingFee = toTwoDecimals(
    propertySubtotalWithDeposit * feeConfig.processingFeeRate + feeConfig.processingFeeFixed
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 6: Property total (before addons)
  // ═══════════════════════════════════════════════════════════════════════════
  const propertyTotal = toTwoDecimals(propertySubtotalWithDeposit + propertyGST + processingFee);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 7: Addon services (with per-service GST)
  // ═══════════════════════════════════════════════════════════════════════════
  const addonPricing = await calculateAddonServicePricing(
    addonServices,
    { ...bookingContext, nights },
    session
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 8: Grand total
  // ═══════════════════════════════════════════════════════════════════════════
  const totalGST = toTwoDecimals(propertyGST + addonPricing.addonGST);
  const grandTotal = toTwoDecimals(propertyTotal + addonPricing.addonTotal);

  // Host earning = property subtotal after discount (no fees deducted)
  const hostEarning = toTwoDecimals(propertySubtotalAfterDiscount);

  return {
    // === Property pricing ===
    propertyAmount: propertyBaseAmount,
    extraGuestCost,
    cleaningFee: toTwoDecimals(cleaningFee),
    serviceFee: toTwoDecimals(serviceFee),
    securityDeposit: toTwoDecimals(securityDeposit),
    hourlyExtension: extensionCost,
    hostFees,
    propertySubtotalBeforeDiscount,
    discountAmount: effectiveDiscount,
    propertySubtotalAfterDiscount,
    propertySubtotalWithDeposit,

    // === Taxes & fees ===
    propertyGST,
    gstRate: feeConfig.gstRate,
    processingFee,
    platformFee: 0, // DEPRECATED

    // === Property total ===
    propertyTotal,

    // === Addon services ===
    addonServices: addonPricing.validatedAddons,
    addonSubtotal: addonPricing.addonSubtotal,
    addonGST: addonPricing.addonGST,
    addonTotal: addonPricing.addonTotal,
    addonBreakdown: addonPricing.addonBreakdown,

    // === Grand totals ===
    totalGST,
    grandTotal,

    // === Host ===
    hostEarning,

    // === Legacy compat ===
    subtotal: propertySubtotalWithDeposit,
    gst: propertyGST,
    totalAmount: grandTotal, // SINGLE source of truth
    nights,
    currency,

    // === Full breakdown for DB storage ===
    breakdown: {
      customerBreakdown: {
        baseAmount: propertyBaseAmount,
        extraGuestCost,
        cleaningFee: toTwoDecimals(cleaningFee),
        serviceFee: toTwoDecimals(serviceFee),
        securityDeposit: toTwoDecimals(securityDeposit),
        hourlyExtension: extensionCost,
        discountAmount: effectiveDiscount,
        subtotal: propertySubtotalWithDeposit,
        platformFee: 0,
        propertyGST,
        processingFee,
        propertyTotal,
        addonSubtotal: addonPricing.addonSubtotal,
        addonGST: addonPricing.addonGST,
        addonTotal: addonPricing.addonTotal,
        totalGST,
        gst: totalGST, // backward compat
        addonServicesTotal: addonPricing.addonTotal,
        totalAmount: grandTotal
      },
      hostBreakdown: {
        baseAmount: propertyBaseAmount,
        cleaningFee: toTwoDecimals(cleaningFee),
        serviceFee: toTwoDecimals(serviceFee),
        securityDeposit: toTwoDecimals(securityDeposit),
        hourlyExtension: extensionCost,
        discountAmount: effectiveDiscount,
        subtotal: propertySubtotalAfterDiscount,
        platformFee: 0,
        hostEarning
      },
      platformBreakdown: {
        platformFee: 0,
        processingFee,
        propertyGST,
        addonGST: addonPricing.addonGST,
        totalGST,
        gst: totalGST,
        platformRevenue: processingFee
      }
    }
  };
}

module.exports = {
  calculateFullBookingPrice,
  calculateAddonServicePricing,
  getCurrentFeeConfig,
  SERVICE_GST_RATES
};
