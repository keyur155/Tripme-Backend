const Booking = require('../models/Booking');
const Property = require('../models/Property');
const Service = require('../models/Service');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Payout = require('../models/Payout');
const Coupon = require('../models/Coupon');
const Availability = require('../models/Availability');
const razorpayService = require('../services/razorpay.service');
const { calculatePricingBreakdown, calculateTotalHours, calculateCheckoutTime, calculateNextAvailableTime, validate24HourBooking, calculateHourlyExtension, toTwoDecimals } = require('../utils/pricingUtils');
const { calculateExtendedCheckout, getAdditionalDatesForExtension } = require('../config/pricing.config');
const AvailabilityService = require('../services/availability.service');
const mongoose = require('mongoose');
// ========================================
// NEW: Import AvailabilityEvent Service for flexible hourly booking with maintenance
// If this causes issues, you can comment out this line and the related code blocks below
// ========================================
const AvailabilityEventService = require('../services/availabilityEvent.service');

const Notification = require('../models/Notification');
const RefundService = require('../services/refundService');
const {
  sendBookingConfirmationEmail,
  sendBookingCancellationEmail,
  sendHostCancelledBookingEmail,
  sendHostConfirmedBookingEmail,
  sendHostCompletedBookingEmail,
  sendHostCheckInGuestEmail,
  sendHostStatusUpdateEmail
} = require('../utils/sendEmail');
const { generateReceipt, generateReceiptHTML } = require('../utils/generateReceipt');

// Helper function to map Refund model status to Booking model refundStatus enum
// Refund model: ['pending', 'approved', 'processing', 'completed', 'failed', 'rejected', 'cancelled']
// Booking model: ['pending', 'processed', 'completed', 'not_applicable']
const mapRefundStatusToBooking = (refundStatus) => {
  if (!refundStatus) return 'not_applicable';

  const statusMap = {
    'pending': 'pending',
    'approved': 'pending', // Approved but not yet processed
    'processing': 'processed', // Currently being processed
    'completed': 'completed',
    'failed': 'pending', // Failed, keep as pending for retry
    'rejected': 'pending', // Rejected, keep as pending
    'cancelled': 'not_applicable' // Cancelled refund
  };

  return statusMap[refundStatus] || 'pending';
};



function normalizeToLocalMidnight(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatLocalDate(date) {
  return date.toLocaleDateString('en-CA'); // YYYY-MM-DD

}
// @desc    Pre-validate booking BEFORE payment — ensures nothing fails after money is charged
// @route   POST /api/bookings/pre-validate
// @access  Private
const preValidateBooking = async (req, res) => {
  try {
    const {
      propertyId,
      listingId,
      serviceId,
      checkIn,
      checkOut,
      checkInDateTime,
      bookingDuration,
      guests,
      hourlyExtension,
      extensionHours,
      isLateCheckIn,
    } = req.body;

    // Enforce email verification before allowing bookings (check here so it fails before payment)
    if (req.user && !req.user.isVerified && !req.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email address before making a booking'
      });
    }

    const actualListingId = listingId || propertyId;

    if (actualListingId && serviceId) {
      return res.status(400).json({ success: false, message: 'Cannot book both listing and service' });
    }
    if (!actualListingId && !serviceId) {
      return res.status(400).json({ success: false, message: 'Either propertyId or serviceId is required' });
    }

    // ── 1. Load listing / service ──────────────────────────────────────────────
    let listing = null;
    let service = null;

    if (actualListingId) {
      listing = await Property.findById(actualListingId);
      if (!listing) return res.status(404).json({ success: false, message: 'Property not found' });
    } else {
      service = await require('../models/Service').findById(serviceId);
      if (!service) return res.status(404).json({ success: false, message: 'Service not found' });
    }

    const is24HourBooking = bookingDuration === '24hour';

    // ── 2. Security validation (booking parameters) ────────────────────────────
    const requested24Hour = bookingDuration === '24hour';
    const isLateCheckInFlag = isLateCheckIn === true;
    const basePriceForValidation = requested24Hour
      ? (listing?.pricing?.basePrice24Hour || listing?.pricing?.basePrice || service?.pricing?.basePrice)
      : (isLateCheckInFlag && listing?.pricing?.basePrice24Hour)
        ? listing.pricing.basePrice24Hour
        : (listing?.pricing?.basePrice || service?.pricing?.basePrice);

    const bookingValidation = require('../utils/paymentSecurity').validateBookingParameters({
      checkIn,
      checkOut,
      checkInDateTime,
      bookingDuration,
      guests,
      basePrice: basePriceForValidation,
      hourlyExtension: requested24Hour ? { hours: extensionHours || 0 } : hourlyExtension,
      extensionHours,
    });

    if (!bookingValidation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking parameters',
        errors: bookingValidation.errors,
      });
    }

    // ── 3. 24-hour specific validation ────────────────────────────────────────
    if (is24HourBooking && listing) {
      const ensureDate = (val) => {
        if (!val) return null;
        const d = val instanceof Date ? val : new Date(val);
        return isNaN(d.getTime()) ? null : d;
      };

      const checkInDateTimeObj = ensureDate(checkInDateTime);
      if (!checkInDateTimeObj) {
        return res.status(400).json({ success: false, message: 'checkInDateTime is required for 24-hour booking' });
      }

      const totalHours = calculateTotalHours(24, extensionHours || 0);
      const validation = validate24HourBooking({
        checkInDateTime: checkInDateTimeObj,
        totalHours,
        minHours: listing.availabilitySettings?.minBookingHours || 23,
        maxHours: listing.availabilitySettings?.maxBookingHours || 168,
      });

      if (!validation.isValid) {
        return res.status(400).json({
          success: false,
          message: 'Invalid 24-hour booking parameters',
          errors: validation.errors,
        });
      }

      // Check time-slot availability for 24-hour booking
      const checkOutDateTime = calculateCheckoutTime(checkInDateTimeObj, totalHours);
      const isAvailable = await AvailabilityService.isTimeSlotAvailable(
        actualListingId,
        checkInDateTimeObj,
        checkOutDateTime
      );

      if (!isAvailable) {
        return res.status(400).json({ success: false, message: 'Selected time slot is not available' });
      }
    }

    // ── 4. Daily booking: check that nights > 0 ───────────────────────────────
    if (!is24HourBooking && listing) {
      const ensureDate = (val) => { const d = new Date(val); return isNaN(d.getTime()) ? null : d; };
      const checkInDate = ensureDate(checkIn);
      const checkOutDate = ensureDate(checkOut);
      if (checkInDate && checkOutDate) {
        const cinOnly = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate());
        const coutOnly = new Date(checkOutDate.getFullYear(), checkOutDate.getMonth(), checkOutDate.getDate());
        const nights = (coutOnly - cinOnly) / (1000 * 60 * 60 * 24);
        if (nights <= 0) {
          return res.status(400).json({ success: false, message: 'Check-out must be after check-in (at least 1 night)' });
        }
      }
    }

    // ── 5. Issue a short-lived validation token (signed, cannot be forged) ────
    const crypto = require('crypto');
    const tokenPayload = JSON.stringify({
      userId: req.user._id.toString(),
      listingId: actualListingId || serviceId,
      checkIn,
      checkOut,
      bookingDuration: bookingDuration || 'daily',
      guests,
      ts: Date.now(),
    });
    const validationToken = crypto
      .createHmac('sha256', process.env.JWT_SECRET)
      .update(tokenPayload)
      .digest('hex');

    console.log(`✅ Pre-validation passed for user ${req.user._id} | property ${actualListingId}`);

    return res.status(200).json({
      success: true,
      message: 'Booking pre-validation successful — safe to proceed with payment',
      data: {
        validationToken,
        expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(), // 20 minutes
        bookingDuration: bookingDuration || 'daily',
        is24HourBooking,
      },
    });
  } catch (error) {
    console.error('❌ Pre-validate booking error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Pre-validation failed',
      errors: error.errors,
    });
  }
};

