const Property = require('../models/Property');
const PricingConfig = require('../models/PricingConfig');
const Coupon = require('../models/Coupon');
const { calculate24HourPricing, calculatePricingBreakdown, calculateHourlyExtension } = require('../utils/pricingUtils');
const { generatePricingToken } = require('../middlewares/pricingSecurity.middleware');
const { calculateFullBookingPrice } = require('../services/pricing.service');

// @desc    Get platform fee rate
// @route   GET /api/pricing/platform-fee-rate
// @access  Public
const getPlatformFeeRate = async (req, res) => {
  try {
    // Get the latest pricing configuration
    const pricingConfig = await PricingConfig.findOne().sort({ createdAt: -1 });

    if (!pricingConfig) {
      return res.status(404).json({
        success: false,
        message: 'Pricing configuration not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        rate: pricingConfig.platformFeeRate,
        ratePercentage: `${(pricingConfig.platformFeeRate * 100).toFixed(1)}%`,
        gstRate: pricingConfig.gstRate || 0.18
      }
    });
  } catch (error) {
    console.error('Error fetching platform fee rate:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching platform fee rate',
      error: error.message
    });
  }
};

// @desc    Calculate pricing for a booking (consolidated with secure flow features)
// @route   POST /api/pricing/calculate
// @access  Public
const calculatePricing = async (req, res) => {
  try {
    const {
      propertyId,
      checkIn,
      checkOut,
      guests = { adults: 1, children: 0 },
      hourlyExtension = 0, // hours: 6, 12, 18 for daily flow
      couponCode,
      bookingType = 'daily',
      checkInDateTime,
      extensionHours = 0,
      checkInTime,         // HH:mm string e.g. "16:00" — used to compute isLateCheckIn server-side
      isLateCheckIn: isLateCheckInFromClient = false  // Client hint; we verify with checkInTime too
    } = req.body;

    // Compute isLateCheckIn server-side from checkInTime when provided (>= 16:00 = 4 PM)
    // This prevents the frontend needing to know about property config in advance.
    let isLateCheckIn = isLateCheckInFromClient;
    if (checkInTime && !isLateCheckIn) {
      const [h, m] = checkInTime.split(':').map(Number);
      const totalMinutes = (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
      isLateCheckIn = totalMinutes >= 16 * 60; // >= 4:00 PM
    }

    // Validate required fields and basic correctness (from secure flow)
    const errors = [];
    if (!propertyId) errors.push('Property ID is required');
    if (!checkIn) errors.push('Check-in date is required');
    if (!checkOut) errors.push('Check-out date is required');
    if (!guests || !guests.adults) errors.push('Guest count is required');

    if (checkIn && checkOut) {
      const inDate = new Date(checkIn);
      const outDate = new Date(checkOut);
      const now = new Date();
      if (isNaN(inDate.getTime())) errors.push('Invalid check-in date format');
      if (isNaN(outDate.getTime())) errors.push('Invalid check-out date format');
      // Normalize to date-only for comparisons so same-day check-in is allowed
      const inDateOnly = new Date(inDate.getFullYear(), inDate.getMonth(), inDate.getDate());
      const outDateOnly = new Date(outDate.getFullYear(), outDate.getMonth(), outDate.getDate());
      const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (inDateOnly < todayOnly) errors.push('Check-in date cannot be in the past');
      if (outDateOnly <= inDateOnly) errors.push('Check-out date must be after check-in date');
      const maxDuration = 365 * 24 * 60 * 60 * 1000;
      if (outDateOnly - inDateOnly > maxDuration) errors.push('Booking duration cannot exceed 1 year');
    }

    if (hourlyExtension) {
      const validHours = [6, 12, 18];
      if (!validHours.includes(hourlyExtension)) errors.push('Hourly extension must be 6, 12, or 18 hours');
    }
    if (extensionHours && (extensionHours < 0 || extensionHours > 24)) {
      errors.push('Extension hours must be between 0 and 24');
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid pricing request parameters',
        errors
      });
    }

    // Get and validate property details (from secure flow)
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    if (property.status && !['published', 'active'].includes(property.status)) {
      return res.status(403).json({
        success: false,
        message: 'Property is not available for booking'
      });
    }
    if (property.approvalStatus && property.approvalStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        message: 'Property is not approved for booking'
      });
    }

    // Try to read pricing configuration, but do not fail if missing (fallbacks exist)
    let pricingConfig = null;
    try {
      pricingConfig = await PricingConfig.findOne().sort({ createdAt: -1 });
    } catch (e) {
      console.warn('⚠️ Unable to fetch PricingConfig, proceeding with defaults');
    }

    // Calculate nights using date-only comparison (align with secure flow)
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    const checkInDateOnly = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate());
    const checkOutDateOnly = new Date(checkOutDate.getFullYear(), checkOutDate.getMonth(), checkOutDate.getDate());
    const diffTime = checkOutDateOnly - checkInDateOnly;
    const diffDays = diffTime / (1000 * 60 * 60 * 24);
    const nights = Math.max(0, diffDays);
    // Treat as 24-hour ONLY when explicitly requested by bookingType
    const is24HourBooking = bookingType === '24hour';
    const totalHours = is24HourBooking ? (24 + (extensionHours || 0)) : undefined;

    // Determine base price
    // - For non-shared properties: ALWAYS use regular basePrice (no surcharge, anytime check-in is built-in)
    // - For shared properties: use basePrice24Hour when 24-hour booking or late check-in
    // - Regular daily → use standard basePrice
    const has24HourPrice = property.pricing?.basePrice24Hour > 0;
    const use24HourFlow = property.enable24HourBooking || has24HourPrice;
    const isSharedProperty = property.placeType === 'shared';

    let basePrice;
    if (!isSharedProperty) {
      // Non-shared: always use regular basePrice (no extra anytime charge)
      basePrice = property.pricing?.basePrice || 0;
    } else if ((is24HourBooking || isLateCheckIn) && use24HourFlow) {
      // Shared: use basePrice24Hour when explicitly set, otherwise fall back to regular basePrice
      basePrice = has24HourPrice
        ? property.pricing.basePrice24Hour
        : property.pricing?.basePrice || 0;
    } else {
      basePrice = property.pricing?.basePrice || 0;
    }

    // Calculate extra guest cost
    const includedGuests = property.pricing?.includedGuests || 1;
    const extraGuestsCount = Math.max(0, guests.adults - includedGuests);
    const extraGuestCost = extraGuestsCount * (property.pricing?.extraGuestPrice || 0);

    // Build pricing parameters, including extension costs like secure/route logic
    let pricingParams = {
      basePrice,
      nights,
      cleaningFee: property.pricing?.cleaningFee || 0,
      serviceFee: property.pricing?.serviceFee || 0,
      securityDeposit: property.pricing?.securityDeposit || 0,
      extraGuestPrice: property.pricing?.extraGuestPrice || 0,
      extraGuests: extraGuestsCount,
      hourlyExtension: 0, // cost, not hours
      discountAmount: 0,
      currency: property.pricing?.currency || 'INR',
      bookingType: is24HourBooking ? '24hour' : 'daily'
    };

    if (is24HourBooking) {
      // 24-hour pricing with optional extensionHours cost baked into baseAmount
      pricingParams.basePrice24Hour = property.pricing?.basePrice24Hour || basePrice;
      pricingParams.totalHours = 24 + (extensionHours || 0);
      // Note: calculate24HourPricing adds extension when totalHours > 24; pricingParams.hourlyExtension remains 0 here
    } else {
      // Daily flow: compute hourly extension cost if applicable
      if (hourlyExtension && hourlyExtension > 0 && property.hourlyBooking?.enabled) {
        const extensionCost = calculateHourlyExtension(property.pricing?.basePrice || basePrice, hourlyExtension);
        pricingParams.hourlyExtension = extensionCost;
      }
    }

    // Calculate pricing breakdown via shared utilities (single source)
    const pricingBreakdown = await calculatePricingBreakdown(pricingParams);

    // Apply coupon discount if provided
    let discountAmount = 0;
    if (couponCode) {
      try {
        const coupon = await Coupon.findOne({
          code: couponCode.toUpperCase(),
          isActive: true,
          validFrom: { $lte: new Date() },
          validTo: { $gte: new Date() }
        });

        if (coupon) {
          if (coupon.discountType === 'percentage') {
            discountAmount = (pricingBreakdown.hostSubtotal * coupon.amount) / 100;
            const maxDiscount = coupon.maxDiscount || discountAmount;
            discountAmount = Math.min(discountAmount, maxDiscount);
          } else {
            discountAmount = Math.min(coupon.amount, pricingBreakdown.hostSubtotal);
          }

          // Recalculate pricing with discount
          const discountedParams = { ...pricingParams, discountAmount };
          const discountedPricing = await calculatePricingBreakdown(discountedParams);
          // overwrite with discounted values
          Object.assign(pricingBreakdown, discountedPricing);
        }
      } catch (e) {
        console.error('Error applying coupon:', e);
      }
    }

    // Generate a pricing token (from secure flow) for downstream validation if needed
    const pricingToken = generatePricingToken({
      propertyId,
      checkIn,
      checkOut,
      guests,
      nights,
      totalAmount: pricingBreakdown.totalAmount
    });

    // Prepare response (preserve classic fields, add security + booking/property info)
    const response = {
      baseAmount: pricingBreakdown.baseAmount,
      nights: is24HourBooking ? 1 : nights,
      totalHours: is24HourBooking ? (pricingParams.totalHours || 24) : undefined,
      extraGuests: extraGuestsCount,
      extraGuestCost: pricingBreakdown.extraGuestCost, // Use backend-calculated value (includes nights)
      cleaningFee: pricingBreakdown.cleaningFee,
      serviceFee: pricingBreakdown.serviceFee,
      securityDeposit: pricingBreakdown.securityDeposit,
      hostFees: pricingBreakdown.hostFees,
      hourlyExtension: pricingBreakdown.hourlyExtension,
      discountAmount: pricingBreakdown.discountAmount,
      subtotal: pricingBreakdown.subtotal,
      hostSubtotal: pricingBreakdown.hostSubtotal,
      platformFee: pricingBreakdown.platformFee,
      processingFee: pricingBreakdown.processingFee,
      platformRevenue: pricingBreakdown.platformRevenue,
      gst: pricingBreakdown.gst,
      totalAmount: pricingBreakdown.totalAmount,
      hostEarning: pricingBreakdown.hostEarning,
      currency: pricingBreakdown.currency,
      platformFeeRate: pricingBreakdown.platformFeeRate,
      breakdown: pricingBreakdown.breakdown,
      bookingType: pricingParams.bookingType
    };

    res.status(200).json({
      success: true,
      data: {
        pricing: response,
        security: {
          pricingToken,
          calculatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
        },
        property: {
          id: property._id,
          title: property.title,
          maxGuests: property.maxGuests,
          minNights: property.minNights,
          checkInTime: property.checkInTime,
          checkOutTime: property.checkOutTime,
          cancellationPolicy: property.cancellationPolicy,
          basePrice: property.pricing?.basePrice,
          basePrice24Hour: property.pricing?.basePrice24Hour,
          enable24HourBooking: property.enable24HourBooking,
          hourlyBooking: property.hourlyBooking
        },
        booking: {
          checkIn,
          checkOut,
          checkInDateTime,
          guests,
          nights,
          totalHours: is24HourBooking ? (pricingParams.totalHours || 24) : undefined,
          bookingType: pricingParams.bookingType
        }
      }
    });

  } catch (error) {
    console.error('Error calculating pricing:', error);
    res.status(500).json({
      success: false,
      message: 'Error calculating pricing',
      error: error.message
    });
  }
};