// @desc    Process payment and create booking (new flow)
// @route   POST /api/bookings/process-payment
// @access  Private
const processPaymentAndCreateBooking = async (req, res) => {

  let session
  try {
    const {
      propertyId,
      listingId,
      serviceId,
      checkIn,
      checkOut,
      checkInTime,
      checkOutTime,
      timeSlot,
      guests,
      specialRequests,
      couponCode,
      hourlyExtension,
      contactInfo,
      paymentMethod,
      idempotencyKey,
      paymentData,
      // NEW: 24-hour booking parameters
      checkInDateTime,
      extensionHours,
      bookingDuration,
      // Late check-in flag: use basePrice24Hour per night even for daily multi-night bookings
      isLateCheckIn,
      // Secure pricing token: pre-validated amount issued by /api/pricing/calculate
      // If provided and valid, we trust this amount instead of recalculating
      pricingToken
    } = req.body;

    // Generate idempotency key if not provided
    const finalIdempotencyKey = idempotencyKey || require('crypto').randomUUID();
    let bookingDoc;
    let paymentDoc;
    let bookingCheckInDateTime;
    let bookingCheckOutDateTime;
    let totalHours;
    let nextAvailableTime;
    let hostBufferTime;
    let amount

    // Enforce email verification before allowing bookings
    if (req.user && !req.user.isVerified && !req.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email address before making a booking'
      });
    }

    // Decide 24-hour flow strictly via bookingDuration flag to avoid misclassification when checkInDateTime is sent for daily bookings
    let is24HourBooking = bookingDuration === '24hour';
    session = await mongoose.startSession();

    await session.withTransaction(async () => {

      // Check for duplicate booking with same idempotency key
      const existingBooking = await Booking.findOne({
        'metadata.idempotencyKey': finalIdempotencyKey,
        user: req.user._id
      }).session(session);

      if (existingBooking) {
        const err = new Error('IDEMPOTENCY_CONFLICT');
        err.status = 409;
        err.bookingId = existingBooking._id;
        throw err;
        // return res.status(409).json({ 
        //   success: false, 
        //   message: 'Booking with this idempotency key already exists',
        //   bookingId: existingBooking._id
        // });
      }

      // Determine if this is a property or service booking
      const actualListingId = listingId || propertyId;
      let listing = null;
      let service = null;
      let host = null;
      let bookingType = '';
      let currency = 'INR';
      let cancellationPolicy = 'moderate';

      if (actualListingId && serviceId) {
        const err = new Error('Cannot book both listing and service in one booking');
        err.status = 400;
        throw err;
        // return res.status(400).json({
        //   success: false,
        //   message: 'Cannot book both listing and service in one booking'
        // });
      }
      if (!actualListingId && !serviceId) {
        const err = new Error('Either listingId/propertyId or serviceId is required');
        err.status = 400;
        throw err;
        // return res.status(400).json({ 
        //   success: false,
        //   message: 'Either listingId/propertyId or serviceId is required'
        // });
      }

      // Get listing or service details
      if (actualListingId) {
        listing = await Property.findById(actualListingId).session(session);
        if (!listing) {
          const err = new Error('LISTING_NOT_FOUND');
          err.status = 404;
          throw err;
          // return res.status(404).json({ success: false, message: 'Listing not found' });
        }
        host = await User.findById(listing.host);
        bookingType = 'property';
        currency = listing.pricing.currency || 'INR';
        cancellationPolicy = listing.cancellationPolicy || 'moderate';
      } else {
        service = await Service.findById(serviceId);
        if (!service) {
          const err = new Error('Service not found');
          err.status = 404;
          throw err;
          // return res.status(404).json({ success: false, message: 'Service not found' });
        }
        host = await User.findById(service.provider);
        bookingType = 'service';
        currency = service.pricing.currency || 'INR';
        cancellationPolicy = service.cancellationPolicy || 'moderate';
      }

      if (!host) {
        const err = new Error('Host not found');
        err.status = 404;
        throw err;
        // return res.status(404).json({ success: false, message: 'Host not found' });
      }

      const requested24Hour = bookingDuration === '24hour';
      // For late check-in daily bookings, use basePrice24Hour for validation just like pricing API
      const isLateCheckInFlag = isLateCheckIn === true;
      const basePriceForValidation = requested24Hour
        ? (listing?.pricing?.basePrice24Hour || listing?.pricing?.basePrice || service?.pricing?.basePrice)
        : (isLateCheckInFlag && listing?.pricing?.basePrice24Hour)
          ? listing.pricing.basePrice24Hour
          : (listing?.pricing?.basePrice || service?.pricing?.basePrice);
      // Security validation for booking parameters
      const bookingValidation = require('../utils/paymentSecurity').validateBookingParameters({
        checkIn: checkIn,
        checkOut: checkOut,
        checkInDateTime,
        bookingDuration,
        guests: guests,
        basePrice: basePriceForValidation,
        hourlyExtension: requested24Hour ? { hours: extensionHours || 0 } : hourlyExtension,
        extensionHours: extensionHours
      });

      if (!bookingValidation.isValid) {
        console.error('❌ Booking validation failed:', bookingValidation.errors);
        const err = new Error('Invalid booking parameters');
        err.status = 400;
        err.errors = bookingValidation.errors;
        throw err;

      }

      // Verify payment amount if provided (skip for Razorpay - we verify signature instead)
      if (paymentData && !paymentData.razorpayOrderId) {
        // Only verify amount for non-Razorpay payments
        const amountVerification = require('../utils/paymentSecurity').verifyPaymentAmount(paymentData, {
          basePrice: listing?.pricing?.basePrice || service?.pricing?.basePrice || 0,
          nights: bookingType === 'property' ?
            Math.ceil((new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24)) : 1,
          cleaningFee: listing?.pricing?.cleaningFee || service?.pricing?.cleaningFee || 0,
          serviceFee: listing?.pricing?.serviceFee || service?.pricing?.serviceFee || 0,
          securityDeposit: listing?.pricing?.securityDeposit || service?.pricing?.securityDeposit || 0,
          extraGuestPrice: listing?.pricing?.extraGuestPrice || service?.pricing?.perPersonPrice || 0,
          extraGuests: guests?.adults > 1 ? guests.adults - 1 : 0,
          hourlyExtension: hourlyExtension?.cost || 0,
          discountAmount: 0, // Will be calculated later
          currency: currency
        });

        if (!amountVerification.isValid) {
          const err = new Error("Payment amount verification failed");
          err.status = 400;
          err.errors = amountVerification.errors;
          err.expectedAmount = amountVerification.expectedAmount;
          err.actualAmount = amountVerification.actualAmount;
          throw err;

          // return res.status(400).json({ 
          //   success: false, 
          //   message: 'Payment amount verification failed',
          //   errors: amountVerification.errors,
          //   expectedAmount: amountVerification.expectedAmount,
          //   actualAmount: amountVerification.actualAmount
          // });
        }
      } else if (paymentData && paymentData.razorpayOrderId) {
        // For Razorpay, we verify signature instead of amount (amount verification happens via Razorpay API)
      }

      // Determine if this is a 24-hour booking (only via explicit flag to avoid misclassification)
      is24HourBooking = bookingDuration === '24hour';

      // Normalize incoming dates to Date objects early (needed for pricing and availability)
      const ensureDate = (val) => {
        if (!val) return null;
        const d = val instanceof Date ? val : new Date(val);
        return isNaN(d.getTime()) ? null : d;
      };

      const checkInDateObj = ensureDate(checkIn);
      const checkOutDateObj = ensureDate(checkOut);
      const checkInDateTimeObj = ensureDate(checkInDateTime);

      // Calculate pricing using centralized pricing system
      let pricingParams = {
        basePrice: 0,
        nights: 1,
        cleaningFee: 0,
        serviceFee: 0,
        securityDeposit: 0,
        extraGuestPrice: 0,
        extraGuests: 0,
        hourlyExtension: 0,
        discountAmount: 0,
        currency: currency,
        bookingType: is24HourBooking ? '24hour' : 'daily'
      };

      if (bookingType === 'property') {
        if (is24HourBooking) {
          if (!checkInDateTimeObj) {
            const err = new Error("Check-in datetime is required for 24-hour booking");
            err.status = 400;
            throw err;
          }
          // 24-hour booking logic — base is 24 hours (not 23)
          totalHours = calculateTotalHours(24, extensionHours || 0);
          const checkOutDateTime = calculateCheckoutTime(checkInDateTimeObj, totalHours);

          // Validate 24-hour booking parameters
          const validation = validate24HourBooking({
            checkInDateTime: checkInDateTimeObj,
            totalHours,
            minHours: listing.availabilitySettings?.minBookingHours || 23,
            maxHours: listing.availabilitySettings?.maxBookingHours || 168
          });

          if (!validation.isValid) {
            const err = new Error("Invalid 24-hour booking parameters");
            err.errors = validation.errors;
            err.status = 400;
            throw err;
            // return res.status(400).json({ 
            //   success: false, 
            //   message: 'Invalid 24-hour booking parameters',
            //   errors: validation.errors
            // });
          }

          // Check availability for 24-hour booking
          const isAvailable = await AvailabilityService.isTimeSlotAvailable(
            actualListingId,
            checkInDateTimeObj,
            checkOutDateTime
          );

          if (!isAvailable) {
            const err = new Error("Time slot not available for 24-hour booking");
            err.status = 400;
            throw err;
            // return res.status(400).json({ 
            //   success: false, 
            //   message: 'Time slot not available for 24-hour booking' 
            // });
          }

          // Set 24-hour pricing parameters
          pricingParams.basePrice24Hour = listing.pricing.basePrice24Hour || listing.pricing.basePrice;
          pricingParams.totalHours = totalHours;
          pricingParams.extraGuestPrice = listing.pricing.extraGuestPrice || 0;
          pricingParams.cleaningFee = listing.pricing.cleaningFee || 0;
          pricingParams.serviceFee = listing.pricing.serviceFee || 0; // Use property's service fee or 0
          pricingParams.securityDeposit = listing.pricing.securityDeposit || 0;
          pricingParams.extraGuests = guests.adults > 1 ? guests.adults - 1 : 0;

          // Add extension cost if applicable
          if (extensionHours && extensionHours > 0) {
            const extensionCost = calculateHourlyExtension(listing.pricing.basePrice24Hour || listing.pricing.basePrice, extensionHours);
            pricingParams.hourlyExtension = extensionCost;
            console.log(`🕐 24-hour extension calculated: ${extensionHours} hours = ₹${extensionCost}`);
          }
        } else {
          // Regular daily booking logic
          // Use basePrice24Hour per night when check-in is after 4 PM (late check-in)
          const effectiveBasePrice = (isLateCheckIn === true && listing.pricing.basePrice24Hour)
            ? listing.pricing.basePrice24Hour
            : listing.pricing.basePrice;
          console.log(`💰 Daily booking base price: ₹${effectiveBasePrice} (lateCheckIn: ${isLateCheckIn}, basePrice24Hour: ${listing.pricing.basePrice24Hour})`);

          pricingParams.basePrice = effectiveBasePrice;
          pricingParams.extraGuestPrice = listing.pricing.extraGuestPrice || 0;
          pricingParams.cleaningFee = listing.pricing.cleaningFee || 0;
          pricingParams.serviceFee = listing.pricing.serviceFee || 0; // Use property's service fee or 0
          pricingParams.securityDeposit = listing.pricing.securityDeposit || 0;
          // Calculate nights properly for accommodation bookings
          // Count actual nights stayed (Nov 1 to Nov 5 = 4 nights)
          const checkInDate = new Date(checkIn);
          const checkOutDate = new Date(checkOut);

          // Strip time components to get date-only comparison
          const checkInDateOnly = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate());
          const checkOutDateOnly = new Date(checkOutDate.getFullYear(), checkOutDate.getMonth(), checkOutDate.getDate());

          const diffTime = checkOutDateOnly - checkInDateOnly;
          const diffDays = diffTime / (1000 * 60 * 60 * 24);
          pricingParams.nights = Math.max(0, diffDays);
          pricingParams.extraGuests = guests.adults > 1 ? guests.adults - 1 : 0;

          // Add hourly extension cost if applicable
          if (hourlyExtension && hourlyExtension.hours && listing.hourlyBooking?.enabled) {
            pricingParams.hourlyExtension = calculateHourlyExtension(effectiveBasePrice, hourlyExtension.hours);
            console.log(`🕐 Hourly extension calculated: ${hourlyExtension.hours} hours = ₹${pricingParams.hourlyExtension}`);
          }
        }
      } else {
        pricingParams.basePrice = service.pricing.basePrice;
        pricingParams.serviceFee = service.pricing.serviceFee || 0;
        pricingParams.extraGuests = guests.adults > 1 ? guests.adults - 1 : 0;
        pricingParams.extraGuestPrice = service.pricing.perPersonPrice || 0;
      }

      // Apply coupon if provided
      let couponApplied = null;
      if (couponCode) {
        const coupon = await Coupon.findOne({
          code: couponCode.toUpperCase(),
          isActive: true,
          validFrom: { $lte: new Date() },
          validTo: { $gte: new Date() }
        }).session(session);
        if (coupon) {
          const hasUsed = coupon.usedBy?.some(usage => usage.user.toString() === req.user._id.toString());
          if (!hasUsed) {
            // Calculate subtotal first to apply coupon discount
            const tempPricing = await calculatePricingBreakdown(pricingParams);
            let discountAmount = 0;

            if (coupon.discountType === 'percentage') {
              discountAmount = (tempPricing.subtotal * coupon.amount) / 100;
              const maxDiscount = coupon.maxDiscount || discountAmount;
              discountAmount = Math.min(discountAmount, maxDiscount);
            } else {
              discountAmount = coupon.amount;
            }

            pricingParams.discountAmount = discountAmount;
            couponApplied = coupon._id;
            coupon.usedCount += 1;
            coupon.usedBy.push({ user: req.user._id, usedAt: new Date() });
            await coupon.save({ session });
          }
        }
      }

      // Calculate final pricing breakdown using unified utilities
      let pricing = await calculatePricingBreakdown(pricingParams);

      // Cache for Razorpay payment details fetched during service anchor / token recovery
      let prefetchedRazorpayDetails = null;

      // ── Service Booking: anchor totalAmount to Razorpay-charged amount ─────────
      // The service booking page computes its own total (basePrice + guests + 12% flat
      // platform fee) while this backend uses the DB-configured rate (15%) + GST +
      // processing fee — producing a guaranteed mismatch.  Rather than recreating the
      // frontend formula, we trust the Razorpay-charged amount as the authoritative
      // total (the customer already consciously paid that amount).
      if (bookingType === 'service' && paymentData?.razorpayPaymentId) {
        try {
          const razorpayService = require('../services/razorpay.service');
          const rzpDetails = await razorpayService.getPaymentDetails(paymentData.razorpayPaymentId);
          const chargedRupees = Number(rzpDetails?.amount) / 100; // paise → rupees
          if (chargedRupees > 0) {
            console.log(`💰 Service booking: anchoring totalAmount to Razorpay-charged ₹${chargedRupees} (backend calculated ₹${pricing.totalAmount})`);
            // Store prefetched details to avoid duplicate API call later
            prefetchedRazorpayDetails = rzpDetails;
            pricing = { ...pricing, totalAmount: chargedRupees };
          }
        } catch (rzpErr) {
          console.error('⚠️ Could not fetch Razorpay details for service amount anchor:', rzpErr.message);
          // Fall through — will likely hit mismatch check below and fail safely
        }
      }


      // ── Pricing Token Verification ───────────────────────────────────────────
      // If the client supplied a pricingToken (issued by /api/pricing/calculate),
      // verify it and trust the pre-validated amount.  This prevents race conditions
      // where minor parameter differences cause the backend to produce a total that
      // differs from what Razorpay was charged.
      if (pricingToken) {
        const { verifyPricingToken } = require('../middlewares/pricingSecurity.middleware');
        const checkInDateRaw = checkIn instanceof Date ? checkIn : new Date(checkIn);
        const checkOutDateRaw = checkOut instanceof Date ? checkOut : new Date(checkOut);
        const checkInDateOnly = new Date(checkInDateRaw.getFullYear(), checkInDateRaw.getMonth(), checkInDateRaw.getDate());
        const checkOutDateOnly = new Date(checkOutDateRaw.getFullYear(), checkOutDateRaw.getMonth(), checkOutDateRaw.getDate());
        const tokenNights = Math.max(0, (checkOutDateOnly - checkInDateOnly) / (1000 * 60 * 60 * 24));

        // Normalize checkIn/checkOut to YYYY-MM-DD — this is the format the pricing
        // controller uses when generating the token, so we must match it exactly.
        const toDateOnlyStr = (d) => {
          const dt = d instanceof Date ? d : new Date(d);
          return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        };
        const checkInStr = toDateOnlyStr(checkInDateRaw);
        const checkOutStr = toDateOnlyStr(checkOutDateRaw);

        // Base token payload matching what pricing.controller.js generates
        const baseTokenPayload = {
          propertyId: String(propertyId || listingId || ''),
          checkIn: checkInStr,
          checkOut: checkOutStr,
          guests,
          nights: tokenNights,
        };

        let tokenIsValid = false;
        let recoveredAmount = null;

        // Step 1: Try verifying against current recalculated total
        try {
          tokenIsValid = verifyPricingToken({ ...baseTokenPayload, totalAmount: pricing.totalAmount }, pricingToken);
        } catch (_e) {
          tokenIsValid = false;
        }

        // Step 2: If recalculated amount doesn't match token, try the Razorpay-charged amount.
        // This is the recovery path for the mismatch bug: the pricing token was generated
        // with the correct amount (₹X) but the backend just recalculated ₹Y due to parameter
        // drift.  The actual charged amount from Razorpay is the authoritative correct amount.
        if (!tokenIsValid && paymentData?.razorpayPaymentId) {
          try {
            const rzpDetails = await razorpayService.getPaymentDetails(paymentData.razorpayPaymentId);
            prefetchedRazorpayDetails = rzpDetails; // cache for reuse below
            const chargedRupees = Number(rzpDetails?.amount) / 100; // paise → rupees
            const candidateValid = (() => {
              try {
                return verifyPricingToken({ ...baseTokenPayload, totalAmount: chargedRupees }, pricingToken);
              } catch (_e) {
                return false;
              }
            })();
            if (candidateValid) {
              console.log(`✅ pricingToken verified against Razorpay-charged amount ₹${chargedRupees} (backend recalculated ₹${pricing.totalAmount}). Using charged amount.`);
              recoveredAmount = chargedRupees;
              pricing = { ...pricing, totalAmount: chargedRupees };
              tokenIsValid = true;
            }
          } catch (rzpLookupErr) {
            console.error('⚠️ Could not fetch Razorpay payment details for token recovery:', rzpLookupErr.message);
          }
        }

        if (tokenIsValid) {
          console.log(`🔒 pricingToken verified — final booking amount: ₹${pricing.totalAmount}${recoveredAmount ? ' (recovered from Razorpay)' : ' (matches recalculation)'}`);
        } else {
          console.warn(`⚠️ pricingToken provided but could not be verified. Proceeding with recalculated total ₹${pricing.totalAmount}. Token check: non-fatal.`);
        }
      } else {
        console.log(`💰 No pricingToken supplied — booking will use recalculated total ₹${pricing.totalAmount}`);
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Extract values for backward compatibility
      const {
        subtotal,
        platformFee,
        totalAmount,
        hostEarning,
        gst,
        processingFee,
        breakdown
      } = pricing;

      // Handle checkout time calculation based on booking type
      let finalCheckOut = checkOutDateObj;
      let finalCheckOutTime = checkOutTime || (bookingType === 'property' ? (listing.checkOutTime || '10:00') : undefined);
      bookingCheckInDateTime = checkInDateObj;
      bookingCheckOutDateTime = finalCheckOut;
      totalHours = 24;
      hostBufferTime = 2;
      nextAvailableTime = null;

      if (is24HourBooking) {
        // 24-hour booking checkout calculation
        bookingCheckInDateTime = checkInDateTimeObj;
        bookingCheckOutDateTime = calculateCheckoutTime(checkInDateTimeObj, totalHours);
        finalCheckOut = bookingCheckOutDateTime;
        // Align checkout time string with 24h flow (same time as check-in plus extensions)
        const outH = bookingCheckOutDateTime.getHours().toString().padStart(2, '0');
        const outM = bookingCheckOutDateTime.getMinutes().toString().padStart(2, '0');
        finalCheckOutTime = `${outH}:${outM}`;

        // Calculate next available time (checkout + buffer time)
        hostBufferTime = listing.availabilitySettings?.hostBufferTime || 2;
        nextAvailableTime = calculateNextAvailableTime(bookingCheckOutDateTime, hostBufferTime);

        console.log(`🕐 24-hour booking: Check-in ${bookingCheckInDateTime?.toISOString?.() || bookingCheckInDateTime}, Check-out ${bookingCheckOutDateTime?.toISOString?.() || bookingCheckOutDateTime}`);
        console.log(`⏰ Total hours: ${totalHours}, Next available: ${nextAvailableTime.toISOString()}`);
      } else if (bookingType === 'property') {
        // NEW: Custom check-in time handling for hourly booking properties
        // Checkout = checkOutDate at (check-in time - 1 hour) + extension
        // Example: Check-in Dec 5 at 4 PM, Checkout date Dec 7 → Checkout: Dec 7 at 3 PM
        if (checkInTime && listing.hourlyBooking?.enabled) {
          console.log(`🕐 Custom check-in time booking: ${checkInTime}`);

          // Parse custom check-in time
          const [checkInHour, checkInMinute] = checkInTime.split(':').map(Number);

          // Use the checkout DATE as the base, set time to (check-in time - 1 hour)
          let customCheckOut = new Date(checkOutDateObj);
          customCheckOut.setHours(checkInHour - 1, checkInMinute, 0, 0);

          // Add extension hours if applicable
          const extensionHrs = hourlyExtension?.hours || 0;
          if (extensionHrs > 0) {
            customCheckOut.setHours(customCheckOut.getHours() + extensionHrs);
            console.log(`🕐 Extension applied: +${extensionHrs} hours`);
          }

          // Update checkout time string
          finalCheckOut = customCheckOut;
          finalCheckOutTime = `${customCheckOut.getHours().toString().padStart(2, '0')}:${customCheckOut.getMinutes().toString().padStart(2, '0')}`;

          console.log(`📅 Check-in date: ${checkInDateObj.toISOString()}`);
          console.log(`📅 Checkout date (selected): ${checkOutDateObj.toISOString()}`);
          console.log(`📅 Final checkout with time: ${finalCheckOut.toISOString()}`);
          console.log(`⏰ Checkout time: ${finalCheckOutTime}`);
        } else if (hourlyExtension && hourlyExtension.hours) {
          // Regular hourly extension logic (fallback for non-custom time bookings)
          const extensionInfo = calculateExtendedCheckout(
            finalCheckOut,
            hourlyExtension.hours,
            finalCheckOutTime
          );

          // FIXED: Use newCheckout (full datetime) instead of checkoutDate (date only)
          const originalCheckOut = new Date(finalCheckOut);
          finalCheckOut = extensionInfo.newCheckout; // Full datetime with extension applied
          finalCheckOutTime = extensionInfo.checkoutTime;

          console.log(`🕐 Hourly extension applied: +${hourlyExtension.hours} hours`);
          console.log(`📅 Original checkout: ${originalCheckOut.toISOString()}`);
          console.log(`📅 New checkout: ${finalCheckOut.toISOString()}`);
          console.log(`⏰ New checkout time: ${finalCheckOutTime}`);
          console.log(`📆 Extends to next day: ${extensionInfo.isNextDay}`);
        }
      }

      // Step 1: Create booking first (temporary, will be updated after payment)
      const booking = await Booking.create([{
        user: req.user._id,
        host: host._id,
        listing: bookingType === 'property' ? actualListingId : undefined,
        service: bookingType === 'service' ? serviceId : undefined,
        bookingType,
        bookingDuration: is24HourBooking ? '24hour' : 'daily',
        status: 'pending', // Will be updated to confirmed after payment
        checkIn: bookingType === 'property' ? checkInDateObj : undefined,
        checkOut: bookingType === 'property' ? finalCheckOut : undefined,
        // NEW: 24-hour booking fields
        checkInDateTime: is24HourBooking ? bookingCheckInDateTime : undefined,
        checkOutDateTime: is24HourBooking ? bookingCheckOutDateTime : undefined,
        baseHours: is24HourBooking ? 24 : undefined,
        totalHours: is24HourBooking ? totalHours : undefined,
        hostBufferTime: is24HourBooking ? hostBufferTime : undefined,
        nextAvailableTime: is24HourBooking ? nextAvailableTime : undefined,
        checkInTime: (() => {
          const savedTime = checkInTime || (bookingType === 'property' ? (listing.checkInTime || '11:00') : undefined);
          console.log('🕐 DEBUG - Saving checkInTime:', savedTime, '| received:', checkInTime, '| listing default:', listing?.checkInTime);
          return savedTime;
        })(),
        checkOutTime: (() => {
          console.log('🕐 DEBUG - Saving checkOutTime:', finalCheckOutTime);
          return finalCheckOutTime;
        })(),
        timeSlot: bookingType === 'service' ? timeSlot : undefined,
        guests: guests,
        totalAmount,
        subtotal: subtotal,
        taxAmount: gst,
        serviceFee: pricing.serviceFee,
        cleaningFee: pricing.cleaningFee,
        securityDeposit: pricing.securityDeposit,
        currency,
        cancellationPolicy,
        specialRequests: specialRequests || undefined,
        hourlyExtension: is24HourBooking ? (extensionHours > 0 ? {
          hours: extensionHours,
          rate: extensionHours === 6 ? 0.30 : extensionHours === 12 ? 0.60 : 0.75,
          totalHours: extensionHours
        } : undefined) : (hourlyExtension || undefined),
        contactInfo: contactInfo || undefined,
        paymentStatus: 'pending', // Will be updated to paid after payment
        refundAmount: 0,
        refunded: false,
        couponApplied,
        discountAmount: pricing.discountAmount,
        hostFee: hostEarning,
        platformFee: platformFee,
        processingFee: processingFee,
        gst: gst,
        // Store pricing breakdown for detailed reporting
        pricingBreakdown: breakdown,
        // Security metadata
        metadata: {
          idempotencyKey: finalIdempotencyKey,
          userAgent: req.get('User-Agent'),
          ipAddress: req.ip,
          forwardedFor: req.get('X-Forwarded-For'),
          realIp: req.get('X-Real-IP'),
          referer: req.get('Referer'),
          origin: req.get('Origin'),
          timestamp: new Date().toISOString(),
          securityVersion: '1.0',
          bookingType: is24HourBooking ? '24hour' : 'daily',
          totalHours: is24HourBooking ? totalHours : undefined,
          extensionHours: is24HourBooking ? extensionHours : undefined
        }
      }], { session });
      bookingDoc = booking[0];

      // Step 2: Create payment with booking reference
      // Require and verify Razorpay payment proof for this flow
      let razorpayOrderId = null;
      let razorpayPaymentId = null;
      let razorpaySignature = null;
      let isPaymentVerified = false;
      let razorpayPaymentDetails = null;

      if (!paymentData || !paymentData.razorpayOrderId || !paymentData.razorpayPaymentId || !paymentData.razorpaySignature) {
        const err = new Error('Razorpay payment proof is required');
        err.status = 400;
        throw err;
      }

      if (paymentData && paymentData.razorpayOrderId && paymentData.razorpayPaymentId && paymentData.razorpaySignature) {
        // Verify payment signature
        isPaymentVerified = razorpayService.verifyPayment(
          paymentData.razorpayOrderId,
          paymentData.razorpayPaymentId,
          paymentData.razorpaySignature
        );

        if (!isPaymentVerified) {
          const err = new Error('Invalid payment signature. Payment verification failed.');
          err.status = 400;
          throw err;
        }

        razorpayOrderId = paymentData.razorpayOrderId;
        razorpayPaymentId = paymentData.razorpayPaymentId;
        razorpaySignature = paymentData.razorpaySignature;

        // Get payment details from Razorpay (use pre-fetched details if available from token recovery)
        try {
          razorpayPaymentDetails = prefetchedRazorpayDetails || await razorpayService.getPaymentDetails(razorpayPaymentId);
        } catch (razorpayError) {
          console.error('❌ Error fetching Razorpay payment details:', razorpayError);
          const err = new Error("Failed to verify payment with Razorpay");
          err.status = 400;
          err.error = razorpayError.message;
          throw err;
          // return res.status(400).json({
          //   success: false,
          //   message: 'Failed to verify payment with Razorpay',
          //   error: razorpayError.message
          // });
        }

        const expectedAmountPaise = Math.round(Number(totalAmount) * 100);
        const expectedCurrency = currency || 'INR';
        const razorpayStatus = razorpayPaymentDetails?.status;

        if (razorpayPaymentDetails?.order_id !== razorpayOrderId) {
          const err = new Error('Razorpay order mismatch');
          err.status = 400;
          throw err;
        }

        const paidAmountPaise = Number(razorpayPaymentDetails?.amount);
        const amountDiff = Math.abs(paidAmountPaise - expectedAmountPaise);
        // Allow a small tolerance (₹1) to account for rounding or currency conversions
        if (amountDiff > 100) {
          const err = new Error('Razorpay amount mismatch');
          err.status = 400;
          err.expectedAmountPaise = expectedAmountPaise;
          err.paidAmountPaise = paidAmountPaise;
          err.amountDiffPaise = amountDiff;
          throw err;
        }

        if (razorpayPaymentDetails?.currency !== expectedCurrency) {
          const err = new Error('Razorpay currency mismatch');
          err.status = 400;
          throw err;
        }

        if (!['authorized', 'captured'].includes(razorpayStatus)) {
          const err = new Error(`Payment status is not successful: ${razorpayStatus || 'unknown'}`);
          err.status = 400;
          throw err;
        }
      }

      // Map frontend payment method to backend payment method
      const paymentMethodMap = {
        'card': 'credit_card',
        'paypal': 'paypal',
        'apple_pay': 'wallet',
        'google_pay': 'wallet'
      };

      const mappedPaymentMethod = paymentMethodMap[paymentMethod] || 'credit_card';

      // Generate transaction ID and invoice ID
      const transactionId = razorpayPaymentId || `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const invoiceId = `INV_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const receiptId = `RCP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // ═══════════════════════════════════════════════════════════════════════════
      // CRITICAL: Find and UPDATE existing canonical payment document.
      // Payment document should already exist from createRazorpayOrder.
      // We MUST NOT create a new payment here — only update the existing one.
      // ═══════════════════════════════════════════════════════════════════════════
      
      let existingPayment = null;
      if (razorpayOrderId || razorpayPaymentId) {
        existingPayment = await Payment.findOne({
          $or: [
            ...(razorpayPaymentId ? [{ razorpayPaymentId }] : []),
            ...(razorpayOrderId ? [{ razorpayOrderId }] : [])
          ]
        }).session(session);
      }

      if (existingPayment) {
        // UPDATE existing payment document
        console.log('📝 Updating existing canonical payment document:', existingPayment._id);
        
        existingPayment.booking = bookingDoc._id;
        existingPayment.user = req.user._id;
        existingPayment.host = host._id;
        existingPayment.amount = totalAmount;
        existingPayment.currency = currency;
        existingPayment.paymentMethod = mappedPaymentMethod;
        existingPayment.paymentDetails = {
          transactionId: transactionId,
          paymentGateway: 'razorpay',
          gatewayResponse: razorpayPaymentDetails
        };
        existingPayment.razorpayPaymentId = razorpayPaymentId || existingPayment.razorpayPaymentId;
        existingPayment.razorpaySignature = razorpaySignature || existingPayment.razorpaySignature;
        existingPayment.subtotal = subtotal;
        existingPayment.taxes = gst;
        existingPayment.gst = gst;
        existingPayment.processingFee = processingFee;
        existingPayment.serviceFee = pricing.serviceFee;
        existingPayment.cleaningFee = pricing.cleaningFee;
        existingPayment.securityDeposit = pricing.securityDeposit;
        existingPayment.discountAmount = pricing.discountAmount || 0;
        existingPayment.commission = {
          platformFee: platformFee,
          hostEarning: hostEarning,
          processingFee: processingFee
        };
        existingPayment.pricingBreakdown = breakdown;
        existingPayment.payout = {
          status: 'pending',
          scheduledDate: bookingType === 'property' ?
            new Date(new Date(checkIn).getTime() + 24 * 60 * 60 * 1000) :
            new Date(Date.now() + 24 * 60 * 60 * 1000),
          amount: hostEarning,
          method: 'bank_transfer',
          reference: `PAYOUT_${Date.now()}`,
          notes: `Payout for booking ${booking.receiptId}`
        };
        existingPayment.invoiceId = invoiceId;
        existingPayment.receiptUrl = `/receipts/${receiptId}`;
        existingPayment.coupon = couponApplied || null;
        existingPayment.status = 'processing';
        existingPayment.metadata = {
          ...existingPayment.metadata,
          idempotencyKey: finalIdempotencyKey,
          userAgent: req.get('User-Agent'),
          ipAddress: req.ip,
          bookingType: bookingType,
          propertyId: actualListingId,
          serviceId: serviceId
        };
        
        // Add timeline entry
        existingPayment.timeline = existingPayment.timeline || [];
        existingPayment.timeline.push({
          event: 'booking_payment_linked',
          message: 'Payment linked to booking during booking creation',
          timestamp: new Date(),
          source: 'system',
          data: { bookingId: bookingDoc._id, razorpayPaymentId }
        });
        
        await existingPayment.save({ session });
        paymentDoc = existingPayment;
        
      } else {
        // FALLBACK: Create new payment only if no existing document found
        console.warn('⚠️ No existing payment found for razorpayOrderId, creating new document');
        
        const payment = await Payment.create([{
          booking: bookingDoc._id,
          user: req.user._id,
          host: host._id,
          amount: totalAmount,
          currency: currency,
          paymentMethod: mappedPaymentMethod,
          paymentDetails: {
            transactionId: transactionId,
            paymentGateway: 'razorpay',
            gatewayResponse: razorpayPaymentDetails
          },
          razorpayOrderId: razorpayOrderId,
          razorpayPaymentId: razorpayPaymentId,
          razorpaySignature: razorpaySignature,
          subtotal: subtotal,
          taxes: gst,
          gst: gst,
          processingFee: processingFee,
          serviceFee: pricing.serviceFee,
          cleaningFee: pricing.cleaningFee,
          securityDeposit: pricing.securityDeposit,
          discountAmount: pricing.discountAmount || 0,
          commission: {
            platformFee: platformFee,
            hostEarning: hostEarning,
            processingFee: processingFee
          },
          pricingBreakdown: breakdown,
          payout: {
            status: 'pending',
            scheduledDate: bookingType === 'property' ?
              new Date(new Date(checkIn).getTime() + 24 * 60 * 60 * 1000) :
              new Date(Date.now() + 24 * 60 * 60 * 1000),
            amount: hostEarning,
            method: 'bank_transfer',
            reference: `PAYOUT_${Date.now()}`,
            notes: `Payout for booking ${booking.receiptId}`
          },
          invoiceId: invoiceId,
          receiptUrl: `/receipts/${receiptId}`,
          coupon: couponApplied || null,
          status: 'processing',
          metadata: {
            idempotencyKey: finalIdempotencyKey,
            userAgent: req.get('User-Agent'),
            ipAddress: req.ip,
            forwardedFor: req.get('X-Forwarded-For'),
            realIp: req.get('X-Real-IP'),
            referer: req.get('Referer'),
            origin: req.get('Origin'),
            timestamp: new Date().toISOString(),
            securityVersion: '1.0',
            sessionId: require('crypto').randomUUID(),
            source: 'web',
            bookingType: bookingType,
            propertyId: actualListingId,
            serviceId: serviceId
          },
          timeline: [{
            event: 'payment_created_fallback',
            message: 'Payment created during booking (no canonical document found)',
            timestamp: new Date(),
            source: 'system',
            data: { razorpayOrderId, razorpayPaymentId }
          }]
        }], { session });
        paymentDoc = payment[0];
      }

      // await payment.save();

      // Step 3: Finalize payment status only after verified gateway proof
      paymentDoc.status = isPaymentVerified ? 'completed' : 'failed';
      paymentDoc.processedAt = new Date();
      await paymentDoc.save({ session });

      if (!isPaymentVerified) {
        const err = new Error('Payment verification failed during booking processing');
        err.status = 400;
        throw err;
      }

      // Step 4: Update booking with payment reference but keep as pending for host approval
      bookingDoc.payment = paymentDoc._id;
      bookingDoc.status = 'pending'; // Keep pending until host approves
      bookingDoc.paymentStatus = 'paid'; // Payment is successful but booking needs host approval
      await bookingDoc.save({ session });

      // Step 4.5: Block availability for the booking dates
      if (bookingType === 'property' && actualListingId) {
        try {
          if (is24HourBooking) {
            // Block time-based availability for 24-hour booking
            console.log('🔒 Blocking 24-hour time slot for booking...');

            await AvailabilityService.blockTimeSlot(
              actualListingId,
              bookingCheckInDateTime,
              bookingCheckOutDateTime,
              bookingDoc._id
            );

            console.log(`✅ Successfully blocked 24-hour time slot: ${bookingCheckInDateTime.toISOString()} to ${bookingCheckOutDateTime.toISOString()}`);
          } else if (checkIn && finalCheckOut) {


            const start = normalizeToLocalMidnight(checkIn);
            const end = normalizeToLocalMidnight(checkOut); // ❗ use checkOut, NOT finalCheckOut

            const datesToBlock = [];
            const current = new Date(start);


            while (current < end) { // ❗ NOT <=
              const dateStr = formatLocalDate(current);
              datesToBlock.push(dateStr);
              console.log(`  → Adding date to block: ${dateStr}`);
              current.setDate(current.getDate() + 1);
            }

            // Add additional dates for hourly extensions if they extend to next day
            if (hourlyExtension && hourlyExtension.hours) {
              const additionalDates = getAdditionalDatesForExtension(
                checkOut,
                hourlyExtension.hours,
                finalCheckOutTime
              );

              additionalDates.forEach(date => {
                const dateStr = date.toISOString().split('T')[0];
                if (!datesToBlock.includes(dateStr)) {
                  datesToBlock.push(dateStr);
                }
              });
            }

            console.log('📅 Property dates to block:', datesToBlock);

            // Create or update availability records for each date
            for (const dateStr of datesToBlock) {
              await Availability.findOneAndUpdate(
                {
                  property: actualListingId,
                  date: new Date(dateStr)
                },
                {
                  property: actualListingId,
                  date: new Date(dateStr),
                  status: 'blocked',
                  reason: 'Booking in progress',
                  blockedBy: req.user._id,
                  blockedAt: new Date()
                },
                { upsert: true, new: true, session },

              );
            }

            console.log(`✅ Successfully blocked ${datesToBlock.length} property dates for booking`);

            // ========================================
            // Mark checkout date as "partially-available"
            // The checkout date should be available for new bookings after checkout time + maintenance
            // ========================================
            const checkoutDateStr = formatLocalDate(normalizeToLocalMidnight(checkOut));
            const maintenanceHrs = listing?.availabilitySettings?.hostBufferTime || 2;

            // Parse checkout time to calculate when property becomes available
            const [checkoutHour, checkoutMinute] = (finalCheckOutTime || '11:00').split(':').map(Number);
            const checkoutDateTime = new Date(checkOut);
            checkoutDateTime.setHours(checkoutHour, checkoutMinute, 0, 0);

            // Calculate maintenance end time (when property becomes available)
            const maintenanceEndTime = new Date(checkoutDateTime.getTime() + maintenanceHrs * 60 * 60 * 1000);

            console.log(`📅 Marking checkout date ${checkoutDateStr} as partially-available`);
            console.log(`   Checkout time: ${finalCheckOutTime}, Maintenance ends: ${maintenanceEndTime.toISOString()}`);

            await Availability.findOneAndUpdate(
              {
                property: actualListingId,
                date: new Date(checkoutDateStr)
              },
              {
                property: actualListingId,
                date: new Date(checkoutDateStr),
                status: 'partially-available',
                reason: `Available after ${maintenanceEndTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`,
                bookedBy: booking._id,
                bookedAt: new Date()
              },
              { upsert: true, new: true, session },

            );

            console.log(`✅ Checkout date ${checkoutDateStr} marked as partially-available`);
          }

          // ========================================
          // NEW: Create AvailabilityEvents for flexible hourly booking with maintenance
          // This creates booking_start, booking_end, maintenance_start, maintenance_end events
          // If this causes issues, comment out this entire block (lines marked NEW)
          // ========================================
          try {
            // Get maintenance hours from property settings (default 2 hours)
            const maintenanceHours = listing?.availabilitySettings?.hostBufferTime || 2;

            // Calculate actual checkout time with any hourly extension
            let actualCheckOut = new Date(finalCheckOut);
            if (hourlyExtension && hourlyExtension.hours) {
              // Extension already applied to finalCheckOut
              console.log(`🕐 Hourly extension of ${hourlyExtension.hours} hours applied`);
            }

            // Create availability events
            const eventResult = await AvailabilityEventService.createBookingEvents({
              propertyId: actualListingId,
              bookingId: booking._id,
              userId: req.user._id,
              checkIn: new Date(checkIn),
              checkOut: actualCheckOut,
              maintenanceHours: maintenanceHours
            }, { session });

            if (eventResult.success) {
              console.log(`✅ Created ${eventResult.events.length} availability events`);
              console.log(`⏰ Next available time: ${eventResult.nextAvailableTime.toISOString()}`);

              // Update booking with next available time
              bookingDoc.nextAvailableTime = eventResult.nextAvailableTime;
              await bookingDoc.save();
            }
          } catch (eventError) {
            console.error('⚠️ Error creating availability events:', eventError);
            // Don't fail the booking if event creation fails - old system still works
          }
          // ========================================
          // END NEW: AvailabilityEvents
          // ========================================

        } catch (availabilityError) {
          console.error('⚠️ Error blocking property availability:', availabilityError);
          // Don't fail the booking if availability blocking fails
          // The booking can still proceed, but dates won't be blocked
        }

        // ========================================
        // NEW: Update availability from 'blocked' to 'booked' after successful payment
        // ========================================
        try {
          console.log('🔄 Updating availability status from "blocked" to "booked"...');

          // Use the SAME logic as blocking section to ensure we match the exact dates
          const start = normalizeToLocalMidnight(checkIn);
          const end = normalizeToLocalMidnight(checkOut); // Use checkOut, same as blocking

          const datesToUpdate = [];
          const current = new Date(start);

          while (current < end) {
            const dateStr = formatLocalDate(current); // Use formatLocalDate to match blocking format
            datesToUpdate.push(new Date(dateStr)); // Convert to Date object matching blocking format
            current.setDate(current.getDate() + 1);
          }

          // Add additional dates for hourly extensions if they extend to next day (same as blocking)
          if (hourlyExtension && hourlyExtension.hours) {
            const additionalDates = getAdditionalDatesForExtension(
              checkOut,
              hourlyExtension.hours,
              finalCheckOutTime
            );

            additionalDates.forEach(date => {
              const dateStr = date.toISOString().split('T')[0];
              const dateObj = new Date(dateStr);
              if (!datesToUpdate.some(d => d.toISOString().split('T')[0] === dateStr)) {
                datesToUpdate.push(dateObj);
              }
            });
          }

          console.log(`📅 Dates to update to booked:`, datesToUpdate.map(d => formatLocalDate(d)));

          // Update all blocked dates to booked
          // Use $in with date strings converted to Date objects, matching the blocking format
          const updateResult = await Availability.updateMany(
            {
              property: actualListingId,
              date: { $in: datesToUpdate },
              status: 'blocked'
            },
            {
              $set: {
                status: 'booked',
                reason: 'Confirmed booking',
                bookedBy: bookingDoc._id,
                bookedAt: new Date()
              },
              $unset: {
                blockedBy: 1,
                blockedAt: 1
              }
            },
            { session }

          );

          console.log(`✅ Successfully updated ${updateResult.modifiedCount} dates from "blocked" to "booked"`);

          // Debug: Check if dates exist but weren't updated
          if (updateResult.modifiedCount === 0) {
            const existingBlocked = await Availability.find({
              property: actualListingId,
              date: { $in: datesToUpdate },
              status: 'blocked'
            }, { session });
            console.log(`⚠️ Found ${existingBlocked.length} blocked dates but updated 0. Dates in DB:`,
              existingBlocked.map(a => ({ date: a.date, status: a.status })));

            // Try alternative query with date range
            const dateStrings = datesToUpdate.map(d => formatLocalDate(d));
            const alternativeResult = await Availability.updateMany(
              {
                property: actualListingId,
                $expr: {
                  $in: [
                    { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
                    dateStrings
                  ]
                },
                status: 'blocked'
              },
              {
                $set: {
                  status: 'booked',
                  reason: 'Confirmed booking',
                  bookedBy: booking._id,
                  bookedAt: new Date()
                },
                $unset: {
                  blockedBy: 1,
                  blockedAt: 1
                }
              },
              { session }
            );
            console.log(`🔄 Alternative query updated ${alternativeResult.modifiedCount} dates`);
          }
        } catch (updateError) {
          console.error('⚠️ Error updating availability status to booked:', updateError);
          // Don't fail the booking if status update fails
        }
        // ========================================
      }

      // ========================================
      // Step 4.6: Mark the booked service slot as unavailable
      // Services store their slots directly in service.availableSlots.
      // After a successful payment we must flip the matching slot to
      // isAvailable=false / status='booked' so it disappears from the
      // booking calendar for other users.
      // ========================================
      if (bookingType === 'service' && serviceId && timeSlot) {
        try {
          const slotStart = timeSlot.startTime ? new Date(timeSlot.startTime) : null;
          const slotEnd   = timeSlot.endTime   ? new Date(timeSlot.endTime)   : null;

          if (slotStart && slotEnd) {
            // Find the service (already loaded above) and update the exact slot
            const slotUpdateResult = await Service.updateOne(
              {
                _id: serviceId,
                'availableSlots': {
                  $elemMatch: {
                    startTime: slotStart,
                    endTime:   slotEnd,
                  }
                }
              },
              {
                $set: {
                  'availableSlots.$[slot].isAvailable': false,
                  'availableSlots.$[slot].status': 'booked',
                }
              },
              {
                arrayFilters: [
                  {
                    'slot.startTime': slotStart,
                    'slot.endTime':   slotEnd,
                  }
                ],
                session,
              }
            );

            console.log(`✅ Service slot marked as booked: ${slotStart.toISOString()} – ${slotEnd.toISOString()} | modified: ${slotUpdateResult.modifiedCount}`);

            if (slotUpdateResult.modifiedCount === 0) {
              // Fallback: match by startTime only (endTime timezone drift tolerance)
              const fallbackResult = await Service.updateOne(
                { _id: serviceId },
                {
                  $set: {
                    'availableSlots.$[slot].isAvailable': false,
                    'availableSlots.$[slot].status': 'booked',
                  }
                },
                {
                  arrayFilters: [{ 'slot.startTime': slotStart }],
                  session,
                }
              );
              console.log(`🔄 Fallback slot update: modified ${fallbackResult.modifiedCount}`);
            }
          }
        } catch (slotErr) {
          console.error('⚠️ Error marking service slot as booked:', slotErr);
          // Non-fatal — booking has already been created and payment collected.
        }
      }
      // ========================================

      // Step 5: Create notification for host
      await Notification.create({
        user: host._id,
        type: 'booking',
        title: 'New Booking Request',
        message: `You have a new booking request from ${req.user.name}. Please review and accept or decline.`,
        relatedEntity: {
          type: 'Booking',
          id: bookingDoc._id
        }
      });



      // Step 6: Send confirmation emails
      try {
        // Send confirmation email to user
        await sendBookingConfirmationEmail(req.user.email, req.user.name, {
          bookingId: bookingDoc._id,
          propertyName: listing?.title || service?.title,
          checkIn: bookingDoc.checkIn ? new Date(bookingDoc.checkIn).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }) : new Date(bookingDoc.timeSlot?.startTime).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),
          checkOut: bookingDoc.checkOut ? new Date(bookingDoc.checkOut).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }) : new Date(bookingDoc.timeSlot?.endTime).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),
          checkInTime: bookingDoc.checkInTime,
          checkOutTime: bookingDoc.checkOutTime,
          hourlyExtension: bookingDoc.hourlyExtension?.hours,
          guests: `${bookingDoc.guests.adults} adults${bookingDoc.guests.children > 0 ? `, ${bookingDoc.guests.children} children` : ''}${bookingDoc.guests.infants > 0 ? `, ${bookingDoc.guests.infants} infants` : ''}`,
          totalAmount: bookingDoc.totalAmount.toLocaleString(),
          currency: bookingDoc.currency,
          status: 'pending' // Indicate that booking is pending host approval
        });

        // Send notification email to host
        await sendBookingConfirmationEmail(host.email, host.name, {
          bookingId: bookingDoc._id,
          guestName: req.user.name,
          propertyName: listing?.title || service?.title,
          checkIn: bookingDoc.checkIn ? new Date(bookingDoc.checkIn).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }) : new Date(bookingDoc.timeSlot?.startTime).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),
          checkOut: bookingDoc.checkOut ? new Date(bookingDoc.checkOut).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }) : new Date(bookingDoc.timeSlot?.endTime).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),
          checkInTime: bookingDoc.checkInTime,
          checkOutTime: bookingDoc.checkOutTime,
          hourlyExtension: bookingDoc.hourlyExtension?.hours,
          guests: `${bookingDoc.guests.adults} adults${bookingDoc.guests.children > 0 ? `, ${bookingDoc.guests.children} children` : ''}${bookingDoc.guests.infants > 0 ? `, ${bookingDoc.guests.infants} infants` : ''}`,
          totalAmount: bookingDoc.totalAmount.toLocaleString(),
          currency: bookingDoc.currency
        });
      } catch (emailError) {
        console.error('Email sending failed:', emailError);
        // Don't fail the booking if email fails
      }

      // ========================================
      // Step 7: Create Payout record for the host
      // This creates a Payout document in the Payout collection so the
      // admin can see it in the Host Payouts tab and confirm payment.
      // ========================================
      try {
        const payoutScheduledDate = bookingType === 'property' && checkIn
          ? new Date(new Date(checkIn).getTime() + 24 * 60 * 60 * 1000) // 24h after check-in for properties
          : new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h from now for services

        const hostPayoutAmount = hostEarning || paymentDoc.commission?.hostEarning || 0;

        await Payout.create([{
          host: host._id,
          payment: paymentDoc._id,
          booking: bookingDoc._id,
          amount: hostPayoutAmount,
          currency: bookingDoc.currency || 'INR',
          status: 'pending',
          method: 'bank_transfer',
          scheduledDate: payoutScheduledDate,
          fees: {
            processingFee: 0,
            taxDeduction: 0,
            netAmount: hostPayoutAmount
          },
          notes: `Auto-scheduled payout for booking ${bookingDoc.receiptId || bookingDoc._id}`
        }], { session });

        console.log(`✅ Host payout record created: ₹${hostPayoutAmount} for host ${host._id}`);
      } catch (payoutErr) {
        console.error('⚠️ Failed to create payout record (non-fatal):', payoutErr.message);
        // Non-fatal: booking and payment are already created
      }

      amount = totalAmount;
    });

    res.status(201).json({
      success: true,
      message: is24HourBooking ? '24-hour booking created and payment processed successfully' : 'Booking request created and payment processed successfully',
      data: {
        bookingDoc,
        paymentDoc,
        // 24-hour booking specific data
        ...(is24HourBooking && {
          checkInDateTime: bookingCheckInDateTime,
          checkOutDateTime: bookingCheckOutDateTime,
          totalHours: totalHours,
          extensionHours: extensionHours || 0,
          nextAvailableTime: nextAvailableTime,
          hostBufferTime: hostBufferTime
        }),
        message: is24HourBooking
          ? `24-hour booking confirmed! Payment of ₹${amount} processed successfully. Check-in: ${bookingCheckInDateTime.toLocaleString()}, Check-out: ${bookingCheckOutDateTime.toLocaleString()}.`
          : `Booking request submitted! Payment of ₹${amount} processed successfully. The host will review your request and confirm within 24 hours.`
      }
    });

  } catch (error) {
    console.error('❌ ===========================================');
    const { logger } = require('../config/logger');
    logger.error('Error in processPaymentAndCreateBooking', { error: error.message });

    if (error.name === 'ValidationError' || error.status === 400) {
      return res.status(400).json({
        success: false,
        message: error.message || 'Validation error'
      });
    }
    if (error.message === 'IDEMPOTENCY_CONFLICT') {
      return res.status(409).json({
        success: false,
        message: 'Booking with this idempotency key already exists',
        bookingId: error.bookingId
      });
    }
    if (error.status === 400 || error.status === 404) {
      return res.status(error.status).json({
        success: false,
        message: error.message,
        errors: error.errors
      });
    }


    res.status(500).json({
      success: false,
      message: 'Failed to process payment and create booking',
      error: error.message
    });
  }
  finally {
    if (session) await session.endSession();
  }
};

// @desc    Create new booking (legacy - for backward compatibility)
// @route   POST /api/bookings
// @access  Private
const createBooking = async (req, res) => {
  try {
    const {
      propertyId, // frontend may send this
      listingId, // frontend may send this
      serviceId,
      checkIn,
      checkOut,
      checkInTime,
      checkOutTime,
      timeSlot,
      guests,
      specialRequests,
      couponCode,
      hourlyExtension
    } = req.body;

    // Determine if this is a property or service booking
    const actualListingId = listingId || propertyId;
    let listing = null;
    let service = null;
    let host = null;
    let bookingType = '';
    let currency = 'INR';
    let cancellationPolicy = 'moderate';

    if (actualListingId && serviceId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot book both listing and service in one booking'
      });
    }
    if (!actualListingId && !serviceId) {
      return res.status(400).json({
        success: false,
        message: 'Either listingId/propertyId or serviceId is required'
      });
    }

    // Get listing or service details
    if (actualListingId) {
      listing = await Property.findById(actualListingId);
      if (!listing) {
        return res.status(404).json({ success: false, message: 'Listing not found' });
      }
      host = await User.findById(listing.host).session(session);
      bookingType = 'property';
      currency = listing.pricing.currency || 'INR';
      cancellationPolicy = listing.cancellationPolicy || 'moderate';
    } else {
      service = await Service.findById(serviceId);
      if (!service) {
        return res.status(404).json({ success: false, message: 'Service not found' });
      }
      host = await User.findById(service.provider);
      bookingType = 'service';
      currency = service.pricing.currency || 'INR';
      cancellationPolicy = service.cancellationPolicy || 'moderate';
    }

    // Validate dates/times
    if (bookingType === 'property') {
      if (!checkIn || !checkOut) {
        return res.status(400).json({ success: false, message: 'Check-in and check-out dates are required for property bookings' });
      }

      const checkInDate = new Date(checkIn);
      const checkOutDate = new Date(checkOut);

      if (checkInDate >= checkOutDate) {
        return res.status(400).json({ success: false, message: 'Check-out date must be after check-in date' });
      }
      // Check minimum nights
      const nights = Math.ceil((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24));
      if (nights < listing.minNights) {
        return res.status(400).json({ success: false, message: `Minimum ${listing.minNights} nights required` });
      }
      // Note: Availability is checked separately by the availability controller
      // This ensures proper separation of concerns
    } else {
      if (!timeSlot || !timeSlot.startTime || !timeSlot.endTime) {
        return res.status(400).json({ success: false, message: 'Time slot is required for service bookings' });
      }
    }

    // Handle guests
    let guestDetails = { adults: 1, children: 0, infants: 0 };
    if (typeof guests === 'number') {
      guestDetails = { adults: guests, children: 0, infants: 0 };
    } else if (typeof guests === 'object' && guests !== null) {
      guestDetails = {
        adults: guests.adults || 1,
        children: guests.children || 0,
        infants: guests.infants || 0
      };
    }

    // Calculate pricing using centralized pricing system
    let pricingParams = {
      basePrice: 0,
      nights: 1,
      cleaningFee: 0,
      serviceFee: 0,
      securityDeposit: 0,
      extraGuestPrice: 0,
      extraGuests: 0,
      hourlyExtension: 0,
      discountAmount: 0,
      currency: currency
    };

    if (bookingType === 'property') {
      pricingParams.basePrice = listing.pricing.basePrice;
      pricingParams.extraGuestPrice = listing.pricing.extraGuestPrice || 0;
      pricingParams.cleaningFee = listing.pricing.cleaningFee || 0;
      pricingParams.serviceFee = listing.pricing.serviceFee || 0; // Use property's service fee or 0
      pricingParams.securityDeposit = listing.pricing.securityDeposit || 0;
      // Calculate nights properly for accommodation bookings
      // Count actual nights stayed (Nov 1 to Nov 5 = 4 nights)
      const checkInDate = new Date(checkIn);
      const checkOutDate = new Date(checkOut);

      // Strip time components to get date-only comparison
      const checkInDateOnly = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate());
      const checkOutDateOnly = new Date(checkOutDate.getFullYear(), checkOutDate.getMonth(), checkOutDate.getDate());

      const diffTime = checkOutDateOnly - checkInDateOnly;
      const diffDays = diffTime / (1000 * 60 * 60 * 24);
      pricingParams.nights = Math.max(0, diffDays);
      pricingParams.extraGuests = guestDetails.adults > 1 ? guestDetails.adults - 1 : 0;

      // Add hourly extension cost if applicable
      if (hourlyExtension && hourlyExtension.hours && listing.hourlyBooking?.enabled) {
        pricingParams.hourlyExtension = calculateHourlyExtension(listing.pricing.basePrice, hourlyExtension.hours);
        console.log(`🕐 Hourly extension calculated: ${hourlyExtension.hours} hours = ₹${pricingParams.hourlyExtension}`);
      }
    } else {
      pricingParams.basePrice = service.pricing.basePrice;
      pricingParams.serviceFee = service.pricing.serviceFee || 0;
      pricingParams.extraGuests = guestDetails.adults > 1 ? guestDetails.adults - 1 : 0;
      pricingParams.extraGuestPrice = service.pricing.perPersonPrice || 0;
    }

    // Apply coupon if provided
    let couponApplied = null;
    if (couponCode) {
      const coupon = await Coupon.findOne({
        code: couponCode.toUpperCase(),
        isActive: true,
        validFrom: { $lte: new Date() },
        validTo: { $gte: new Date() }
      });
      if (coupon) {
        // Check if user has already used this coupon
        const hasUsed = coupon.usedBy?.some(usage => usage.user.toString() === req.user._id.toString());
        if (!hasUsed) {
          // Calculate subtotal first to apply coupon discount
          const tempPricing = await calculatePricingBreakdown(pricingParams);
          let discountAmount = 0;

          if (coupon.discountType === 'percentage') {
            discountAmount = (tempPricing.subtotal * coupon.amount) / 100;
            if (coupon.maxDiscount) {
              discountAmount = Math.min(discountAmount, coupon.maxDiscount);
            }
          } else {
            discountAmount = coupon.amount;
          }
          if (coupon.minBookingAmount && tempPricing.subtotal < coupon.minBookingAmount) {
            discountAmount = 0;
          }

          pricingParams.discountAmount = discountAmount;
          couponApplied = coupon._id;
          coupon.usedCount += 1;
          coupon.usedBy.push({ user: req.user._id, usedAt: new Date() });
          await coupon.save();
        }
      }
    }

    // Calculate final pricing breakdown using unified utilities
    const pricing = await calculatePricingBreakdown(pricingParams);

    // Extract values for backward compatibility
    const {
      subtotal,
      platformFee,
      totalAmount,
      hostEarning,
      gst,
      processingFee,
      breakdown
    } = pricing;

    // Create booking
    const booking = await Booking.create({
      user: req.user._id,
      host: host._id,
      listing: bookingType === 'property' ? actualListingId : undefined,
      service: bookingType === 'service' ? serviceId : undefined,
      bookingType,
      status: 'pending',
      checkIn: bookingType === 'property' ? checkIn : undefined,
      checkOut: bookingType === 'property' ? checkOut : undefined,
      checkInTime: checkInTime || (bookingType === 'property' ? (listing.checkInTime || '11:00') : undefined),
      checkOutTime: checkOutTime || (bookingType === 'property' ? (listing.checkOutTime || '10:00') : undefined),
      timeSlot: bookingType === 'service' ? timeSlot : undefined,
      guests: guestDetails,
      totalAmount,
      subtotal: subtotal,
      taxAmount: gst,
      serviceFee: pricing.serviceFee,
      cleaningFee: pricing.cleaningFee,
      securityDeposit: pricing.securityDeposit,
      currency,
      cancellationPolicy,
      specialRequests: specialRequests || undefined,
      hourlyExtension: hourlyExtension,
      contactInfo: req.body.contactInfo,
      paymentStatus: 'pending',
      refundAmount: 0,
      refunded: false,
      couponApplied,
      discountAmount: pricing.discountAmount,
      hostFee: hostEarning,
      platformFee: platformFee,
      processingFee: processingFee,
      gst: gst,
      // Store complete pricing breakdown
      pricingBreakdown: breakdown
    });

    // Create notification for host
    await Notification.create({
      user: host._id,
      type: 'booking',
      title: 'New Booking Request',
      message: `You have a new booking request from ${req.user.name}`,
      relatedEntity: {
        type: 'Booking',
        id: booking._id
      },
      metadata: { bookingId: booking._id }
    });

    // Send email notification to host
    try {
      const bookingDetails = {
        propertyName: listing ? listing.title : service.title,
        guestName: req.user.name,
        checkIn: actualListingId ? new Date(checkIn).toLocaleDateString() : new Date(timeSlot.startTime).toLocaleDateString(),
        checkOut: actualListingId ? new Date(checkOut).toLocaleDateString() : new Date(timeSlot.endTime).toLocaleDateString(),
        guests: `${guestDetails.adults} adults${guestDetails.children > 0 ? `, ${guestDetails.children} children` : ''}${guestDetails.infants > 0 ? `, ${guestDetails.infants} infants` : ''}`,
        totalAmount: totalAmount.toLocaleString(),
        bookingId: booking._id.toString(),
        specialRequests: specialRequests || null
      };

      await sendBookingConfirmationEmail(host.email, host.name, bookingDetails);
    } catch (emailError) {
      console.error('Error sending email notification:', emailError);
      // Don't fail the booking if email fails
    }

    // Send confirmation email to guest
    try {
      const guestBookingDetails = {
        propertyName: listing ? listing.title : service.title,
        checkIn: actualListingId ? new Date(checkIn).toLocaleDateString() : new Date(timeSlot.startTime).toLocaleDateString(),
        checkOut: actualListingId ? new Date(checkOut).toLocaleDateString() : new Date(timeSlot.endTime).toLocaleDateString(),
        guests: `${guestDetails.adults} adults${guestDetails.children > 0 ? `, ${guestDetails.children} children` : ''}${guestDetails.infants > 0 ? `, ${guestDetails.infants} infants` : ''}`,
        totalAmount: totalAmount.toLocaleString(),
        bookingId: booking._id.toString()
      };

      await sendBookingConfirmationEmail(req.user.email, req.user.name, guestBookingDetails);
    } catch (emailError) {
      console.error('Error sending confirmation email:', emailError);
      // Don't fail the booking if email fails
    }



    res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      data: { booking }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating booking',
      error: error.message
    });
  }
};

// @desc    Get user's bookings
// @route   GET /api/bookings/my-bookings
// @access  Private
const getMyBookings = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;

    const query = { user: req.user._id };
    if (status) {
      query.status = status;
    }

    const bookings = await Booking.find(query)
      .populate('listing', 'title images location propertyType')
      .populate('service', 'title media')
      .populate('host', 'name profileImage')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Booking.countDocuments(query);

    // Map listing to propertyId for frontend compatibility
    const bookingsWithPropertyId = bookings.map(booking => {
      const obj = booking.toObject();
      obj.propertyId = obj.listing || null;
      // Ensure images is an array of URLs for frontend compatibility
      if (obj.propertyId && Array.isArray(obj.propertyId.images)) {
        obj.propertyId.images = obj.propertyId.images.map(img => img.url || img);
      }
      return obj;
    });

    res.status(200).json({
      success: true,
      data: {
        bookings: bookingsWithPropertyId,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalItems: total,
          itemsPerPage: limit
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching bookings',
      error: error.message
    });
  }
};

// @desc    Get host's bookings
// @route   GET /api/bookings/host-bookings
// @access  Private
const getHostBookings = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;

    const query = { host: req.user._id };
    if (status) {
      query.status = status;
    }

    const bookings = await Booking.find(query)
      .populate('listing', 'title images location pricing')
      .populate('service', 'title media pricing')
      .populate('user', 'name email phone profileImage')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();



    const total = await Booking.countDocuments(query);

    // Map listing images to URLs for frontend compatibility
    const bookingsWithImageUrls = bookings.map(booking => {
      const obj = booking.toObject();
      if (obj.listing && Array.isArray(obj.listing.images)) {
        obj.listing.images = obj.listing.images.map(img => img.url || img);
      }
      if (obj.service && Array.isArray(obj.service.media)) {
        obj.service.media = obj.service.media.map(media => media.url || media);
      }
      return obj;
    });

    res.status(200).json({
      success: true,
      data: {
        bookings: bookingsWithImageUrls,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalItems: total,
          itemsPerPage: limit
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching host bookings',
      error: error.message
    });
  }
};

// @desc    Get single booking
// @route   GET /api/bookings/:id
// @access  Private
const getBooking = async (req, res) => {
  try {
    const { id } = req.params;

    const booking = await Booking.findById(id)
      .populate('listing', 'title images description location propertyType amenities cancellationPolicy checkInTime checkOutTime bedrooms bathrooms maxGuests pricing')
      .populate('service', 'title media description pricing cancellationPolicy')
      .populate('user', 'name email profileImage')
      .populate('host', 'name email profileImage about responseTime')
      .populate('couponApplied', 'code discountType amount')
      .populate('payment', 'amount status paymentMethod paidAt transactionId')
      .exec();

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Check authorization - user can view if they are the guest, host, or admin
    const isGuest = booking.user && booking.user._id.toString() === req.user._id.toString();
    const isHost = booking.host && booking.host._id.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';

    if (!isGuest && !isHost && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to view this booking'
      });
    }



    // Calculate fee breakdown for display (fallback for legacy bookings)
    const feeBreakdown = {
      baseAmount: booking.totalAmount + booking.discountAmount,
      serviceFee: booking.serviceFee,
      cleaningFee: booking.cleaningFee,
      securityDeposit: booking.securityDeposit,
      platformFee: booking.platformFee,
      hostEarning: booking.hostFee,
      discountAmount: booking.discountAmount,
      totalAmount: booking.totalAmount
    };

    res.status(200).json({
      success: true,
      data: {
        booking,
        feeBreakdown
      }
    });
  } catch (error) {
    console.error('Error fetching booking:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching booking',
      error: error.message
    });
  }
};

// @desc    Download booking receipt
// @route   GET /api/bookings/:id/receipt
// @access  Private
const downloadReceipt = async (req, res) => {
  try {
    const { id } = req.params;

    const booking = await Booking.findById(id)
      .populate('listing', 'title images description location pricing cancellationPolicy checkInTime checkOutTime')
      .populate('service', 'title media description pricing cancellationPolicy')
      .populate('user', 'name email profileImage')
      .populate('host', 'name email profileImage')
      .populate('couponApplied', 'code discountType amount')
      .populate('payment', 'amount status paymentMethod')
      .exec();

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Check authorization - user can download if they are the guest, host, or admin
    const isGuest = booking.user && booking.user._id.toString() === req.user._id.toString();
    const isHost = booking.host && booking.host._id.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';

    if (!isGuest && !isHost && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to download this receipt'
      });
    }

    // Generate receipt
    const receipt = generateReceipt(booking, booking.payment);
    const receiptHTML = generateReceiptHTML(receipt);

    // Set response headers for PDF download
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${booking.receiptId}.html"`);

    res.send(receiptHTML);
  } catch (error) {
    console.error('Error generating receipt:', error);
    res.status(500).json({
      success: false,
      message: 'Error generating receipt',
      error: error.message
    });
  }
};

// @desc    Accept booking request (host only)
// @route   PUT /api/bookings/:id/accept
// @access  Private (Host only)
const acceptBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body; // Optional message from host

    const booking = await Booking.findById(id)
      .populate('user', 'name email profileImage')
      .populate('host', 'name email profileImage')
      .populate('listing', 'title images')
      .populate('service', 'title images')
      .populate('payment', 'amount status paymentMethod');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Check if user is the host
    if (booking.host._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only the host can accept bookings.'
      });
    }

    // Check if booking is in pending status
    if (booking.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Cannot accept booking. Current status: ${booking.status}`
      });
    }

    // Update booking status to confirmed
    booking.status = 'confirmed';
    booking.confirmedAt = new Date();
    if (message) {
      booking.hostMessage = message;
    }
    await booking.save();

    // Create notification for guest
    await Notification.create({
      user: booking.user._id,
      type: 'booking',
      title: 'Booking Confirmed!',
      message: `Your booking request has been accepted by ${booking.host.name}.`,
      relatedEntity: {
        type: 'Booking',
        id: booking._id
      }
    });

    // Send confirmation email to guest
    try {
      await sendHostConfirmedBookingEmail(booking.user.email, {
        bookingId: booking._id,
        propertyName: booking.listing?.title || booking.service?.title,
        hostName: booking.host.name,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        totalAmount: booking.totalAmount,
        currency: booking.currency,
        hostMessage: message
      });
    } catch (emailError) {
      console.error('Email sending failed:', emailError);
    }

    res.json({
      success: true,
      message: 'Booking accepted successfully',
      data: { booking }
    });

  } catch (error) {
    console.error('Error accepting booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to accept booking',
      error: error.message
    });
  }
};

// @desc    Reject booking request (host only)
// @route   PUT /api/bookings/:id/reject
// @access  Private (Host only)
const rejectBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, message } = req.body; // Reason and optional message from host

    const booking = await Booking.findById(id)
      .populate('user', 'name email profileImage')
      .populate('host', 'name email profileImage')
      .populate('listing', 'title images')
      .populate('service', 'title images')
      .populate('payment', 'amount status paymentMethod');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Check if user is the host
    if (booking.host._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only the host can reject bookings.'
      });
    }

    // Check if booking is in pending status
    if (booking.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Cannot reject booking. Current status: ${booking.status}`
      });
    }

    // Update booking status to cancelled
    booking.status = 'cancelled';
    booking.cancelledAt = new Date();
    booking.cancellationReason = reason || 'Host rejected the booking';
    booking.cancelledBy = 'host';
    if (message) {
      booking.hostMessage = message;
    }

    // Process full refund since booking was cancelled before host approval
    try {
      console.log('🔄 ===========================================');
      console.log('🔄 HOST CANCELLATION - REFUND PROCESSING');
      console.log('🔄 ===========================================');
      console.log('📋 Booking ID:', booking._id);
      console.log('👤 Guest:', booking.user?.name || booking.user?.email || 'Unknown');
      console.log('🏠 Host:', booking.host?.name || booking.host?.email || 'Unknown');
      console.log('💰 Booking Amount:', booking.totalAmount, booking.currency || 'INR');
      console.log('📅 Booking Status:', booking.status);
      console.log('💳 Payment ID:', booking.payment?._id);
      console.log('💳 Razorpay Payment ID:', booking.payment?.razorpayPaymentId || 'N/A');
      console.log('🔄 ===========================================');

      const refund = await RefundService.processRefund(
        booking._id,
        'host_cancel',
        'full',
        {
          userNotes: `Booking rejected by host: ${reason}`,
          adminNotes: `Host rejection - ${message || 'No additional message'}`
        }
      );

      console.log('✅ ===========================================');
      console.log('✅ REFUND PROCESSED SUCCESSFULLY');
      console.log('✅ ===========================================');
      console.log('📋 Refund ID:', refund._id);
      console.log('📋 Refund Reference:', refund.refundReference);
      console.log('💰 Refund Amount:', refund.amount, refund.currency);
      console.log('💳 Razorpay Refund ID:', refund.razorpayRefundId || 'N/A');
      console.log('📊 Refund Status:', refund.status);
      console.log('✅ ===========================================');

      // Update booking with refund details from RefundService
      booking.refundAmount = refund.amount;
      booking.refunded = refund.amount > 0;
      booking.refundStatus = mapRefundStatusToBooking(refund.status);
      booking.paymentStatus = 'refunded';
    } catch (refundError) {
      console.error('❌ Error processing refund for rejected booking:', refundError);
      // Still update booking status even if refund fails
      booking.refundAmount = booking.totalAmount;
      booking.refunded = true;
      booking.refundStatus = 'pending';
      booking.paymentStatus = 'refunded';
    }

    await booking.save();

    // ========================================
    // FIXED: Release dates back to availability system when host rejects
    // ========================================
    if (booking.listing && booking.checkIn && booking.checkOut) {
      try {
        console.log('🔄 [Host Reject] Releasing property dates back to availability system...');

        // Generate array of dates to release (normalize to midnight)
        const startDate = new Date(booking.checkIn);
        startDate.setHours(0, 0, 0, 0);
        const endDate = new Date(booking.checkOut);
        endDate.setHours(23, 59, 59, 999);
        const datesToRelease = [];

        let currentDate = new Date(startDate);
        while (currentDate <= endDate) {
          const dateStr = currentDate.toISOString().split('T')[0];
          datesToRelease.push(dateStr);
          currentDate.setDate(currentDate.getDate() + 1);
        }

        console.log('📅 [Host Reject] Property dates to release:', datesToRelease);

        // Update availability records - mark as available
        const updateResult = await Availability.updateMany(
          {
            property: booking.listing._id || booking.listing,
            date: { $in: datesToRelease.map(d => new Date(d)) },
            status: { $in: ['booked', 'blocked'] }
          },
          {
            $set: {
              status: 'available',
              bookedBy: null,
              bookedAt: null,
              blockedBy: null,
              blockedAt: null,
              reason: null
            }
          }
        );

        console.log(`✅ [Host Reject] Successfully released ${updateResult.modifiedCount} property dates`);

        // Also delete any AvailabilityEvents for this booking
        try {
          await AvailabilityEventService.deleteBookingEvents(booking._id);
          console.log('✅ [Host Reject] Deleted availability events for booking');
        } catch (eventError) {
          console.error('⚠️ Error deleting availability events:', eventError);
        }

      } catch (availabilityError) {
        console.error('❌ [Host Reject] Error releasing property dates:', availabilityError);
        // Don't fail the rejection if date release fails
      }
    }
    // ========================================
    // END FIXED
    // ========================================

    // Create notification for guest
    await Notification.create({
      user: booking.user._id,
      type: 'booking',
      title: 'Booking Request Declined',
      message: `Your booking request has been declined by ${booking.host.name}. Full refund will be processed.`,
      relatedEntity: {
        type: 'Booking',
        id: booking._id
      }
    });

    // Send rejection email to guest (non-blocking - refund already processed)
    try {
      console.log('📧 Sending cancellation email to guest...');
      await sendHostCancelledBookingEmail(booking.user.email, {
        bookingId: booking._id,
        propertyName: booking.listing?.title || booking.service?.title,
        hostName: booking.host.name,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        totalAmount: booking.totalAmount,
        currency: booking.currency,
        reason: reason || 'Host rejected the booking',
        hostMessage: message,
        refundAmount: booking.refundAmount
      });
      console.log('✅ Cancellation email sent successfully');
    } catch (emailError) {
      console.error('⚠️ ===========================================');
      console.error('⚠️ EMAIL SENDING FAILED (Non-blocking)');
      console.error('⚠️ ===========================================');
      console.error('⚠️ Note: Refund has already been processed successfully');
      console.error('⚠️ Email error does not affect refund processing');
      console.error('⚠️ Error:', emailError.message);
      console.error('⚠️ ===========================================');
      // Email failure doesn't affect the refund - it's already processed
    }

    res.json({
      success: true,
      message: 'Booking rejected successfully. Full refund will be processed.',
      data: { booking }
    });

  } catch (error) {
    console.error('Error rejecting booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject booking',
      error: error.message
    });
  }
};