// @desc    Validate coupon code
// @route   POST /api/pricing/validate-coupon
// @access  Public
const validateCoupon = async (req, res) => {
  try {
    const { couponCode, propertyId, checkIn, checkOut, guests } = req.body;

    if (!couponCode || !propertyId) {
      return res.status(400).json({
        success: false,
        message: 'Coupon code and property ID are required'
      });
    }

    // Find active coupon (align with model fields)
    const coupon = await Coupon.findOne({
      code: couponCode.toUpperCase(),
      isActive: true,
      validFrom: { $lte: new Date() },
      validTo: { $gte: new Date() }
    });

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired coupon code'
      });
    }

    // Check if coupon is applicable to this property (field names may differ)
    if (coupon.applicableToListings && coupon.applicableToListings.length > 0) {
      if (!coupon.applicableToListings.map(String).includes(String(propertyId))) {
        return res.status(400).json({
          success: false,
          message: 'This coupon is not applicable to the selected property'
        });
      }
    }

    // Calculate discount amount (simplified for validation)
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    const checkInDateOnly = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate());
    const checkOutDateOnly = new Date(checkOutDate.getFullYear(), checkOutDate.getMonth(), checkOutDate.getDate());
    const diffTime = checkOutDateOnly - checkInDateOnly;
    const nights = Math.max(0, diffTime / (1000 * 60 * 60 * 24));

    // Get property for base price calculation
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const basePrice = property.pricing?.basePrice || 0;
    const subtotal = basePrice * (nights || 1); // Avoid zero for same-day validation

    let discountAmount;
    if (coupon.discountType === 'percentage') {
      discountAmount = (subtotal * coupon.amount) / 100;
      const maxDiscount = coupon.maxDiscount || discountAmount;
      discountAmount = Math.min(discountAmount, maxDiscount);
    } else {
      discountAmount = Math.min(coupon.amount, subtotal);
    }

    res.status(200).json({
      success: true,
      data: {
        coupon: {
          code: coupon.code,
          discountAmount: Math.round(discountAmount * 100) / 100,
          discountType: coupon.discountType,
          description: coupon.description || `Get ${coupon.amount}${coupon.discountType === 'percentage' ? '%' : '₹'} off your booking`
        }
      }
    });

  } catch (error) {
    console.error('Error validating coupon:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating coupon',
      error: error.message
    });
  }
};