// @desc    Update booking status (confirm/cancel)
// @route   PUT /api/bookings/:id/status
// @access  Private
const updateBookingStatus = async (req, res) => {
  try {
    console.log('🔄 ===========================================');
    console.log('🔄 updateBookingStatus called');
    console.log('🔄 ===========================================');
    console.log('📋 Booking ID:', req.params.id);
    console.log('📝 New Status:', req.body.status);
    console.log('📝 Reason:', req.body.reason || 'N/A');
    console.log('👤 User ID:', req.user._id);
    console.log('👤 User Role:', req.user.role);
    console.log('🔄 ===========================================');

    const { id } = req.params;
    const { status, reason } = req.body;

    const booking = await Booking.findById(id)
      .populate('user', 'name email')
      .populate('host', 'name email')
      .populate('payment');

    if (!booking) {
      console.error('❌ Booking not found:', id);
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    console.log('✅ Booking found:', booking._id);
    console.log('📅 Current Status:', booking.status);
    console.log('👤 Guest:', booking.user?.name || booking.user?.email || 'Unknown');
    console.log('🏠 Host:', booking.host?.name || booking.host?.email || 'Unknown');
    console.log('🔍 Debug - booking.host:', booking.host);
    console.log('🔍 Debug - booking.host._id:', booking.host?._id);
    console.log('🔍 Debug - booking.host (raw):', JSON.stringify(booking.host));
    console.log('🔍 Debug - req.user._id:', req.user._id);

    // Check authorization - handle both populated and non-populated cases
    const hostId = booking.host?._id ? booking.host._id.toString() : booking.host?.toString();
    const userId = booking.user?._id ? booking.user._id.toString() : booking.user?.toString();
    const currentUserId = req.user._id.toString();

    const isHost = hostId === currentUserId;
    const isGuest = userId === currentUserId;
    const isAdmin = req.user.role === 'admin' || req.user.role === 'super-admin';


    if (!isHost && !isGuest && !isAdmin) {
      console.error('❌ Not authorized to update booking');
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this booking'
      });
    }

    // Validate status transition with role-based restrictions
    const validTransitions = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['completed', 'cancelled'],
      completed: [],
      cancelled: [],
      expired: []
    };

    if (!validTransitions[booking.status] || !validTransitions[booking.status].includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot change status from ${booking.status} to ${status}`
      });
    }

    // Only hosts and admins can confirm bookings — guests cannot self-confirm
    if (status === 'confirmed' && !isHost && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only the property host or an admin can confirm bookings'
      });
    }

    // Only hosts and admins can mark bookings as completed
    if (status === 'completed' && !isHost && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only the property host or an admin can mark bookings as completed'
      });
    }

    // Prevent cancellation if booking has started or guest is checked in
    if (status === 'cancelled') {
      // Check if guest is already checked in
      if (booking.checkedIn) {
        return res.status(400).json({
          success: false,
          message: 'Cannot cancel booking after guest has checked in'
        });
      }

      // Check if booking has started
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let bookingStartDate;
      if (booking.bookingType === 'property') {
        bookingStartDate = new Date(booking.checkIn);
      } else {
        bookingStartDate = new Date(booking.timeSlot.startTime);
      }
      bookingStartDate.setHours(0, 0, 0, 0);

      if (today >= bookingStartDate) {
        return res.status(400).json({
          success: false,
          message: 'Cannot cancel booking after the start date'
        });
      }

      const cancellationPolicy = booking.cancellationPolicy;
      let refundAmount = 0;

      if (cancellationPolicy === 'flexible') {
        // Full refund if cancelled more than 24 hours before check-in
        const checkInTime = booking.checkIn || booking.timeSlot?.startTime;
        const hoursUntilCheckIn = (checkInTime - new Date()) / (1000 * 60 * 60);

        if (hoursUntilCheckIn > 24) {
          refundAmount = booking.totalAmount;
        }
      } else if (cancellationPolicy === 'moderate') {
        // Full refund if cancelled more than 5 days before check-in
        const checkInTime = booking.checkIn || booking.timeSlot?.startTime;
        const daysUntilCheckIn = (checkInTime - new Date()) / (1000 * 60 * 60 * 24);

        if (daysUntilCheckIn > 5) {
          refundAmount = booking.totalAmount;
        } else if (daysUntilCheckIn > 1) {
          refundAmount = booking.totalAmount * 0.5; // 50% refund
        }
      } else if (cancellationPolicy === 'strict') {
        // 50% refund if cancelled more than 7 days before check-in
        const checkInTime = booking.checkIn || booking.timeSlot?.startTime;
        const daysUntilCheckIn = (checkInTime - new Date()) / (1000 * 60 * 60 * 24);

        if (daysUntilCheckIn > 7) {
          refundAmount = booking.totalAmount * 0.5;
        }
      }

      booking.refundAmount = refundAmount;
      booking.paymentStatus = refundAmount > 0 ? 'partially_refunded' : 'paid';

      // IMPORTANT: If host is cancelling, process refund through Razorpay
      if (isHost && status === 'cancelled') {
        console.log('🔄 ===========================================');
        console.log('🔄 HOST CANCELLATION DETECTED IN updateBookingStatus');
        console.log('🔄 Processing refund through RefundService...');
        console.log('🔄 ===========================================');

        try {
          const refund = await RefundService.processRefund(
            booking._id,
            'host_cancel',
            'full',
            {
              userNotes: reason || 'Cancelled by host via status update',
              adminNotes: `Host cancelled booking via status update - ${reason || 'No reason provided'}`
            }
          );

          console.log('✅ ===========================================');
          console.log('✅ REFUND PROCESSED SUCCESSFULLY');
          console.log('✅ ===========================================');
          console.log('📋 Refund ID:', refund._id);
          console.log('📋 Refund Reference:', refund.refundReference);
          console.log('💰 Refund Amount:', refund.amount, refund.currency);
          console.log('💳 Razorpay Refund ID:', refund.razorpayRefundId || 'N/A');
          console.log('📊 Refund Status:', refund.status);
          console.log('✅ ===========================================');

          // Update booking with refund details
          booking.refundAmount = refund.amount;
          booking.refunded = refund.amount > 0;
          booking.refundStatus = mapRefundStatusToBooking(refund.status);
          booking.paymentStatus = refund.amount === booking.totalAmount ? 'refunded' : 'partially_refunded';

          console.log('📊 Refund status mapping:');
          console.log('   Refund status:', refund.status);
          console.log('   Booking refundStatus:', booking.refundStatus);
        } catch (refundError) {
          console.error('❌ ===========================================');
          console.error('❌ REFUND PROCESSING FAILED');
          console.error('❌ ===========================================');
          console.error('❌ Error:', refundError.message);
          console.error('❌ Stack:', refundError.stack);
          console.error('❌ ===========================================');
          // Continue with cancellation even if refund fails
        }
      }
    }

    booking.status = status;

    // Update payment status for confirmed bookings
    if (status === 'confirmed') {
      booking.paymentStatus = 'paid';
    }

    await booking.save();
    console.log('✅ Booking status updated to:', status);

    // Create notification
    const notificationUser = isHost ? booking.user : booking.host;
    const notificationMessage = isHost
      ? `Your booking has been ${status} by the host`
      : `A guest has ${status} their booking`;

    await Notification.create({
      user: notificationUser,
      type: 'booking',
      title: `Booking ${status.charAt(0).toUpperCase() + status.slice(1)}`,
      message: notificationMessage,
      relatedEntity: {
        type: 'Booking',
        id: booking._id
      },
      metadata: { bookingId: booking._id, status }
    });

    // Send email notifications
    try {
      const [guest, hostUser] = await Promise.all([
        User.findById(booking.user),
        User.findById(booking.host)
      ]);

      const bookingDetails = {
        propertyName: booking.listing ? booking.listing.title : booking.service.title,
        bookingId: booking._id.toString(),
        status: status,
        reason: reason || null
      };

      if (status === 'confirmed') {
        // Send confirmation email to guest
        if (isHost) {
          // Host confirmed the booking - use host action template
          await sendHostConfirmedBookingEmail(guest.email, guest.name, {
            ...bookingDetails,
            checkIn: booking.checkIn ? new Date(booking.checkIn).toLocaleDateString() : new Date(booking.timeSlot.startTime).toLocaleDateString(),
            checkOut: booking.checkOut ? new Date(booking.checkOut).toLocaleDateString() : new Date(booking.timeSlot.endTime).toLocaleDateString(),
            totalAmount: booking.totalAmount.toLocaleString()
          });
        } else {
          // Guest confirmed the booking - use regular template
          await sendBookingConfirmationEmail(guest.email, guest.name, {
            ...bookingDetails,
            checkIn: booking.checkIn ? new Date(booking.checkIn).toLocaleDateString() : new Date(booking.timeSlot.startTime).toLocaleDateString(),
            checkOut: booking.checkOut ? new Date(booking.checkOut).toLocaleDateString() : new Date(booking.timeSlot.endTime).toLocaleDateString(),
            guests: `${booking.guests.adults} adults${booking.guests.children > 0 ? `, ${booking.guests.children} children` : ''}${booking.guests.infants > 0 ? `, ${booking.guests.infants} infants` : ''}`,
            totalAmount: booking.totalAmount.toLocaleString()
          });
        }
      } else if (status === 'cancelled') {
        // Send cancellation email to guest
        if (isHost) {
          // Host cancelled the booking - use host action template
          await sendHostCancelledBookingEmail(guest.email, guest.name, {
            ...bookingDetails,
            checkIn: booking.checkIn ? new Date(booking.checkIn).toLocaleDateString() : new Date(booking.timeSlot.startTime).toLocaleDateString(),
            checkOut: booking.checkOut ? new Date(booking.checkOut).toLocaleDateString() : new Date(booking.timeSlot.endTime).toLocaleDateString(),
            refundAmount: booking.refundAmount ? booking.refundAmount.toLocaleString() : '0',
            reason: reason || 'Host decision'
          });
        } else {
          // Guest cancelled the booking - use regular template
          await sendBookingCancellationEmail(guest.email, guest.name, {
            ...bookingDetails,
            checkIn: booking.checkIn ? new Date(booking.checkIn).toLocaleDateString() : new Date(booking.timeSlot.startTime).toLocaleDateString(),
            checkOut: booking.checkOut ? new Date(booking.checkOut).toLocaleDateString() : new Date(booking.timeSlot.endTime).toLocaleDateString(),
            refundAmount: booking.refundAmount ? booking.refundAmount.toLocaleString() : '0'
          });
        }
      } else if (status === 'completed' && isHost) {
        // Host marked booking as completed - use host action template
        await sendHostCompletedBookingEmail(guest.email, guest.name, {
          ...bookingDetails,
          checkIn: booking.checkIn ? new Date(booking.checkIn).toLocaleDateString() : new Date(booking.timeSlot.startTime).toLocaleDateString(),
          checkOut: booking.checkOut ? new Date(booking.checkOut).toLocaleDateString() : new Date(booking.timeSlot.endTime).toLocaleDateString()
        });
      } else if (isHost && status !== 'confirmed' && status !== 'cancelled') {
        // Other host status updates - use host action template
        await sendHostStatusUpdateEmail(guest.email, guest.name, {
          ...bookingDetails,
          previousStatus: booking.status,
          newStatus: status,
          reason: reason || null
        });
      }
    } catch (emailError) {
      console.error('Error sending status update emails:', emailError);
      // Don't fail the status update if email fails
    }

    res.status(200).json({
      success: true,
      message: `Booking ${status} successfully`,
      data: { booking }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating booking status',
      error: error.message
    });
  }
};

// @desc    Check-in guest for booking
// @route   POST /api/bookings/:id/check-in
// @access  Private
const checkInGuest = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const booking = await Booking.findById(id)
      .populate('user', 'name email phone')
      .populate('host', 'name email phone')
      .populate('listing', 'title location')
      .populate('service', 'title location')
      .exec();

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Check if user is the host of this booking
    if (booking.host._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only the host can check-in guests'
      });
    }

    // Check if booking is confirmed
    if (booking.status !== 'confirmed') {
      return res.status(400).json({
        success: false,
        message: 'Only confirmed bookings can be checked in'
      });
    }

    // Check if already checked in
    if (booking.checkedIn) {
      return res.status(400).json({
        success: false,
        message: 'Guest has already been checked in'
      });
    }

    // Check if it's the check-in date
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let checkInDate;
    if (booking.bookingType === 'property') {
      checkInDate = new Date(booking.checkIn);
    } else {
      checkInDate = new Date(booking.timeSlot.startTime);
    }
    checkInDate.setHours(0, 0, 0, 0);

    if (today < checkInDate) {
      return res.status(400).json({
        success: false,
        message: 'Cannot check-in before the booking start date'
      });
    }

    // Perform check-in
    booking.checkedIn = true;
    booking.checkedInAt = new Date();
    booking.checkedInBy = req.user._id;
    booking.checkInNotes = notes || undefined;

    await booking.save();

    // Create notification for guest
    await Notification.create({
      user: booking.user._id,
      type: 'check_in',
      title: 'Check-in Completed',
      message: `You have been successfully checked in for your booking`,
      relatedEntity: {
        type: 'Booking',
        id: booking._id
      },
      metadata: { bookingId: booking._id }
    });

    // Send email notification to guest
    try {
      const checkInDetails = {
        propertyName: booking.listing?.title || booking.service?.title,
        bookingId: booking._id,
        checkInDate: new Date().toLocaleDateString(),
        checkInTime: new Date().toLocaleTimeString(),
        notes: notes || 'No additional notes'
      };

      await sendHostCheckInGuestEmail(booking.user.email, booking.user.name, checkInDetails);

    } catch (emailError) {
      console.error('Error sending check-in email:', emailError);
    }

    res.status(200).json({
      success: true,
      message: 'Guest checked in successfully',
      data: { booking }
    });
  } catch (error) {
    console.error('Error checking in guest:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking in guest',
      error: error.message
    });
  }
};

// @desc    Calculate booking price
// @route   POST /api/bookings/calculate-price
// @access  Public
const calculateBookingPrice = async (req, res) => {
  try {
    const {
      listingId,
      serviceId,
      checkIn,
      checkOut,
      guests,
      couponCode
    } = req.body;

    let listing = null;
    let service = null;

    if (listingId) {
      listing = await Property.findById(listingId);
      if (!listing) {
        return res.status(404).json({
          success: false,
          message: 'Listing not found'
        });
      }
    } else if (serviceId) {
      service = await Service.findById(serviceId);
      if (!service) {
        return res.status(404).json({
          success: false,
          message: 'Service not found'
        });
      }
    }

    // Calculate base price
    let totalAmount = 0;
    let basePrice = 0;
    let extraGuestPrice = 0;
    let cleaningFee = 0;
    let serviceFee = 0;
    let nights = 0;

    if (listing) {
      basePrice = listing.pricing.basePrice;
      extraGuestPrice = listing.pricing.extraGuestPrice;
      cleaningFee = listing.pricing.cleaningFee;
      serviceFee = listing.pricing.serviceFee;

      if (checkIn && checkOut) {
        nights = Math.ceil((new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24));
        totalAmount = basePrice * nights;

        // Add extra guest charges
        if (guests && guests.adults > 1) {
          const extraGuests = guests.adults - 1;
          totalAmount += extraGuestPrice * extraGuests * nights;
        }
      }

      totalAmount += cleaningFee + serviceFee;
    } else if (service) {
      basePrice = service.pricing.basePrice;
      totalAmount = basePrice;

      // Add per-person charges
      if (guests && guests.adults > 1) {
        totalAmount += service.pricing.perPersonPrice * (guests.adults - 1);
      }
    }

    // Apply coupon
    let discountAmount = 0;
    let couponDetails = null;

    if (couponCode) {
      const coupon = await Coupon.findOne({
        code: couponCode.toUpperCase(),
        isActive: true,
        validFrom: { $lte: new Date() },
        validTo: { $gte: new Date() }
      });

      if (coupon) {
        if (coupon.discountType === 'percentage') {
          discountAmount = (totalAmount * coupon.amount) / 100;
          if (coupon.maxDiscount) {
            discountAmount = Math.min(discountAmount, coupon.maxDiscount);
          }
        } else {
          discountAmount = coupon.amount;
        }

        if (coupon.minBookingAmount && totalAmount < coupon.minBookingAmount) {
          discountAmount = 0;
        }

        totalAmount -= discountAmount;
        couponDetails = {
          code: coupon.code,
          discountType: coupon.discountType,
          amount: coupon.amount
        };
      }
    }

    const breakdown = {
      basePrice: listing ? basePrice * nights : basePrice,
      extraGuestPrice: listing && guests ? extraGuestPrice * (guests.adults - 1) * nights : 0,
      cleaningFee,
      serviceFee,
      discountAmount,
      totalAmount
    };

    res.status(200).json({
      success: true,
      data: {
        breakdown,
        couponDetails,
        currency: listing ? listing.pricing.currency : service.pricing.currency
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error calculating price',
      error: error.message
    });
  }
};

// @desc    Cancel booking
// @route   DELETE /api/bookings/:id
// @access  Private
// const cancelBooking = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { reason } = req.body;
//     // Use _id instead of id for Mongoose documents
//     const userId = req.user._id;

//     // Find the booking
//     const booking = await Booking.findById(id)
//       .populate('listing', 'title host cancellationPolicy pricing')
//       .populate('host', 'name email')
//       .populate('user', 'name email');

//     if (!booking) {
//       return res.status(404).json({
//         success: false,
//         message: 'Booking not found'
//       });
//     }

//     // Check if user is authorized to cancel this booking
//     // User can cancel if they are the booking owner OR the host
//     const isBookingOwner = booking.user && (
//       (typeof booking.user === 'string' && booking.user === userId.toString()) ||
//       (booking.user._id && booking.user._id.toString() === userId.toString())
//     );

//     const isHost = booking.host && (
//       (typeof booking.host === 'string' && booking.host === userId.toString()) ||
//       (booking.host._id && booking.host._id.toString() === userId.toString())
//     );

//     // Add debug logging
//     console.log('🔍 Authorization check for booking cancellation:');
//     console.log('🔍 Current user ID:', userId.toString());
//     console.log('🔍 Booking user ID:', booking.user ? (typeof booking.user === 'string' ? booking.user : booking.user._id?.toString()) : 'null');
//     console.log('🔍 Booking host ID:', booking.host ? (typeof booking.host === 'string' ? booking.host : booking.host._id?.toString()) : 'null');
//     console.log('🔍 Is booking owner:', isBookingOwner);
//     console.log('🔍 Is host:', isHost);

//     if (!isBookingOwner && !isHost) {
//       return res.status(403).json({
//         success: false,
//         message: 'You are not authorized to cancel this booking. Only the booking owner or host can cancel.',
//         debug: {
//           userId: userId.toString(),
//           bookingUserId: booking.user ? (typeof booking.user === 'string' ? booking.user : booking.user._id?.toString()) : 'null',
//           bookingHostId: booking.host ? (typeof booking.host === 'string' ? booking.host : booking.host._id?.toString()) : 'null'
//         }
//       });
//     }

//     // Check if booking can be cancelled
//     if (booking.status === 'cancelled') {
//       return res.status(400).json({
//         success: false,
//         message: 'Booking is already cancelled'
//       });
//     }

//     if (booking.status === 'completed') {
//       return res.status(400).json({
//         success: false,
//         message: 'Cannot cancel a completed booking'
//       });
//     }

//     // Determine refund type and reason based on booking status and who is cancelling
//     let refundType = 'partial';
//     let refundReason = 'cancellation';

//     // If booking is pending (before host approval), always give full refund
//     if (booking.status === 'pending') {
//       refundType = 'full';
//       refundReason = 'cancellation'; // User cancellation before host approval
//     } else if (isHost) {
//       // Host is cancelling - always full refund
//       refundType = 'full';
//       refundReason = 'host_cancel';
//         } else {
//       // User is cancelling confirmed booking - use cancellation policy
//       refundType = 'partial'; // RefundService will calculate based on policy
//       refundReason = 'cancellation';
//     }

//     // Process refund using RefundService BEFORE updating booking status
//     // let refund = null;
//     // try {
//     //   if (isHost) {
//     //     console.log('🔄 ===========================================');
//     //     console.log('🔄 HOST CANCELLATION - REFUND PROCESSING');
//     //     console.log('🔄 ===========================================');
//     //     console.log('📋 Booking ID:', booking._id);
//     //     console.log('👤 Guest:', booking.user?.name || booking.user?.email || 'Unknown');
//     //     console.log('🏠 Host:', booking.host?.name || booking.host?.email || 'Unknown');
//     //     console.log('💰 Booking Amount:', booking.totalAmount, booking.currency || 'INR');
//     //     console.log('📅 Booking Status:', booking.status);
//     //     console.log('💳 Payment ID:', booking.payment?._id);
//     //     console.log('💳 Razorpay Payment ID:', booking.payment?.razorpayPaymentId || 'N/A');
//     //     console.log('🔄 ===========================================');
//     //   }

//     //   refund = await RefundService.processRefund(
//     //     booking._id,
//     //     refundReason,
//     //     refundType,
//     //     {
//     //       userNotes: reason || (isHost ? 'Cancelled by host' : 'Cancelled by user'),
//     //       adminNotes: `Cancellation - ${isHost ? 'Host cancelled' : 'User cancelled'} ${booking.status === 'pending' ? 'before approval' : 'after confirmation'}`
//     //     }
//     //   );

//     //   if (isHost) {
//     //     console.log('✅ ===========================================');
//     //     console.log('✅ REFUND PROCESSED SUCCESSFULLY');
//     //     console.log('✅ ===========================================');
//     //     console.log('📋 Refund ID:', refund._id);
//     //     console.log('📋 Refund Reference:', refund.refundReference);
//     //     console.log('💰 Refund Amount:', refund.amount, refund.currency);
//     //     console.log('💳 Razorpay Refund ID:', refund.razorpayRefundId || 'N/A');
//     //     console.log('📊 Refund Status:', refund.status);
//     //     console.log('✅ ===========================================');
//     //   } else {
//     //   console.log(`✅ Refund processed for cancelled booking: ${refund.refundReference}`);
//     //   console.log(`📋 Refund stored in database with ID: ${refund._id}`);
//     //   console.log(`💰 Refund amount: ${refund.amount}`);
//     //   }
//     // } catch (refundError) {
//     //   console.error('❌ Error processing refund for cancelled booking:', refundError);
//     //   // Continue with cancellation even if refund fails
//     // }

//     // Update booking status
//     booking.status = 'cancelled';
//     booking.cancellationReason = reason || 'Cancelled by user';
//     booking.cancelledAt = new Date();
//     booking.cancelledBy = userId;

//     // Update booking with refund details
//     if (refund) {
//       booking.refundAmount = refund.amount;
//       booking.refunded = refund.amount > 0;
//       booking.refundStatus = mapRefundStatusToBooking(refund.status);
//       booking.paymentStatus = refund.amount === booking.totalAmount ? 'refunded' : 'partially_refunded';
//     } else {
//       // Fallback if refund creation failed
//       booking.refundAmount = 0;
//       booking.refunded = false;
//       booking.refundStatus = 'not_applicable';
//       booking.paymentStatus = 'refunded';
//     }

//     await booking.save();

//     // Release dates back to availability system
//     if (booking.listing && booking.checkIn && booking.checkOut) {
//       try {
//         console.log('🔄 Releasing property dates back to availability system...');

//         // FIXED: Generate array of dates to release (normalize to midnight, include checkout date)
//         const startDate = new Date(booking.checkIn);
//         startDate.setHours(0, 0, 0, 0);
//         const endDate = new Date(booking.checkOut);
//         endDate.setHours(23, 59, 59, 999); // Include checkout date
//         const datesToRelease = [];

//         let currentDate = new Date(startDate);
//         while (currentDate <= endDate) {  // FIXED: Use <= instead of <
//           const dateStr = currentDate.toISOString().split('T')[0];
//           datesToRelease.push(dateStr);
//           currentDate.setDate(currentDate.getDate() + 1);
//         }

//         console.log('📅 Property dates to release:', datesToRelease);

//                         // Update availability records to mark dates as available again
//                 const updateResult = await Availability.updateMany(
//                   {
//             property: booking.listing._id || booking.listing,
//             date: { $in: datesToRelease.map(d => new Date(d)) },
//             status: { $in: ['booked', 'blocked'] }  // FIXED: Also release blocked dates
//                   },
//                   {
//                     $set: {
//                       status: 'available',
//                       bookedBy: null,
//                       bookedAt: null,
//               blockedBy: null,
//               blockedAt: null,
//                       reason: null
//                     },
//                     $unset: {
//                       bookingId: 1
//                     }
//                   }
//                 );

//         console.log(`✅ Successfully released ${updateResult.modifiedCount} property dates back to available status`);

//         // Also delete any AvailabilityEvents for this booking
//         try {
//           await AvailabilityEventService.deleteBookingEvents(booking._id);
//           console.log('✅ Deleted availability events for cancelled booking');
//         } catch (eventError) {
//           console.error('⚠️ Error deleting availability events:', eventError);
//         }

//       } catch (availabilityError) {
//         console.error('⚠️ Error releasing property dates to availability system:', availabilityError);
//         // Don't fail the cancellation if availability update fails
//       }
//     }

//     // Handle service booking time slot release
//     if (booking.service && booking.timeSlot) {
//       try {
//         console.log('🔄 Releasing service time slot back to availability system...');

//                         // For services, we need to release the specific time slot
//                 const timeSlotUpdate = await Availability.updateMany(
//                   {
//                     service: booking.service,
//                     date: new Date(booking.timeSlot.startTime).toISOString().split('T')[0],
//                     status: 'booked'
//                   },
//                   {
//                     $set: {
//                       status: 'available',
//                       bookedBy: null,
//                       bookedAt: null,
//                       reason: null
//                     },
//                     $unset: {
//                       bookingId: 1
//                     }
//                   }
//                 );

//                         console.log(`✅ Successfully released service time slot back to available status (reason field cleared)`);

//       } catch (availabilityError) {
//         console.error('⚠️ Error releasing service time slot to availability system:', availabilityError);
//         // Don't fail the cancellation if availability update fails
//       }
//     }

//     // Create notification for the other party
//     const notificationData = {
//       user: (booking.user && booking.user.toString() === userId) ? booking.host : booking.user,
//       type: 'booking',
//       title: 'Booking Cancelled',
//       message: `Booking for ${booking.listing?.title || 'property'} has been cancelled`,
//       metadata: {
//         bookingId: booking._id,
//         refundAmount,
//         refundPercentage
//       }
//     };

//     if (notificationData.user) {
//       await Notification.create(notificationData);
//     }

//     // If there's a refund, process it
//     if (refundAmount > 0) {
//       // Find the payment for this booking
//       const payment = await Payment.findOne({ booking: booking._id });

//       if (payment) {
//         payment.status = 'refunded';
//         payment.refundAmount = refundAmount;
//         payment.refundedAt = new Date();
//         await payment.save();
//       }

//       // Send refund notification email
//       try {
//         if (booking.user && booking.user.email) {
//           await sendBookingCancellationEmail(
//             booking.user.email,
//             booking.user.name || 'User',
//             {
//               propertyName: booking.listing?.title || 'Property',
//               bookingId: booking._id,
//               refundAmount,
//               refundPercentage,
//               checkIn: booking.checkIn,
//               checkOut: booking.checkOut
//             }
//           );
//         }
//       } catch (emailError) {
//         console.error('⚠️ ===========================================');
//         console.error('⚠️ EMAIL SENDING FAILED (Non-blocking)');
//         console.error('⚠️ ===========================================');
//         console.error('⚠️ Note: Refund has already been processed successfully');
//         console.error('⚠️ Email error does not affect refund processing');
//         console.error('⚠️ Error:', emailError.message);
//         console.error('⚠️ ===========================================');
//       }
//     }

//     // Prepare detailed refund information
//     const refundInfo = {
//       originalAmount: booking.totalAmount,
//       refundAmount: refundAmount,
//       refundPercentage: refundPercentage,
//       cancellationPolicy: cancellationPolicy,
//       policyDescription: policyDescription,
//       timeUntilCheckIn: {
//         days: daysUntilCheckIn,
//         hours: Math.ceil(hoursUntilCheckIn)
//       },
//       refundStatus: refundAmount > 0 ? 'pending' : 'not_applicable',
//       message: refundAmount > 0 
//         ? `You will receive a refund of ₹${refundAmount.toFixed(2)} (${refundPercentage}% of total amount)`
//         : 'No refund is applicable based on the cancellation policy'
//     };

//     res.status(200).json({
//       success: true,
//       message: 'Booking cancelled successfully',
//       data: {
//         booking: {
//           _id: booking._id,
//           status: booking.status,
//           cancelledAt: booking.cancelledAt,
//           cancellationReason: booking.cancellationReason
//         },
//         refundInfo,
//         datesReleased: true,
//         message: `Your booking has been cancelled. ${refundInfo.message}`
//       }
//     });
//   } catch (error) {
//     console.error('Error cancelling booking:', error);
//     res.status(500).json({
//       success: false,
//       message: 'Error cancelling booking',
//       error: error.message
//     });
//   }
// };


const cancelBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const userId = req.user._id;

    const booking = await Booking.findById(id)
      .populate('listing', 'title')
      .populate('host', 'name email')
      .populate('user', 'name email');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Authorization
    const bookingUserId = booking.user?._id?.toString() ?? booking.user?.toString();
    const bookingHostId = booking.host?._id?.toString() ?? booking.host?.toString();
    const isBookingOwner = bookingUserId === userId.toString();
    const isHost = bookingHostId === userId.toString();
    const isAdmin =
      req.user.role === 'admin' || req.user.role === 'super-admin';

    if (!isBookingOwner && !isHost && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to cancel this booking'
      });
    }

    // Status checks
    if (booking.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Booking already cancelled'
      });
    }

    if (booking.status === 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Completed booking cannot be cancelled'
      });
    }

    // ✅ Cancel booking (NO REFUND HERE)
    booking.status = 'cancelled';
    booking.cancellationReason = reason || 'Cancelled by user';
    booking.cancelledAt = new Date();
    booking.cancelledBy = userId;

    // 🔒 Refund handled by ADMIN later
    booking.refundStatus = 'pending';
    booking.refundAmount = 0;
    booking.refunded = false;
    booking.paymentStatus = 'cancelled';

    await booking.save();

    // ===============================
    // Release property availability
    // ===============================
    if (booking.listing && booking.checkIn && booking.checkOut) {
      const startDate = new Date(booking.checkIn);
      startDate.setHours(0, 0, 0, 0);

      const endDate = new Date(booking.checkOut);
      endDate.setHours(23, 59, 59, 999);

      const datesToRelease = [];
      let current = new Date(startDate);

      while (current <= endDate) {
        datesToRelease.push(new Date(current));
        current.setDate(current.getDate() + 1);
      }

      await Availability.updateMany(
        {
          property: booking.listing._id,
          date: { $in: datesToRelease },
          status: { $in: ['booked', 'blocked'] }
        },
        {
          $set: {
            status: 'available',
            bookedBy: null,
            bookedAt: null,
            blockedBy: null,
            blockedAt: null,
            reason: null
          },
          $unset: { bookingId: 1 }
        }
      );

      await AvailabilityEventService.deleteBookingEvents(booking._id);
    }

    // ===============================
    // Release service slot (if any)
    // ===============================
    if (booking.service && booking.timeSlot) {
      await Availability.updateMany(
        {
          service: booking.service,
          date: new Date(booking.timeSlot.startTime)
        },
        {
          $set: {
            status: 'available',
            bookedBy: null,
            bookedAt: null,
            reason: null
          },
          $unset: { bookingId: 1 }
        }
      );
    }

    // ===============================
    // Notification
    // ===============================
    const notifyUser =
      booking.user._id.toString() === userId.toString()
        ? booking.host
        : booking.user;

    if (notifyUser) {
      await Notification.create({
        user: notifyUser,
        type: 'booking',
        title: 'Booking Cancelled',
        message: `Booking for ${booking.listing?.title || 'property'} has been cancelled`,
        metadata: {
          bookingId: booking._id
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Booking cancelled successfully',
      data: {
        bookingId: booking._id,
        status: booking.status,
        refundStatus: 'pending',
        adminActionRequired: true
      }
    });

  } catch (error) {
    console.error('Cancel booking error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error cancelling booking'
    });
  }
};


// @desc    Get booking statistics
// @route   GET /api/bookings/stats
// @access  Private
const getBookingStats = async (req, res) => {
  try {
    const userId = req.user._id;
    const isHost = req.user.role === 'host';

    const query = isHost ? { host: userId } : { user: userId };

    const stats = await Booking.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$totalAmount' }
        }
      }
    ]);

    const totalBookings = await Booking.countDocuments(query);
    const totalEarnings = await Booking.aggregate([
      { $match: { ...query, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ]);

    const monthlyStats = await Booking.aggregate([
      { $match: query },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          },
          count: { $sum: 1 },
          amount: { $sum: '$totalAmount' }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: 12 }
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalBookings,
        totalEarnings: totalEarnings[0]?.total || 0,
        statusBreakdown: stats,
        monthlyStats
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching booking statistics',
      error: error.message
    });
  }
};

// ========================================
// ADMIN FUNCTIONS
// ========================================

// @desc    Get admin booking statistics (platform-wide)
// @route   GET /api/bookings/admin/stats
// @access  Private (Admin only)
const getAdminBookingStats = async (req, res) => {
  try {
    const stats = await Booking.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$totalAmount' }
        }
      }
    ]);

    const totalBookings = await Booking.countDocuments();
    const totalRevenue = await Booking.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ]);

    const monthlyStats = await Booking.aggregate([
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          },
          count: { $sum: 1 },
          amount: { $sum: '$totalAmount' }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: 12 }
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalBookings,
        totalRevenue: totalRevenue[0]?.total || 0,
        statusBreakdown: stats,
        monthlyStats
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching admin booking statistics',
      error: error.message
    });
  }
};

// @desc    Get all bookings (admin only)
// @route   GET /api/bookings/admin/all
// @access  Private (Admin only)
const getAllBookings = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const skip = (page - 1) * limit;

    let query = {};
    if (status && status !== 'all') {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { receiptId: { $regex: search, $options: 'i' } },
        { 'user.name': { $regex: search, $options: 'i' } },
        { 'host.name': { $regex: search, $options: 'i' } }
      ];
    }

    const bookings = await Booking.find(query)
      .populate('user', 'name email')
      .populate('host', 'name email')
      .populate('listing', 'title')
      .populate('service', 'title')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Booking.countDocuments(query);

    res.status(200).json({
      success: true,
      data: {
        bookings,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / limit),
          totalBookings: total,
          hasNext: page * limit < total,
          hasPrev: page > 1
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching all bookings',
      error: error.message
    });
  }
};

// @desc    Admin update booking status
// @route   PUT /api/bookings/admin/:id/status
// @access  Private (Admin only)
const adminUpdateBookingStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;

    const booking = await Booking.findById(id)
      .populate('user', 'name email')
      .populate('host', 'name email');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    const oldStatus = booking.status;
    booking.status = status;
    booking.adminNotes = reason || `Status changed from ${oldStatus} to ${status} by admin`;
    booking.updatedAt = new Date();

    await booking.save();

    // Send notification to both user and host
    const notificationData = {
      user: booking.user._id,
      type: 'admin_action',
      title: 'Booking Status Updated',
      message: `Your booking status has been updated to ${status} by an administrator`,
      metadata: { bookingId: booking._id, oldStatus, newStatus: status }
    };

    await Notification.create(notificationData);

    res.status(200).json({
      success: true,
      message: 'Booking status updated successfully',
      data: { booking }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating booking status',
      error: error.message
    });
  }
};

// @desc    Check cancellation eligibility and refund amount
// @route   GET /api/bookings/:id/cancellation-info
// @access  Private
const getCancellationInfo = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    // Find the booking
    const booking = await Booking.findById(id)
      .populate('listing', 'title host cancellationPolicy pricing')
      .populate('host', 'name email');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Check if user is authorized to view this booking
    if (booking.user.toString() !== userId.toString() && booking.host.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to view this booking'
      });
    }

    // Check if booking can be cancelled
    if (booking.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Booking is already cancelled'
      });
    }

    if (booking.status === 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel a completed booking'
      });
    }

    // Calculate potential refund
    const cancellationPolicy = booking.listing?.cancellationPolicy || 'moderate';
    const checkInDate = new Date(booking.checkIn);
    const now = new Date();
    const hoursUntilCheckIn = (checkInDate.getTime() - now.getTime()) / (1000 * 60 * 60);
    const daysUntilCheckIn = Math.ceil(hoursUntilCheckIn / 24);

    let refundAmount = 0;
    let refundPercentage = 0;
    let policyDescription = '';
    let canCancel = true;

    // Determine refund based on policy and time until check-in
    switch (cancellationPolicy) {
      case 'flexible':
        if (hoursUntilCheckIn > 24) {
          refundPercentage = 100;
          policyDescription = 'Full refund if cancelled more than 24 hours before check-in';
        } else {
          refundPercentage = 0;
          policyDescription = 'No refund if cancelled within 24 hours of check-in';
        }
        break;
      case 'moderate':
        if (hoursUntilCheckIn > 120) { // 5 days
          refundPercentage = 100;
          policyDescription = 'Full refund if cancelled more than 5 days before check-in';
        } else if (hoursUntilCheckIn > 24) {
          refundPercentage = 50;
          policyDescription = '50% refund if cancelled between 1-5 days before check-in';
        } else {
          refundPercentage = 0;
          policyDescription = 'No refund if cancelled within 24 hours of check-in';
        }
        break;
      case 'strict':
        if (hoursUntilCheckIn > 168) { // 7 days
          refundPercentage = 50;
          policyDescription = '50% refund if cancelled more than 7 days before check-in';
        } else {
          refundPercentage = 0;
          policyDescription = 'No refund if cancelled within 7 days of check-in';
        }
        break;
      case 'super_strict':
        refundPercentage = 0;
        policyDescription = 'No refunds under any circumstances';
        break;
      default:
        refundPercentage = 0;
        policyDescription = 'Standard cancellation policy applies';
    }

    // Check if cancellation is allowed based on policy
    if (cancellationPolicy === 'super_strict' && hoursUntilCheckIn <= 168) {
      canCancel = false;
    }

    refundAmount = (booking.totalAmount * refundPercentage) / 100;

    const cancellationInfo = {
      canCancel,
      cancellationPolicy,
      policyDescription,
      timeUntilCheckIn: {
        days: daysUntilCheckIn,
        hours: Math.ceil(hoursUntilCheckIn)
      },
      refundDetails: {
        originalAmount: booking.totalAmount,
        refundAmount: refundAmount,
        refundPercentage: refundPercentage,
        refundStatus: refundAmount > 0 ? 'eligible' : 'not_applicable'
      },
      message: canCancel
        ? (refundAmount > 0
          ? `You can cancel this booking and receive a refund of ₹${refundAmount.toFixed(2)} (${refundPercentage}% of total amount)`
          : 'You can cancel this booking, but no refund is applicable based on the cancellation policy')
        : 'Cancellation is not allowed according to the host\'s strict policy'
    };

    res.status(200).json({
      success: true,
      data: cancellationInfo
    });

  } catch (error) {
    console.error('Error getting cancellation info:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting cancellation information',
      error: error.message
    });
  }
};

// @desc    Admin delete booking
// @route   DELETE /api/bookings/admin/:id
// @access  Private (Admin only)
const adminDeleteBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Soft delete - mark as deleted instead of actually removing
    booking.isDeleted = true;
    booking.deletedAt = new Date();
    booking.deletedBy = req.user._id;
    booking.deletionReason = reason || 'Deleted by administrator';
    await booking.save();

    res.status(200).json({
      success: true,
      message: 'Booking deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting booking',
      error: error.message
    });
  }
};

// @desc    Cleanup expired blocked bookings and incomplete payment bookings (utility function)
// @access  Private (Internal use)
// NOTE: This function only cleans up bookings that are blocked for payment or processing payment
// It does NOT clean up pending bookings waiting for host approval
const cleanupExpiredBlockedBookings = async () => {
  try {
    console.log('🔄 ===========================================');
    console.log('🔄 CLEANUP EXPIRED BLOCKED/PAYMENT BOOKINGS');
    console.log('🔄 ===========================================');

    const now = new Date();
    const threeMinutesAgo = new Date(now.getTime() - 3 * 60 * 1000);

    console.log(`🕐 Current time: ${now.toISOString()}`);
    console.log(`🕐 Cleanup threshold: ${threeMinutesAgo.toISOString()} (3 minutes ago)`);

    let totalCleaned = 0;

    // 1. Clean up incomplete bookings older than 3 minutes
    // Safety check: Only clean up processing bookings (payment in progress), never pending (waiting for host approval) or confirmed ones
    console.log('🔍 Step 1: Checking for incomplete payment bookings...');
    const incompleteBookings = await Booking.find({
      status: 'processing', // Only processing bookings, not pending ones waiting for host approval
      createdAt: { $lt: threeMinutesAgo }
    }).populate('user', 'name email _id').populate('host', 'name email _id');

    console.log(`📊 Found ${incompleteBookings.length} incomplete payment bookings older than 3 minutes`);

    if (incompleteBookings.length > 0) {
      console.log('📋 DETAILED BOOKING INFORMATION:');
      console.log('================================');

      incompleteBookings.forEach((booking, index) => {
        console.log(`\n📝 Booking #${index + 1}:`);
        console.log(`   🆔 Booking ID: ${booking._id}`);
        console.log(`   👤 User ID: ${booking.user?._id || booking.user}`);
        console.log(`   👤 User Name: ${booking.user?.name || 'N/A'}`);
        console.log(`   👤 User Email: ${booking.user?.email || 'N/A'}`);
        console.log(`   🏠 Host ID: ${booking.host?._id || booking.host}`);
        console.log(`   🏠 Host Name: ${booking.host?.name || 'N/A'}`);
        console.log(`   🏠 Host Email: ${booking.host?.email || 'N/A'}`);
        console.log(`   📊 Status: ${booking.status}`);
        console.log(`   💰 Total Amount: ₹${booking.totalAmount}`);
        console.log(`   📅 Created At: ${booking.createdAt.toISOString()}`);
        console.log(`   ⏰ Age: ${Math.round((now - booking.createdAt) / 1000 / 60)} minutes`);
        console.log(`   🏠 Property: ${booking.listing || 'N/A'}`);
        console.log(`   🎯 Service: ${booking.service || 'N/A'}`);
        console.log(`   📝 Payment Status: ${booking.paymentStatus || 'N/A'}`);
        console.log(`   🔄 Booking Type: ${booking.bookingType || 'N/A'}`);
        console.log(`   📅 Check-in: ${booking.checkIn || 'N/A'}`);
        console.log(`   📅 Check-out: ${booking.checkOut || 'N/A'}`);
        console.log(`   ⏰ Time Slot: ${booking.timeSlot ? JSON.stringify(booking.timeSlot) : 'N/A'}`);
        console.log(`   📝 Special Requests: ${booking.specialRequests || 'N/A'}`);
        console.log(`   👥 Guest Details: ${booking.guestDetails ? JSON.stringify(booking.guestDetails) : 'N/A'}`);
        console.log(`   🎫 Coupon: ${booking.couponCode || 'N/A'}`);
        console.log(`   💳 Payment ID: ${booking.payment || 'N/A'}`);
        console.log(`   🔄 Refund Status: ${booking.refundStatus || 'N/A'}`);
        console.log(`   🔄 Refund Amount: ₹${booking.refundAmount || 0}`);
        console.log(`   📝 Cancellation Reason: ${booking.cancellationReason || 'N/A'}`);
        console.log(`   📅 Cancelled At: ${booking.cancelledAt || 'N/A'}`);
        console.log(`   ✅ Checked In: ${booking.checkedIn || false}`);
        console.log(`   ✅ Checked Out: ${booking.checkedOut || false}`);
        console.log(`   📊 Pricing Breakdown: ${booking.pricingBreakdown ? 'Present' : 'Missing'}`);
        console.log(`   📊 Subtotal: ₹${booking.subtotal || 0}`);
        console.log(`   📊 Tax Amount: ₹${booking.taxAmount || 0}`);
        console.log(`   📊 Platform Fee: ₹${booking.platformFee || 0}`);
        console.log(`   📊 Processing Fee: ₹${booking.processingFee || 0}`);
        console.log(`   📊 GST: ₹${booking.gst || 0}`);
        console.log(`   📊 Host Fee: ₹${booking.hostFee || 0}`);
        console.log(`   📊 Discount Amount: ₹${booking.discountAmount || 0}`);
        console.log(`   📊 Host Earning: ₹${booking.hostEarning || 0}`);
        console.log(`   📊 Cleaning Fee: ₹${booking.cleaningFee || 0}`);
        console.log(`   📊 Service Fee: ₹${booking.serviceFee || 0}`);
        console.log(`   📊 Security Deposit: ₹${booking.securityDeposit || 0}`);
        console.log(`   📊 Hourly Extension: ₹${booking.hourlyExtension || 0}`);
        console.log(`   📊 Currency: ${booking.currency || 'INR'}`);
        console.log(`   📊 Cancellation Policy: ${booking.cancellationPolicy || 'N/A'}`);
        console.log(`   📊 Booking Reference: ${booking.bookingReference || 'N/A'}`);
        console.log(`   📊 Notes: ${booking.notes || 'N/A'}`);
        console.log(`   📊 Metadata: ${booking.metadata ? JSON.stringify(booking.metadata) : 'N/A'}`);
        console.log(`   📅 Updated At: ${booking.updatedAt.toISOString()}`);
        console.log(`   📅 Last Modified: ${booking.lastModified || 'N/A'}`);
        console.log(`   🔄 Is Active: ${booking.isActive !== false}`);
        console.log(`   🔄 Is Deleted: ${booking.isDeleted || false}`);
        console.log(`   🔄 Deleted At: ${booking.deletedAt || 'N/A'}`);
        console.log(`   🔄 Deleted By: ${booking.deletedBy || 'N/A'}`);
        console.log(`   🔄 Deletion Reason: ${booking.deletionReason || 'N/A'}`);
        console.log(`   🔄 Version: ${booking.__v || 0}`);
        console.log(`   🔄 Document ID: ${booking.id || 'N/A'}`);
        console.log(`   🔄 To Object: ${JSON.stringify(booking.toObject ? booking.toObject() : 'N/A')}`);
        console.log(`   🔄 JSON: ${JSON.stringify(booking, null, 2)}`);
        console.log('   ========================================');
      });

      console.log(`\n🔄 Proceeding to clean up ${incompleteBookings.length} incomplete payment bookings...`);

      const incompleteResult = await Booking.updateMany(
        {
          _id: { $in: incompleteBookings.map(b => b._id) }
        },
        {
          $set: {
            status: 'cancelled',
            cancellationReason: 'Expired - booking not completed within 3 minutes',
            cancelledAt: new Date()
          }
        }
      );

      totalCleaned += incompleteResult.modifiedCount;
      console.log(`✅ Successfully cleaned up ${incompleteResult.modifiedCount} incomplete payment bookings`);
      console.log(`📊 Expected: ${incompleteBookings.length}, Actual: ${incompleteResult.modifiedCount}`);
    } else {
      console.log('✅ No incomplete payment bookings found to clean up');
    }

    // 2. Clean up blocked bookings older than 3 minutes
    // Safety check: Only clean up blocked bookings, never confirmed ones
    console.log('\n🔍 Step 2: Checking for expired blocked bookings...');
    const expiredBlockedBookings = await Booking.find({
      status: 'blocked',
      createdAt: { $lt: threeMinutesAgo }
    }).populate('user', 'name email _id').populate('host', 'name email _id');

    console.log(`📊 Found ${expiredBlockedBookings.length} expired blocked bookings`);

    if (expiredBlockedBookings.length > 0) {
      console.log('📋 DETAILED BLOCKED BOOKING INFORMATION:');
      console.log('========================================');

      expiredBlockedBookings.forEach((booking, index) => {
        console.log(`\n📝 Blocked Booking #${index + 1}:`);
        console.log(`   🆔 Booking ID: ${booking._id}`);
        console.log(`   👤 User ID: ${booking.user?._id || booking.user}`);
        console.log(`   👤 User Name: ${booking.user?.name || 'N/A'}`);
        console.log(`   👤 User Email: ${booking.user?.email || 'N/A'}`);
        console.log(`   🏠 Host ID: ${booking.host?._id || booking.host}`);
        console.log(`   🏠 Host Name: ${booking.host?.name || 'N/A'}`);
        console.log(`   🏠 Host Email: ${booking.host?.email || 'N/A'}`);
        console.log(`   📊 Status: ${booking.status}`);
        console.log(`   💰 Total Amount: ₹${booking.totalAmount}`);
        console.log(`   📅 Created At: ${booking.createdAt.toISOString()}`);
        console.log(`   ⏰ Age: ${Math.round((now - booking.createdAt) / 1000 / 60)} minutes`);
        console.log(`   🏠 Property: ${booking.listing || 'N/A'}`);
        console.log(`   🎯 Service: ${booking.service || 'N/A'}`);
        console.log(`   📝 Payment Status: ${booking.paymentStatus || 'N/A'}`);
        console.log(`   🔄 Booking Type: ${booking.bookingType || 'N/A'}`);
        console.log(`   📅 Check-in: ${booking.checkIn || 'N/A'}`);
        console.log(`   📅 Check-out: ${booking.checkOut || 'N/A'}`);
        console.log(`   ⏰ Time Slot: ${booking.timeSlot ? JSON.stringify(booking.timeSlot) : 'N/A'}`);
        console.log(`   📝 Special Requests: ${booking.specialRequests || 'N/A'}`);
        console.log(`   👥 Guest Details: ${booking.guestDetails ? JSON.stringify(booking.guestDetails) : 'N/A'}`);
        console.log(`   🎫 Coupon: ${booking.couponCode || 'N/A'}`);
        console.log(`   💳 Payment ID: ${booking.payment || 'N/A'}`);
        console.log(`   🔄 Refund Status: ${booking.refundStatus || 'N/A'}`);
        console.log(`   🔄 Refund Amount: ₹${booking.refundAmount || 0}`);
        console.log(`   📝 Cancellation Reason: ${booking.cancellationReason || 'N/A'}`);
        console.log(`   📅 Cancelled At: ${booking.cancelledAt || 'N/A'}`);
        console.log(`   ✅ Checked In: ${booking.checkedIn || false}`);
        console.log(`   ✅ Checked Out: ${booking.checkedOut || false}`);
        console.log(`   📊 Pricing Breakdown: ${booking.pricingBreakdown ? 'Present' : 'Missing'}`);
        console.log(`   📊 Subtotal: ₹${booking.subtotal || 0}`);
        console.log(`   📊 Tax Amount: ₹${booking.taxAmount || 0}`);
        console.log(`   📊 Platform Fee: ₹${booking.platformFee || 0}`);
        console.log(`   📊 Processing Fee: ₹${booking.processingFee || 0}`);
        console.log(`   📊 GST: ₹${booking.gst || 0}`);
        console.log(`   📊 Host Fee: ₹${booking.hostFee || 0}`);
        console.log(`   📊 Discount Amount: ₹${booking.discountAmount || 0}`);
        console.log(`   📊 Host Earning: ₹${booking.hostEarning || 0}`);
        console.log(`   📊 Cleaning Fee: ₹${booking.cleaningFee || 0}`);
        console.log(`   📊 Service Fee: ₹${booking.serviceFee || 0}`);
        console.log(`   📊 Security Deposit: ₹${booking.securityDeposit || 0}`);
        console.log(`   📊 Hourly Extension: ₹${booking.hourlyExtension || 0}`);
        console.log(`   📊 Currency: ${booking.currency || 'INR'}`);
        console.log(`   📊 Cancellation Policy: ${booking.cancellationPolicy || 'N/A'}`);
        console.log(`   📊 Booking Reference: ${booking.bookingReference || 'N/A'}`);
        console.log(`   📊 Notes: ${booking.notes || 'N/A'}`);
        console.log(`   📊 Metadata: ${booking.metadata ? JSON.stringify(booking.metadata) : 'N/A'}`);
        console.log(`   📅 Updated At: ${booking.updatedAt.toISOString()}`);
        console.log(`   📅 Last Modified: ${booking.lastModified || 'N/A'}`);
        console.log(`   🔄 Is Active: ${booking.isActive !== false}`);
        console.log(`   🔄 Is Deleted: ${booking.isDeleted || false}`);
        console.log(`   🔄 Deleted At: ${booking.deletedAt || 'N/A'}`);
        console.log(`   🔄 Deleted By: ${booking.deletedBy || 'N/A'}`);
        console.log(`   🔄 Deletion Reason: ${booking.deletionReason || 'N/A'}`);
        console.log(`   🔄 Version: ${booking.__v || 0}`);
        console.log(`   🔄 Document ID: ${booking.id || 'N/A'}`);
        console.log(`   🔄 To Object: ${JSON.stringify(booking.toObject ? booking.toObject() : 'N/A')}`);
        console.log(`   🔄 JSON: ${JSON.stringify(booking, null, 2)}`);
        console.log('   ========================================');
      });

      console.log(`\n🔄 Proceeding to clean up ${expiredBlockedBookings.length} expired blocked bookings...`);

      const blockedResult = await Booking.updateMany(
        {
          _id: { $in: expiredBlockedBookings.map(b => b._id) }
        },
        {
          $set: {
            status: 'cancelled',
            cancellationReason: 'Expired - payment not completed within 3 minutes',
            cancelledAt: new Date()
          }
        }
      );

      totalCleaned += blockedResult.modifiedCount;
      console.log(`✅ Successfully cleaned up ${blockedResult.modifiedCount} expired blocked bookings`);
      console.log(`📊 Expected: ${expiredBlockedBookings.length}, Actual: ${blockedResult.modifiedCount}`);
    } else {
      console.log('✅ No expired blocked bookings found to clean up');
    }

    // 3. Check for any pending bookings (should NOT be cleaned up)
    console.log('\n🔍 Step 3: Checking for pending bookings (should NOT be cleaned up)...');
    const pendingBookings = await Booking.find({
      status: 'pending',
      createdAt: { $lt: threeMinutesAgo }
    }).populate('user', 'name email _id').populate('host', 'name email _id');

    console.log(`📊 Found ${pendingBookings.length} pending bookings older than 3 minutes (these should NOT be cleaned up)`);

    if (pendingBookings.length > 0) {
      console.log('📋 PENDING BOOKING INFORMATION (NOT CLEANED UP):');
      console.log('==============================================');

      // pendingBookings.forEach((booking, index) => {
      //   console.log(`\n📝 Pending Booking #${index + 1} (PROTECTED):`);
      //   console.log(`   🆔 Booking ID: ${booking._id}`);
      //   console.log(`   👤 User ID: ${booking.user?._id || booking.user}`);
      //   console.log(`   👤 User Name: ${booking.user?.name || 'N/A'}`);
      //   console.log(`   👤 User Email: ${booking.user?.email || 'N/A'}`);
      //   console.log(`   🏠 Host ID: ${booking.host?._id || booking.host}`);
      //   console.log(`   🏠 Host Name: ${booking.host?.name || 'N/A'}`);
      //   console.log(`   🏠 Host Email: ${booking.host?.email || 'N/A'}`);
      //   console.log(`   📊 Status: ${booking.status} (PROTECTED - waiting for host approval)`);
      //   console.log(`   💰 Total Amount: ₹${booking.totalAmount}`);
      //   console.log(`   📅 Created At: ${booking.createdAt.toISOString()}`);
      //   console.log(`   ⏰ Age: ${Math.round((now - booking.createdAt) / 1000 / 60)} minutes`);
      //   console.log(`   🏠 Property: ${booking.listing || 'N/A'}`);
      //   console.log(`   🎯 Service: ${booking.service || 'N/A'}`);
      //   console.log(`   📝 Payment Status: ${booking.paymentStatus || 'N/A'}`);
      //   console.log(`   🔄 Booking Type: ${booking.bookingType || 'N/A'}`);
      //   console.log(`   📅 Check-in: ${booking.checkIn || 'N/A'}`);
      //   console.log(`   📅 Check-out: ${booking.checkOut || 'N/A'}`);
      //   console.log(`   ⏰ Time Slot: ${booking.timeSlot ? JSON.stringify(booking.timeSlot) : 'N/A'}`);
      //   console.log(`   📝 Special Requests: ${booking.specialRequests || 'N/A'}`);
      //   console.log(`   👥 Guest Details: ${booking.guestDetails ? JSON.stringify(booking.guestDetails) : 'N/A'}`);
      //   console.log(`   🎫 Coupon: ${booking.couponCode || 'N/A'}`);
      //   console.log(`   💳 Payment ID: ${booking.payment || 'N/A'}`);
      //   console.log(`   🔄 Refund Status: ${booking.refundStatus || 'N/A'}`);
      //   console.log(`   🔄 Refund Amount: ₹${booking.refundAmount || 0}`);
      //   console.log(`   📝 Cancellation Reason: ${booking.cancellationReason || 'N/A'}`);
      //   console.log(`   📅 Cancelled At: ${booking.cancelledAt || 'N/A'}`);
      //   console.log(`   ✅ Checked In: ${booking.checkedIn || false}`);
      //   console.log(`   ✅ Checked Out: ${booking.checkedOut || false}`);
      //   console.log(`   📊 Pricing Breakdown: ${booking.pricingBreakdown ? 'Present' : 'Missing'}`);
      //   console.log(`   📊 Subtotal: ₹${booking.subtotal || 0}`);
      //   console.log(`   📊 Tax Amount: ₹${booking.taxAmount || 0}`);
      //   console.log(`   📊 Platform Fee: ₹${booking.platformFee || 0}`);
      //   console.log(`   📊 Processing Fee: ₹${booking.processingFee || 0}`);
      //   console.log(`   📊 GST: ₹${booking.gst || 0}`);
      //   console.log(`   📊 Host Fee: ₹${booking.hostFee || 0}`);
      //   console.log(`   📊 Discount Amount: ₹${booking.discountAmount || 0}`);
      //   console.log(`   📊 Host Earning: ₹${booking.hostEarning || 0}`);
      //   console.log(`   📊 Cleaning Fee: ₹${booking.cleaningFee || 0}`);
      //   console.log(`   📊 Service Fee: ₹${booking.serviceFee || 0}`);
      //   console.log(`   📊 Security Deposit: ₹${booking.securityDeposit || 0}`);
      //   console.log(`   📊 Hourly Extension: ₹${booking.hourlyExtension || 0}`);
      //   console.log(`   📊 Currency: ${booking.currency || 'INR'}`);
      //   console.log(`   📊 Cancellation Policy: ${booking.cancellationPolicy || 'N/A'}`);
      //   console.log(`   📊 Booking Reference: ${booking.bookingReference || 'N/A'}`);
      //   console.log(`   📊 Notes: ${booking.notes || 'N/A'}`);
      //   console.log(`   📊 Metadata: ${booking.metadata ? JSON.stringify(booking.metadata) : 'N/A'}`);
      //   console.log(`   📅 Updated At: ${booking.updatedAt.toISOString()}`);
      //   console.log(`   📅 Last Modified: ${booking.lastModified || 'N/A'}`);
      //   console.log(`   🔄 Is Active: ${booking.isActive !== false}`);
      //   console.log(`   🔄 Is Deleted: ${booking.isDeleted || false}`);
      //   console.log(`   🔄 Deleted At: ${booking.deletedAt || 'N/A'}`);
      //   console.log(`   🔄 Deleted By: ${booking.deletedBy || 'N/A'}`);
      //   console.log(`   🔄 Deletion Reason: ${booking.deletionReason || 'N/A'}`);
      //   console.log(`   🔄 Version: ${booking.__v || 0}`);
      //   console.log(`   🔄 Document ID: ${booking.id || 'N/A'}`);
      //   console.log(`   🔄 To Object: ${JSON.stringify(booking.toObject ? booking.toObject() : 'N/A')}`);
      //   console.log(`   🔄 JSON: ${JSON.stringify(booking, null, 2)}`);
      //   console.log('   ========================================');
      // });
    } else {
      console.log('✅ No pending bookings found (all good)');
    }

    // 4. Final summary
    console.log('\n📊 ===========================================');
    console.log('📊 CLEANUP SUMMARY');
    console.log('📊 ===========================================');
    console.log(`📊 Total incomplete payment bookings found: ${incompleteBookings.length}`);
    console.log(`📊 Total expired blocked bookings found: ${expiredBlockedBookings.length}`);
    console.log(`📊 Total pending bookings found (protected): ${pendingBookings.length}`);
    console.log(`📊 Total bookings cleaned up: ${totalCleaned}`);
    console.log(`📊 Cleanup threshold: ${threeMinutesAgo.toISOString()}`);
    console.log(`📊 Current time: ${now.toISOString()}`);
    console.log('📊 ===========================================');

    if (totalCleaned === 0) {
      console.log('✅ No expired blocked/payment bookings found');
    } else {
      console.log(`✅ Total cleaned up: ${totalCleaned} expired blocked/payment bookings`);
    }

    return { cleaned: totalCleaned };
  } catch (error) {
    console.error('❌ Error cleaning up expired bookings:', error);
    console.error('❌ Error stack:', error.stack);
    console.error('❌ Error details:', JSON.stringify(error, null, 2));
    throw error;
  }
};

// @desc    Release booking dates (admin only)
// @route   POST /api/bookings/admin/:id/release-dates
// @access  Private (Admin only)
const releaseBookingDates = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Release property dates back to availability system
    if (booking.listing && booking.checkIn && booking.checkOut) {
      try {
        console.log('🔄 Admin releasing property dates back to availability system...');

        // Generate array of dates to release
        const startDate = new Date(booking.checkIn);
        const endDate = new Date(booking.checkOut);
        const datesToRelease = [];

        let currentDate = new Date(startDate);
        while (currentDate < endDate) {
          const dateStr = currentDate.toISOString().split('T')[0];
          datesToRelease.push(dateStr);
          currentDate.setDate(currentDate.getDate() + 1);
        }

        console.log('📅 Property dates to release:', datesToRelease);

        // Update availability records to mark dates as available again
        const updateResult = await Availability.updateMany(
          {
            property: booking.listing,
            date: { $in: datesToRelease },
            status: 'booked'
          },
          {
            $set: {
              status: 'available',
              bookedBy: null,
              bookedAt: null,
              reason: null
            },
            $unset: {
              bookingId: 1
            }
          }
        );

        console.log(`✅ Successfully released ${updateResult.modifiedCount} property dates back to available status`);

        // Also handle any blocked dates that might still exist
        await Availability.updateMany(
          {
            property: booking.listing,
            date: { $in: datesToRelease },
            status: 'blocked'
          },
          {
            $set: {
              status: 'available',
              blockedBy: null,
              blockedAt: null,
              reason: null
            }
          }
        );

      } catch (availabilityError) {
        console.error('⚠️ Error releasing property dates to availability system:', availabilityError);
        return res.status(500).json({
          success: false,
          message: 'Error releasing property dates',
          error: availabilityError.message
        });
      }
    }

    // Handle service booking time slot release
    if (booking.service && booking.timeSlot) {
      try {
        console.log('🔄 Admin releasing service time slot back to availability system...');

        // For services, we need to release the specific time slot
        const timeSlotUpdate = await Availability.updateMany(
          {
            service: booking.service,
            date: new Date(booking.timeSlot.startTime).toISOString().split('T')[0],
            status: 'booked'
          },
          {
            $set: {
              status: 'available',
              bookedBy: null,
              bookedAt: null,
              reason: null
            },
            $unset: {
              bookingId: 1
            }
          }
        );

        console.log(`✅ Successfully released service time slot back to available status`);

      } catch (availabilityError) {
        console.error('⚠️ Error releasing service time slot to availability system:', availabilityError);
        return res.status(500).json({
          success: false,
          message: 'Error releasing service time slot',
          error: availabilityError.message
        });
      }
    }

    // Update booking status to reflect the release
    booking.status = 'cancelled';
    booking.cancellationReason = reason || 'Dates released by administrator';
    booking.cancelledAt = new Date();
    booking.cancelledBy = req.user._id;
    booking.adminAction = true;

    await booking.save();

    // Create notification for both user and host
    const notificationData = [
      {
        user: booking.user,
        type: 'admin_action',
        title: 'Booking Dates Released',
        message: `Your booking dates have been released by an administrator`,
        metadata: { bookingId: booking._id, reason: reason || 'Administrative action' }
      },
      {
        user: booking.host,
        type: 'admin_action',
        title: 'Booking Dates Released',
        message: `A guest's booking dates have been released by an administrator`,
        metadata: { bookingId: booking._id, reason: reason || 'Administrative action' }
      }
    ];

    await Notification.insertMany(notificationData);

    res.status(200).json({
      success: true,
      message: 'Booking dates released successfully',
      data: {
        booking: {
          _id: booking._id,
          status: booking.status,
          cancelledAt: booking.cancelledAt,
          cancellationReason: booking.cancellationReason
        },
        datesReleased: true,
        message: 'The booking dates have been released and are now available for other guests'
      }
    });
  } catch (error) {
    console.error('Error releasing booking dates:', error);
    res.status(500).json({
      success: false,
      message: 'Error releasing booking dates',
      error: error.message
    });
  }
};