// @desc    Calculate full booking price including addons (live pricing for frontend)
// @route   POST /api/pricing/calculate-full
// @access  Public
const calculateFullPrice = async (req, res) => {
  try {
    const {
      propertyId,
      checkIn,
      checkOut,
      guests,
      couponCode,
      hourlyExtension,
      addonServices, // [{serviceId, quantity, selectedSlot}]
      isLateCheckIn,
      bookingDuration,
      extensionHours
    } = req.body;

    if (!propertyId) {
      return res.status(400).json({ success: false, message: 'propertyId is required' });
    }

    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({ success: false, message: 'Property not found' });
    }

    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    const checkInDateOnly = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate());
    const checkOutDateOnly = new Date(checkOutDate.getFullYear(), checkOutDate.getMonth(), checkOutDate.getDate());
    const nights = Math.max(1, (checkOutDateOnly - checkInDateOnly) / (1000 * 60 * 60 * 24));

    const guestsObj = typeof guests === 'object' ? guests : { adults: guests || 1 };
    const effectiveBasePrice = (isLateCheckIn && property.pricing?.basePrice24Hour)
      ? property.pricing.basePrice24Hour
      : property.pricing?.basePrice || 0;

    // Apply coupon
    let discountAmount = 0;
    if (couponCode) {
      try {
        const coupon = await Coupon.findOne({
          code: couponCode.toUpperCase(),
          isActive: true,
          validFrom: { $lte: new Date() },
          validTo: { $gte: new Date() }
        });
        if (coupon) {
          const baseSubtotal = effectiveBasePrice * nights;
          if (coupon.discountType === 'percentage') {
            discountAmount = (baseSubtotal * coupon.amount) / 100;
            const maxDiscount = coupon.maxDiscount || discountAmount;
            discountAmount = Math.min(discountAmount, maxDiscount);
          } else {
            discountAmount = Math.min(coupon.amount, baseSubtotal);
          }
        }
      } catch (_e) { /* ignore coupon errors */ }
    }

    let extensionCost = 0;
    if (hourlyExtension && property.hourlyBooking?.enabled) {
      extensionCost = calculateHourlyExtension(effectiveBasePrice, typeof hourlyExtension === 'object' ? hourlyExtension.hours : hourlyExtension);
    }

    const fullPricing = await calculateFullBookingPrice({
      basePrice: effectiveBasePrice,
      nights,
      cleaningFee: property.pricing?.cleaningFee || 0,
      serviceFee: property.pricing?.serviceFee || 0,
      securityDeposit: property.pricing?.securityDeposit || 0,
      extraGuestPrice: property.pricing?.extraGuestPrice || 0,
      extraGuests: guestsObj.adults > (property.pricing?.includedGuests || 1)
        ? guestsObj.adults - (property.pricing?.includedGuests || 1) : 0,
      hourlyExtension: extensionCost,
      discountAmount,
      currency: property.pricing?.currency || 'INR',
      addonServices: addonServices || [],
      bookingContext: { checkIn, checkOut, guests: guestsObj, nights }
    });

    // Generate pricing token for the grand total (property + addons)
    const pricingToken = generatePricingToken({
      propertyId,
      checkIn: checkIn,
      checkOut: checkOut,
      guests: guestsObj,
      nights,
      totalAmount: fullPricing.propertyTotal // Token is for property total only
    });

    return res.json({
      success: true,
      data: {
        pricing: fullPricing,
        pricingToken,
        calculatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error calculating full price:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Error calculating price'
    });
  }
};

module.exports = {
  getPlatformFeeRate,
  calculatePricing,
  validateCoupon,
  calculateFullPrice
};