// @desc    Calculate hourly booking price
// @route   POST /api/bookings/calculate-hourly-price
// @access  Public
const calculateHourlyPrice = async (req, res) => {
  try {
    const {
      propertyId,
      checkIn,
      checkOut,
      hourlyExtension,
      guests
    } = req.body;

    // Validate required fields
    if (!propertyId || !checkIn || !checkOut) {
      return res.status(400).json({
        success: false,
        message: 'Property ID, check-in, and check-out dates are required'
      });
    }

    // Find property
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    // Check if hourly booking is enabled
    if (!property.hourlyBooking?.enabled) {
      return res.status(400).json({
        success: false,
        message: 'Hourly booking is not enabled for this property'
      });
    }

    // Calculate pricing using centralized system
    const pricingParams = {
      basePrice: property.pricing.basePrice,
      nights: (() => {
        const checkInDate = new Date(checkIn);
        const checkOutDate = new Date(checkOut);
        const checkInDateOnly = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate());
        const checkOutDateOnly = new Date(checkOutDate.getFullYear(), checkOutDate.getMonth(), checkOutDate.getDate());
        const diffTime = checkOutDateOnly - checkInDateOnly;
        const diffDays = diffTime / (1000 * 60 * 60 * 24);
        return Math.max(0, diffDays);
      })(),
      extraGuestPrice: property.pricing.extraGuestPrice || 0,
      extraGuests: guests && guests.adults > 1 ? guests.adults - 1 : 0,
      cleaningFee: property.pricing.cleaningFee || 0,
      serviceFee: property.pricing.serviceFee || 0,
      securityDeposit: property.pricing.securityDeposit || 0,
      hourlyExtension: hourlyExtension ? calculateHourlyExtension(property.pricing.basePrice, hourlyExtension) : 0,
      discountAmount: 0,
      currency: property.pricing.currency
    };

    // Validate minimum stay
    if (pricingParams.nights < property.hourlyBooking.minStayDays) {
      return res.status(400).json({
        success: false,
        message: `Minimum stay required: ${property.hourlyBooking.minStayDays} days`
      });
    }

    // Calculate final pricing breakdown using unified utilities
    const pricing = await calculatePricingBreakdown(pricingParams);

    // Create hourly-specific breakdown for display
    const hourlyBreakdown = hourlyExtension ? {
      hours: hourlyExtension,
      rate: property.hourlyBooking.hourlyRates?.[`${hourlyExtension === 6 ? 'six' : hourlyExtension === 12 ? 'twelve' : 'eighteen'}Hours`] || 0,
      description: `${hourlyExtension}-hour extension (${toTwoDecimals((property.hourlyBooking.hourlyRates?.[`${hourlyExtension === 6 ? 'six' : hourlyExtension === 12 ? 'twelve' : 'eighteen'}Hours`] || 0) * 100)}% of daily rate)`,
      total: pricing.hourlyExtension
    } : null;

    const breakdown = {
      daily: {
        nights: pricingParams.nights,
        basePrice: pricing.baseAmount,
        extraGuests: pricing.extraGuestCost,
        total: pricing.baseAmount + pricing.extraGuestCost
      },
      hourly: hourlyBreakdown,
      fees: {
        cleaningFee: pricing.cleaningFee,
        serviceFee: pricing.serviceFee,
        securityDeposit: pricing.securityDeposit,
        platformFee: pricing.platformFee,
        hostEarning: pricing.hostEarning
      },
      totals: {
        subtotal: pricing.subtotal,
        total: pricing.totalAmount
      }
    };

    res.status(200).json({
      success: true,
      data: {
        breakdown,
        currency: property.pricing.currency,
        checkInTime: property.checkInTime || '15:00',
        checkOutTime: property.checkOutTime || '11:00'
      }
    });

  } catch (error) {
    console.error('Hourly price calculation error:', error);
    res.status(500).json({
      success: false,
      message: 'Error calculating hourly price',
      error: error.message
    });
  }
};

// @desc    Get hourly booking settings for a property
// @route   GET /api/bookings/property/:id/hourly-settings
// @access  Public
const getHourlySettings = async (req, res) => {
  try {
    const { id } = req.params;

    const property = await Property.findById(id).select('hourlyBooking checkInTime checkOutTime');
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        hourlyBooking: property.hourlyBooking,
        checkInTime: property.checkInTime || '15:00',
        checkOutTime: property.checkOutTime || '11:00'
      }
    });

  } catch (error) {
    console.error('Get hourly settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching hourly settings',
      error: error.message
    });
  }
};

// @desc    Process security deposit refund
// @route   POST /api/bookings/:id/refund-security-deposit
// @access  Private (Host only)
const refundSecurityDeposit = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, notes } = req.body;

    const booking = await Booking.findById(id)
      .populate('user', 'name email')
      .populate('host', 'name email')
      .populate('payment');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Check if user is the host
    if (booking.host._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only the host can refund security deposit.'
      });
    }

    // Check if booking is completed or cancelled
    if (!['completed', 'cancelled'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: 'Security deposit can only be refunded for completed or cancelled bookings'
      });
    }

    // Process security deposit refund
    const refund = await RefundService.processRefund(
      booking._id,
      'guest_request',
      'security_deposit_only',
      {
        userNotes: `Security deposit refund requested by host: ${reason || 'No reason provided'}`,
        adminNotes: `Host notes: ${notes || 'No additional notes'}`
      }
    );

    // Create notification for guest
    await Notification.create({
      user: booking.user._id,
      type: 'refund',
      title: 'Security Deposit Refund Processed',
      message: `Your security deposit of ₹${refund.amount} has been refunded. It will be credited to your original payment method within 3-5 business days.`,
      relatedEntity: {
        type: 'Refund',
        id: refund._id
      }
    });

    res.status(200).json({
      success: true,
      message: 'Security deposit refund processed successfully',
      data: {
        refund,
        message: `Security deposit refund of ₹${refund.amount} has been processed.`
      }
    });
  } catch (error) {
    console.error('Error processing security deposit refund:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing security deposit refund',
      error: error.message
    });
  }
};

// @desc    Get refund history for user
// @route   GET /api/bookings/refunds
// @access  Private
const getRefundHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;

    const refundHistory = await RefundService.getRefundHistory(req.user._id, {
      page: parseInt(page),
      limit: parseInt(limit),
      status
    });

    res.status(200).json({
      success: true,
      data: refundHistory
    });
  } catch (error) {
    console.error('Error fetching refund history:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching refund history',
      error: error.message
    });
  }
};

// @desc    Get refund details for a specific booking
// @route   GET /api/bookings/:id/refund
// @access  Private
const getBookingRefund = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user can access this booking
    const booking = await Booking.findById(id)
      .populate('user', 'name email')
      .populate('host', 'name email');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Check authorization
    const isBookingOwner = booking.user && (
      (typeof booking.user === 'string' && booking.user === req.user._id.toString()) ||
      (booking.user._id && booking.user._id.toString() === req.user._id.toString())
    );

    const isHost = booking.host && (
      (typeof booking.host === 'string' && booking.host === req.user._id.toString()) ||
      (booking.host._id && booking.host._id.toString() === req.user._id.toString())
    );

    if (!isBookingOwner && !isHost && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only view refunds for your own bookings.'
      });
    }

    // Get refund details from Refund model
    const Refund = require('../models/Refund');
    const refunds = await Refund.find({ booking: id })
      .populate('payment', 'amount paymentMethod status')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: {
        booking: {
          _id: booking._id,
          status: booking.status,
          totalAmount: booking.totalAmount,
          refundAmount: booking.refundAmount,
          refunded: booking.refunded,
          refundStatus: booking.refundStatus
        },
        refunds: refunds
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching booking refund details',
      error: error.message
    });
  }
};

// @desc    Get all pending refunds (admin only)
// @route   GET /api/bookings/admin/refunds/pending
// @access  Private (Admin only)
const getPendingRefunds = async (req, res) => {
  try {
    const { page = 1, limit = 20, reason, type } = req.query;

    const pendingRefunds = await RefundService.getPendingRefunds({
      page: parseInt(page),
      limit: parseInt(limit),
      reason,
      type
    });

    res.status(200).json({
      success: true,
      data: pendingRefunds
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching pending refunds',
      error: error.message
    });
  }
};

// @desc    Admin approve refund
// @route   PUT /api/bookings/admin/refunds/:id/approve
// @access  Private (Admin only)
const approveRefund = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNotes } = req.body;

    const refund = await RefundService.approveRefund(id, req.user._id, adminNotes);

    res.status(200).json({
      success: true,
      message: 'Refund approved successfully',
      data: refund
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error approving refund',
      error: error.message
    });
  }
};

// @desc    Admin reject refund
// @route   PUT /api/bookings/admin/refunds/:id/reject
// @access  Private (Admin only)
const rejectRefund = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNotes } = req.body;

    const refund = await RefundService.rejectRefund(id, req.user._id, adminNotes);

    res.status(200).json({
      success: true,
      message: 'Refund rejected successfully',
      data: refund
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error rejecting refund',
      error: error.message
    });
  }
};

// @desc    Admin mark refund as processing
// @route   PUT /api/bookings/admin/refunds/:id/processing
// @access  Private (Admin only)
const markRefundAsProcessing = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNotes } = req.body;

    const refund = await RefundService.markRefundAsProcessing(id, req.user._id, adminNotes);

    res.status(200).json({
      success: true,
      message: 'Refund marked as processing successfully',
      data: refund
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error marking refund as processing',
      error: error.message
    });
  }
};

// @desc    Admin mark refund as completed
// @route   PUT /api/bookings/admin/refunds/:id/complete
// @access  Private (Admin only)
const markRefundAsCompleted = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNotes } = req.body;

    const refund = await RefundService.markRefundAsCompleted(id, req.user._id, adminNotes);

    res.status(200).json({
      success: true,
      message: 'Refund marked as completed successfully',
      data: refund
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error marking refund as completed',
      error: error.message
    });
  }
};

// @desc    Process 24-hour booking with payment
// @route   POST /api/bookings/process-24hour-payment
// @access  Private
const process24HourBooking = async (req, res) => {
  try {
    const {
      propertyId,
      checkInDateTime, // Exact check-in time
      extensionHours = 0, // 6, 12, or 18
      guests,
      specialRequests,
      couponCode,
      contactInfo,
      paymentMethod,
      idempotencyKey,
      paymentData
    } = req.body;

    // Generate idempotency key if not provided
    const finalIdempotencyKey = idempotencyKey || require('crypto').randomUUID();

    // Check for duplicate booking with same idempotency key
    const existingBooking = await Booking.findOne({
      'metadata.idempotencyKey': finalIdempotencyKey,
      user: req.user._id
    });

    if (existingBooking) {
      return res.status(409).json({
        success: false,
        message: 'Booking with this idempotency key already exists',
        bookingId: existingBooking._id
      });
    }

    // Get property details
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({ success: false, message: 'Property not found' });
    }

    const host = await User.findById(property.host);
    if (!host) {
      return res.status(404).json({ success: false, message: 'Host not found' });
    }

    // Validate minimum 24 hours
    const totalHours = calculateTotalHours(24, extensionHours);
    if (totalHours < 24) {
      return res.status(400).json({
        success: false,
        message: 'Minimum 24 hours booking required'
      });
    }

    // Validate 24-hour booking parameters
    const validation = validate24HourBooking({
      checkInDateTime,
      totalHours,
      minHours: property.availabilitySettings?.minBookingHours || 24,
      maxHours: property.availabilitySettings?.maxBookingHours || 168
    });

    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking parameters',
        errors: validation.errors
      });
    }

    // Calculate checkout time
    const checkOutDateTime = calculateCheckoutTime(checkInDateTime, totalHours);

    // Check availability
    const isAvailable = await AvailabilityService.isTimeSlotAvailable(
      propertyId,
      checkInDateTime,
      checkOutDateTime
    );

    if (!isAvailable) {
      return res.status(400).json({
        success: false,
        message: 'Time slot not available'
      });
    }

    // Calculate pricing
    const pricingParams = {
      basePrice24Hour: property.pricing.basePrice24Hour || property.pricing.basePrice,
      totalHours,
      extraGuestPrice: property.pricing.extraGuestPrice,
      extraGuests: guests.adults > 1 ? guests.adults - 1 : 0,
      cleaningFee: property.pricing.cleaningFee,
      serviceFee: property.pricing.serviceFee,
      securityDeposit: property.pricing.securityDeposit,
      currency: property.pricing.currency,
      bookingType: '24hour'
    };

    // Apply coupon if provided
    let couponApplied = null;
    if (couponCode) {
      const coupon = await Coupon.findOne({
        code: couponCode.toUpperCase(),
        isActive: true,
        validFrom: { $lte: new Date() },
        validTo: { $gte: new Date() }
      });

      if (coupon) {
        const hasUsed = coupon.usedBy?.some(usage => usage.user.toString() === req.user._id.toString());
        if (!hasUsed) {
          // Calculate subtotal first to apply coupon discount
          const tempPricing = await calculate24HourPricing(pricingParams);
          let discountAmount = 0;

          if (coupon.discountType === 'percentage') {
            discountAmount = (tempPricing.subtotal * coupon.amount) / 100;
            const maxDiscount = coupon.maxDiscount || discountAmount;
            discountAmount = Math.min(discountAmount, maxDiscount);
          } else {
            discountAmount = coupon.amount;
          }

          pricingParams.discountAmount = discountAmount;
          couponApplied = coupon._id;
          coupon.usedCount += 1;
          coupon.usedBy.push({ user: req.user._id, usedAt: new Date() });
          await coupon.save();
        }
      }
    }

    // Calculate final pricing
    const pricing = await calculate24HourPricing(pricingParams);

    // Calculate next available time
    const hostBufferTime = property.availabilitySettings?.hostBufferTime || 2;
    const nextAvailableTime = calculateNextAvailableTime(checkOutDateTime, hostBufferTime);

    // Create booking
    const booking = await Booking.create({
      user: req.user._id,
      host: host._id,
      listing: propertyId,
      bookingType: 'property',
      bookingDuration: '24hour',
      checkInDateTime: new Date(checkInDateTime),
      checkOutDateTime: new Date(checkOutDateTime),
      checkIn: new Date(checkInDateTime), // For backward compatibility
      checkOut: new Date(checkOutDateTime), // For backward compatibility
      baseHours: 24,
      totalHours,
      hostBufferTime,
      nextAvailableTime,
      guests,
      totalAmount: pricing.totalAmount,
      subtotal: pricing.subtotal,
      taxAmount: pricing.gst,
      serviceFee: pricing.serviceFee,
      cleaningFee: pricing.cleaningFee,
      securityDeposit: pricing.securityDeposit,
      currency: property.pricing.currency,
      cancellationPolicy: property.cancellationPolicy || 'moderate',
      specialRequests: specialRequests || undefined,
      hourlyExtension: extensionHours > 0 ? {
        hours: extensionHours,
        rate: extensionHours === 6 ? 0.30 : extensionHours === 12 ? 0.60 : 0.75,
        totalHours: extensionHours
      } : undefined,
      contactInfo: contactInfo || undefined,
      paymentStatus: 'pending',
      refundAmount: 0,
      refunded: false,
      couponApplied,
      discountAmount: pricing.discountAmount,
      hostFee: pricing.hostEarning,
      platformFee: pricing.platformFee,
      processingFee: pricing.processingFee,
      gst: pricing.gst,
      pricingBreakdown: pricing.breakdown,
      metadata: {
        idempotencyKey: finalIdempotencyKey,
        userAgent: req.get('User-Agent'),
        ipAddress: req.ip,
        bookingType: '24hour',
        totalHours,
        extensionHours
      }
    });

    // Block availability
    await AvailabilityService.blockTimeSlot(
      propertyId,
      checkInDateTime,
      checkOutDateTime,
      booking._id
    );

    // Send notifications
    await Notification.create({
      user: host._id,
      type: 'new_booking',
      title: 'New 24-Hour Booking',
      message: `New 24-hour booking received for ${property.title}`,
      data: { bookingId: booking._id, propertyId: propertyId }
    });

    res.status(201).json({
      success: true,
      message: '24-hour booking created successfully',
      data: {
        booking,
        pricing,
        nextAvailableTime,
        totalHours,
        extensionHours
      }
    });
  } catch (error) {
    console.error('Error creating 24-hour booking:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating 24-hour booking',
      error: error.message
    });
  }
};

// @desc    Check 24-hour time slot availability
// @route   POST /api/bookings/check-24hour-availability
// @access  Private
const check24HourAvailability = async (req, res) => {
  try {
    const { propertyId, checkInDateTime, extensionHours = 0 } = req.body;

    const totalHours = calculateTotalHours(24, extensionHours);
    const checkOutDateTime = calculateCheckoutTime(checkInDateTime, totalHours);

    const isAvailable = await AvailabilityService.isTimeSlotAvailable(
      propertyId,
      checkInDateTime,
      checkOutDateTime
    );

    res.json({
      success: true,
      available: isAvailable,
      checkInDateTime,
      checkOutDateTime,
      totalHours
    });
  } catch (error) {
    console.error('Error checking 24-hour availability:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking availability',
      error: error.message
    });
  }
};

// @desc    Get available 24-hour time slots
// @route   GET /api/bookings/24hour-slots/:propertyId
// @access  Private
const get24HourTimeSlots = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { startDate, endDate } = req.query;

    // Get property details
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    // Parse dates
    const start = new Date(startDate);
    const end = new Date(endDate);

    // Generate time slots for the next 30 days if no dates provided
    const now = new Date();
    const startDateToUse = startDate ? start : now;
    const endDateToUse = endDate ? end : new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000)); // 30 days from now

    // Generate hourly time slots (every hour from 6 AM to 10 PM)
    const timeSlots = [];
    const currentDate = new Date(startDateToUse);

    while (currentDate <= endDateToUse) {
      // Generate slots for each day from 6 AM to 10 PM
      for (let hour = 6; hour <= 22; hour++) {
        const slotStart = new Date(currentDate);
        slotStart.setHours(hour, 0, 0, 0);

        const slotEnd = new Date(slotStart);
        slotEnd.setHours(slotStart.getHours() + 24);

        // Check if this time slot is available
        const isAvailable = await AvailabilityService.isTimeSlotAvailable(
          propertyId,
          slotStart,
          slotEnd
        );

        timeSlots.push({
          startDateTime: slotStart.toISOString(),
          endDateTime: slotEnd.toISOString(),
          duration: 24,
          isAvailable: isAvailable
        });
      }

      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Filter to only show available slots
    const availableSlots = timeSlots.filter(slot => slot.isAvailable);

    res.json({
      success: true,
      timeSlots: availableSlots,
      totalSlots: timeSlots.length,
      availableSlots: availableSlots.length
    });
  } catch (error) {
    console.error('Error getting 24-hour time slots:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting time slots',
      error: error.message
    });
  }
};

module.exports = {
  // Guest functions
  processPaymentAndCreateBooking,
  createBooking,
  getMyBookings,
  getBookingById: getBooking,
  cancelBooking,
  downloadReceipt,
  getCancellationInfo,

  // Host functions
  getHostBookings,
  acceptBooking,
  rejectBooking,
  updateBookingStatus,
  checkInGuest,
  getBookingStats,

  // Admin functions
  getAdminBookingStats,
  getAllBookings,
  adminUpdateBookingStatus,
  adminDeleteBooking,
  releaseBookingDates,

  // Shared functions
  calculateBookingPrice,

  // Hourly booking functions
  calculateHourlyPrice,
  getHourlySettings,

  // Utility functions
  cleanupExpiredBlockedBookings,

  // Refund functions
  refundSecurityDeposit,
  getRefundHistory,
  getBookingRefund,

  // Admin refund management
  getPendingRefunds,
  approveRefund,
  rejectRefund,
  markRefundAsProcessing,
  markRefundAsCompleted,

  // 24-hour booking functions
  process24HourBooking,
  check24HourAvailability,
  get24HourTimeSlots,

  // Legacy aliases for backward compatibility
  getBooking,
  getBookingStats,

  // Pre-payment validation (run all checks BEFORE charging)
  preValidateBooking
};


