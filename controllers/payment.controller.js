const Payment = require('../models/Payment');
const Payout = require('../models/Payout');
const Booking = require('../models/Booking');
const User = require('../models/User');
const Coupon = require('../models/Coupon');
const Refund = require('../models/Refund');
const Notification = require('../models/Notification');
const Service = require('../models/Service');
const PaymentService = require('../services/payment.service');
const razorpayService = require('../services/razorpay.service');
const { logger } = require('../config/logger');
const { verifyPricingToken } = require('../middlewares/pricingSecurity.middleware');
const { 
  verifyPaymentAmount, 
  validateBookingParameters,
  paymentRateLimit,
  paymentSessionManager,
  generateIdempotencyKey,
  verifyWebhookSignature
} = require('../utils/paymentSecurity');

// @desc    Process payment (enhanced with fee calculation)
// @route   POST /api/payments/process
// @access  Private
const processPayment = async (req, res) => {
  try {
    const { bookingId, paymentMethod, couponCode, ipAddress, userAgent, paymentData, idempotencyKey } = req.body;
    
    // Rate limiting check
    if (!paymentRateLimit.isAllowed(req.user._id)) {
      const remainingAttempts = paymentRateLimit.getRemainingAttempts(req.user._id);
      return res.status(429).json({ 
        success: false, 
        message: 'Too many payment attempts. Please try again later.',
        remainingAttempts,
        retryAfter: 15 * 60 // 15 minutes in seconds
      });
    }
    
    // Validate idempotency key
    if (!idempotencyKey) {
      return res.status(400).json({ 
        success: false, 
        message: 'Idempotency key is required for payment processing' 
      });
    }
    
    // Check for duplicate payment with same idempotency key
    const existingPayment = await Payment.findOne({ 
      'metadata.idempotencyKey': idempotencyKey,
      user: req.user._id
    });
    
    if (existingPayment) {
      return res.status(409).json({ 
        success: false, 
        message: 'Payment with this idempotency key already exists',
        paymentId: existingPayment._id
      });
    }
    
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    
    // Verify user owns the booking
    if (booking.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ 
        success: false, 
        message: 'You are not authorized to pay for this booking' 
      });
    }
    
    // Validate booking parameters for security
    const bookingValidation = validateBookingParameters({
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guests: booking.guests,
      basePrice: booking.listing?.pricing?.basePrice || booking.service?.pricing?.basePrice,
      hourlyExtension: booking.hourlyExtension
    });
    
    if (!bookingValidation.isValid) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid booking parameters',
        errors: bookingValidation.errors
      });
    }
    
    // Verify payment amount only when pricing fields are present
    if (paymentData && paymentData.amount != null && paymentData.subtotal != null) {
      const amountVerification = verifyPaymentAmount(paymentData, {
        basePrice: booking.listing?.pricing?.basePrice || booking.service?.pricing?.basePrice || 0,
        nights: booking.bookingDuration === 'daily' ? 
          Math.ceil((new Date(booking.checkOut) - new Date(booking.checkIn)) / (1000 * 60 * 60 * 24)) : 1,
        cleaningFee: booking.cleaningFee || 0,
        serviceFee: booking.serviceFee || 0,
        securityDeposit: booking.securityDeposit || 0,
        extraGuestPrice: booking.listing?.pricing?.extraGuestPrice || booking.service?.pricing?.perPersonPrice || 0,
        extraGuests: booking.guests?.adults > 1 ? booking.guests.adults - 1 : 0,
        hourlyExtension: booking.hourlyExtension?.cost || 0,
        discountAmount: booking.discountAmount || 0,
        currency: booking.currency || 'INR'
      });
      
      if (!amountVerification.isValid) {
        return res.status(400).json({ 
          success: false, 
          message: 'Payment amount verification failed',
          errors: amountVerification.errors,
          expectedAmount: amountVerification.expectedAmount,
          actualAmount: amountVerification.actualAmount
        });
      }
    }
    
    // Check if payment already exists for this booking
    const existingBookingPayment = await Payment.findOne({ booking: bookingId });
    if (existingBookingPayment) {
      return res.status(400).json({ 
        success: false, 
        message: 'Payment already exists for this booking',
        paymentId: existingBookingPayment._id,
        status: existingBookingPayment.status
      });
    }
    
    // Create payment session for tracking
    const sessionId = paymentSessionManager.createSession({
      bookingId,
      userId: req.user._id,
      paymentMethod,
      amount: booking.totalAmount,
      currency: booking.currency
    });
    
    // Apply coupon if provided (using atomic operation to prevent race conditions)
    let coupon = null;
    if (couponCode) {
      // Atomic findOneAndUpdate prevents double-redemption race condition
      coupon = await Coupon.findOneAndUpdate(
        { 
          code: couponCode.toUpperCase(), 
          isActive: true, 
          validFrom: { $lte: new Date() }, 
          validTo: { $gte: new Date() },
          'usedBy.user': { $ne: req.user._id },
          $expr: { $lt: ['$usedCount', '$maxUses'] }
        },
        {
          $inc: { usedCount: 1 },
          $push: { usedBy: { user: req.user._id, usedAt: new Date() } }
        },
        { new: true }
      );
      
      if (coupon) {
        if (coupon.discountType === 'percentage') {
          const discount = (booking.subtotal * coupon.amount) / 100;
          const maxDiscount = coupon.maxDiscount || discount;
          booking.discountAmount = Math.min(discount, maxDiscount);
        } else {
          booking.discountAmount = coupon.amount;
        }
        booking.couponApplied = coupon._id;
      }
    }
    
    if (!paymentData || !paymentData.razorpayOrderId || !paymentData.razorpayPaymentId || !paymentData.razorpaySignature) {
      return res.status(400).json({
        success: false,
        message: 'Razorpay payment proof is required'
      });
    }

    // Verify Razorpay payment
    let razorpayOrderId = paymentData.razorpayOrderId;
    let razorpayPaymentId = paymentData.razorpayPaymentId;
    let razorpaySignature = paymentData.razorpaySignature;
    let isPaymentVerified = false;
    let razorpayPaymentDetails = null;

    {
      // Verify payment signature
      isPaymentVerified = razorpayService.verifyPayment(
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature
      );

      if (!isPaymentVerified) {
        return res.status(400).json({
          success: false,
          message: 'Invalid payment signature. Payment verification failed.'
        });
      }

      // Get payment details from Razorpay
      try {
        razorpayPaymentDetails = await razorpayService.getPaymentDetails(razorpayPaymentId);
      } catch (razorpayError) {
        logger.error('Error fetching Razorpay payment details', { error: razorpayError.message });
        return res.status(400).json({
          success: false,
          message: 'Failed to verify payment with Razorpay',
          error: razorpayError.message
        });
      }

      const expectedAmountPaise = Math.round(Number(booking.totalAmount) * 100);
      const expectedCurrency = booking.currency || 'INR';
      const razorpayStatus = razorpayPaymentDetails?.status;

      if (razorpayPaymentDetails?.order_id !== razorpayOrderId) {
        return res.status(400).json({
          success: false,
          message: 'Razorpay order mismatch'
        });
      }

      const paidAmountPaise = Number(razorpayPaymentDetails?.amount);
      const amountDiff = Math.abs(paidAmountPaise - expectedAmountPaise);
      // Allow tolerance of ₹1 (100 paise) to avoid false mismatches due to rounding
      if (amountDiff > 100) {
        return res.status(400).json({
          success: false,
          message: 'Razorpay amount mismatch',
          error: `Expected ${expectedAmountPaise}, got ${paidAmountPaise}`,
          amountDiffPaise: amountDiff
        });
      }

      if (razorpayPaymentDetails?.currency !== expectedCurrency) {
        return res.status(400).json({
          success: false,
          message: 'Razorpay currency mismatch'
        });
      }

      if (!['authorized', 'captured'].includes(razorpayStatus)) {
        return res.status(400).json({
          success: false,
          message: `Payment status is not successful: ${razorpayStatus || 'unknown'}`
        });
      }
    }

    // Process payment using PaymentService with enhanced security
    const paymentServiceData = {
      paymentMethod,
      transactionId: razorpayPaymentId || `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      gateway: 'razorpay',
      gatewayResponse: razorpayPaymentDetails,
      ipAddress: ipAddress || req.ip,
      userAgent: userAgent || req.get('User-Agent'),
      source: 'web',
      sessionId,
      idempotencyKey,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      securityMetadata: {
        userAgent: req.get('User-Agent'),
        ipAddress: req.ip,
        forwardedFor: req.get('X-Forwarded-For'),
        realIp: req.get('X-Real-IP'),
        referer: req.get('Referer'),
        origin: req.get('Origin'),
        timestamp: new Date().toISOString()
      }
    };
    
    const { payment, feeBreakdown } = await PaymentService.processPayment(bookingId, paymentServiceData, req.user);
    
    // Update booking status to confirmed after successful payment
    booking.status = 'confirmed';
    booking.paymentStatus = 'paid';
    await booking.save();
    logger.info('Booking confirmed after payment processing', { bookingId });
    
    // Update availability status to 'booked' after successful payment
    try {
      const { updateAvailabilityStatus } = require('./availability.controller');
      await updateAvailabilityStatus(booking._id, 'booked');
    } catch (availabilityError) {
      logger.error('Error updating availability status', { error: availabilityError.message });
      // Don't fail the payment if availability update fails
    }
    
    res.status(200).json({ 
      success: true, 
      message: 'Payment processed successfully', 
      data: { 
        payment,
        feeBreakdown,
        message: `Payment of ₹${payment.amount} processed successfully. Host will receive ₹${feeBreakdown.hostEarning} after 24 hours.`
      } 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Error processing payment', 
      error: error.message 
    });
  }
};

// @desc    Confirm payment - DISABLED (payment confirmation must go through gateway verification)
// @route   POST /api/payments/confirm/:paymentId
// @access  Private
const confirmPayment = async (req, res) => {
  return res.status(410).json({
    success: false,
    message: 'This endpoint has been deprecated. Payment confirmation is handled via gateway webhooks and the processPayment endpoint.'
  });
};

// @desc    Cancel payment (mock)
// @route   POST /api/payments/cancel/:paymentId
// @access  Private
const cancelPayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    
    if (payment.user.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    payment.status = 'cancelled';
    await payment.save();
    
    res.status(200).json({ 
      success: true, 
      message: 'Payment cancelled successfully' 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Error cancelling payment', 
      error: error.message 
    });
  }
};

// @desc    Get payment by ID with enhanced details
// @route   GET /api/payments/:id
// @access  Private
const getPaymentById = async (req, res) => {
  try {
    const { id } = req.params;

    const payment = await Payment.findById(id)
      .populate('booking', 'totalAmount currency checkIn checkOut receiptId')
      .populate('user', 'name email')
      .populate('host', 'name email')
      .populate('coupon', 'code discountType amount');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    // Check authorization
    if (payment.user.toString() !== req.user.id && 
        payment.host.toString() !== req.user.id && 
        req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this payment'
      });
    }

    // Get payout information if user is host
    let payoutInfo = null;
    if (payment.host.toString() === req.user.id) {
      payoutInfo = await Payout.findOne({ payment: payment._id })
        .select('status scheduledDate processedDate amount method');
    }

    // Get refund information
    const refunds = await Refund.find({ payment: payment._id })
      .select('amount reason type status processedAt refundReference');

    res.status(200).json({
      success: true,
      data: { 
        payment,
        payoutInfo,
        refunds,
        feeBreakdown: {
          subtotal: payment.subtotal,
          taxes: payment.taxes,
          cleaningFee: payment.cleaningFee,
          securityDeposit: payment.securityDeposit,
          platformFee: payment.commission.platformFee,
          hostEarning: payment.commission.hostEarning,
          totalAmount: payment.amount
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching payment',
      error: error.message
    });
  }
};

// @desc    Get user's payment history with enhanced details
// @route   GET /api/payments/history
// @access  Private
const getPaymentHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;

    const query = { user: req.user.id };
    if (status) {
      query.status = status;
    }

    const payments = await Payment.find(query)
      .populate('booking', 'totalAmount currency checkIn checkOut receiptId')
      .populate('host', 'name')
      .populate('coupon', 'code discountType amount')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Payment.countDocuments(query);

    // Enhance payment data with additional information
    const enhancedPayments = await Promise.all(payments.map(async (payment) => {
      const refunds = await Refund.find({ payment: payment._id })
        .select('amount status processedAt');
      
      return {
        ...payment.toObject(),
        totalRefunded: payment.totalRefunded,
        netAmount: payment.netAmount,
        refunds
      };
    }));

    res.status(200).json({
      success: true,
      data: {
        payments: enhancedPayments,
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
      message: 'Error fetching payment history',
      error: error.message
    });
  }
};

// @desc    Get host's payment and payout information
// @route   GET /api/payments/host
// @access  Private (Host only)
const getHostPayments = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;

    // Verify user is a host
    if (req.user.role !== 'host' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only hosts can access this endpoint'
      });
    }

    const query = { host: req.user.id };
    if (status) {
      query.status = status;
    }

    const payments = await Payment.find(query)
      .populate('booking', 'totalAmount currency checkIn checkOut receiptId')
      .populate('user', 'name email')
      .populate('coupon', 'code discountType amount')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Payment.countDocuments(query);

    // Get payout information for each payment
    const enhancedPayments = await Promise.all(payments.map(async (payment) => {
      const payout = await Payout.findOne({ payment: payment._id })
        .select('status scheduledDate processedDate amount method');
      
      return {
        ...payment.toObject(),
        payout,
        hostEarning: payment.commission.hostEarning,
        platformFee: payment.commission.platformFee
      };
    }));

    // Get host payout statistics
    const payoutStats = await PaymentService.getHostPayoutStats(req.user.id);

    res.status(200).json({
      success: true,
      data: {
        payments: enhancedPayments,
        payoutStats,
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
      message: 'Error fetching host payments',
      error: error.message
    });
  }
};

// @desc    Get payments for a specific booking
// @route   GET /api/payments/booking/:bookingId
// @access  Private
const getBookingPayments = async (req, res) => {
  try {
    const { bookingId } = req.params;
    
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    
    if (booking.user.toString() !== req.user.id && booking.host.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    const payments = await Payment.find({ booking: bookingId })
      .populate('user', 'name email')
      .populate('coupon', 'code discountType amount')
      .sort({ createdAt: -1 });
    
    res.status(200).json({
      success: true,
      data: { payments }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching booking payments',
      error: error.message
    });
  }
};

// @desc    Process refund with enhanced logic
// @route   POST /api/payments/:paymentId/refund
// @access  Private
const processRefund = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { amount, reason, type, userNotes } = req.body;
    
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    
    if (payment.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Can only refund completed payments' });
    }
    
    if (payment.user.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to refund this payment' });
    }
    
    if (amount > payment.amount) {
      return res.status(400).json({ success: false, message: 'Refund amount cannot exceed payment amount' });
    }
    
    // Process refund using PaymentService
    const refundData = {
      amount,
      reason,
      type,
      userNotes,
      adminNotes: req.user.role === 'admin' ? req.body.adminNotes : null
    };
    
    const refund = await PaymentService.processRefund(paymentId, refundData, req.user.role === 'admin' ? req.user : null);
    
    res.status(200).json({ 
      success: true, 
      message: 'Refund processed successfully', 
      data: { 
        refund,
        message: `Refund of ₹${amount} has been processed. It will be credited to your original payment method within 3-5 business days.`
      } 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Error processing refund', 
      error: error.message 
    });
  }
};

// @desc    Get refund history with enhanced details
// @route   GET /api/payments/refunds
// @access  Private
const getRefundHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    
    const refunds = await Refund.find({ user: req.user.id })
      .populate('payment', 'amount paymentMethod')
      .populate('booking', 'totalAmount currency')
      .populate('host', 'name')
      .sort({ processedAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();
    
    const total = await Refund.countDocuments({ user: req.user.id });
    
    res.status(200).json({
      success: true,
      data: {
        refunds,
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
      message: 'Error fetching refund history',
      error: error.message
    });
  }
};

// @desc    Get refund by ID
// @route   GET /api/payments/refunds/:refundId
// @access  Private
const getRefundById = async (req, res) => {
  try {
    const { refundId } = req.params;
    
    const refund = await Refund.findById(refundId)
      .populate('payment', 'amount paymentMethod')
      .populate('booking', 'totalAmount currency')
      .populate('user', 'name email');
    
    if (!refund) {
      return res.status(404).json({ success: false, message: 'Refund not found' });
    }
    
    if (refund.user.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    res.status(200).json({
      success: true,
      data: { refund }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching refund',
      error: error.message
    });
  }
};

// @desc    Get payment methods
// @route   GET /api/payments/methods
// @access  Private
const getPaymentMethods = async (req, res) => {
  try {
    const mockMethods = [
      {
        id: 'method_1',
        type: 'card',
        last4: '1234',
        brand: 'Visa',
        isDefault: true
      },
      {
        id: 'method_2',
        type: 'upi',
        upiId: 'user@upi',
        isDefault: false
      }
    ];
    
    res.status(200).json({
      success: true,
      data: { paymentMethods: mockMethods }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching payment methods',
      error: error.message
    });
  }
};

// @desc    Add payment method
// @route   POST /api/payments/methods
// @access  Private
const addPaymentMethod = async (req, res) => {
  try {
    const { type, details, isDefault } = req.body;
    
    res.status(201).json({
      success: true,
      message: 'Payment method added successfully',
      data: { 
        id: `method_${Date.now()}`,
        type,
        isDefault: isDefault || false
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error adding payment method',
      error: error.message
    });
  }
};

// @desc    Update payment method
// @route   PUT /api/payments/methods/:methodId
// @access  Private
const updatePaymentMethod = async (req, res) => {
  try {
    const { methodId } = req.params;
    const { details } = req.body;
    
    res.status(200).json({
      success: true,
      message: 'Payment method updated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating payment method',
      error: error.message
    });
  }
};

// @desc    Delete payment method
// @route   DELETE /api/payments/methods/:methodId
// @access  Private
const deletePaymentMethod = async (req, res) => {
  try {
    const { methodId } = req.params;
    
    res.status(200).json({
      success: true,
      message: 'Payment method deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting payment method',
      error: error.message
    });
  }
};

// @desc    Set default payment method
// @route   POST /api/payments/methods/:methodId/set-default
// @access  Private
const setDefaultPaymentMethod = async (req, res) => {
  try {
    const { methodId } = req.params;
    
    res.status(200).json({
      success: true,
      message: 'Default payment method updated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error setting default payment method',
      error: error.message
    });
  }
};

// @desc    Payment webhooks (enhanced security)
// @route   POST /api/payments/webhook/stripe
// @access  Public
const stripeWebhook = async (req, res) => {
  try {
    const signature = req.get('stripe-signature');
    const payload = req.rawBody || (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
    const parsedBody = Buffer.isBuffer(req.body) ? JSON.parse(payload) : req.body;
    
    // Always verify webhook signature — reject if secret not configured
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      logger.error('STRIPE_WEBHOOK_SECRET not configured, rejecting webhook');
      return res.status(503).json({ success: false, message: 'Webhook verification not configured' });
    }

    const isValidSignature = verifyWebhookSignature(
      payload, 
      signature, 
      process.env.STRIPE_WEBHOOK_SECRET
    );
    
    if (!isValidSignature) {
      logger.warn('Invalid Stripe webhook signature');
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid webhook signature' 
      });
    }
    
    // Log webhook for security audit
    logger.info('Stripe webhook received', {
      event: parsedBody?.type || null,
      ip: req.ip,
    });
    
    // Process webhook based on event type
    const event = parsedBody;
    
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSuccess(event.data.object);
        break;
      case 'payment_intent.payment_failed':
        await handleWebhookPaymentFailure(event.data.object);
        break;
      default:
        logger.debug('Unhandled Stripe event type', { type: event.type });
    }
    
    res.status(200).json({ received: true });
  } catch (error) {
    logger.error('Stripe webhook processing error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error processing webhook',
      error: error.message
    });
  }
};

// Handle successful payment
const handlePaymentSuccess = async (paymentIntent) => {
  try {
    const payment = await Payment.findOne({ 
      'paymentDetails.transactionId': paymentIntent.id 
    });
    
    if (payment) {
      payment.status = 'completed';
      payment.processedAt = new Date();
      payment.paymentDetails.gatewayResponse = paymentIntent;
      await payment.save();
      
      // Update booking status
      const booking = await Booking.findById(payment.booking);
      if (booking) {
        booking.paymentStatus = 'paid';
        booking.status = 'confirmed';
        await booking.save();
      }
      
      logger.info('Stripe payment confirmed', { paymentId: payment._id });
    }
  } catch (error) {
    logger.error('Error handling Stripe payment success', { error: error.message });
  }
};

// Handle failed payment (webhook helper)
const handleWebhookPaymentFailure = async (paymentIntent) => {
  try {
    const payment = await Payment.findOne({ 
      'paymentDetails.transactionId': paymentIntent.id 
    });
    
    if (payment) {
      payment.status = 'failed';
      payment.paymentDetails.gatewayResponse = paymentIntent;
      await payment.save();
      
      // Update booking status
      const booking = await Booking.findById(payment.booking);
      if (booking) {
        booking.paymentStatus = 'failed';
        booking.status = 'cancelled';
        await booking.save();
      }
      
      logger.warn('Stripe payment failed', { paymentId: payment._id });
    }
  } catch (error) {
    logger.error('Error handling Stripe payment failure', { error: error.message });
  }
};

// @desc    PayPal webhook (mock)
// @route   POST /api/payments/webhook/paypal
// @access  Public
const paypalWebhook = async (req, res) => {
  try {
    res.status(200).json({ received: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error processing webhook',
      error: error.message
    });
  }
};

// @desc    Create Razorpay order
// @route   POST /api/payments/create-order
// @access  Private
const createRazorpayOrder = async (req, res) => {
  try {
    const { bookingId, propertyId, serviceId,amount, currency = 'INR', pricingToken, pricingContext } = req.body;
    let finalAmount = null;
    let finalCurrency = currency;
    let finalPropertyId = propertyId || null;
    // If bookingId is provided, verify booking exists and user owns it.
    // Amount must come from booking total, never from client amount.
    if (bookingId) {
      const booking = await Booking.findById(bookingId);
      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found'
        });
      }

      if (booking.user.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'You are not authorized to create payment for this booking'
        });
      }

      finalAmount = Number(booking.totalAmount);
      finalCurrency = booking.currency || finalCurrency;
      finalPropertyId = booking.listing ? booking.listing.toString() : finalPropertyId;

      if (amount != null && Math.abs(Number(amount) - finalAmount) > 0.01) {
        return res.status(400).json({
          success: false,
          message: 'Amount mismatch with booking total'
        });
      }
    } else if (serviceId) {
      const service = await Service.findById(serviceId);
      if (!service) {
        return res.status(404).json({
          success: false,
          message: 'Service not found'
        });
      }
      if (service.user && service.user.toString() === req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'You cannot book your own service'
        });
      }

      // Server-side price calculation instead of trusting client amount
      const basePrice = service.pricing?.basePrice || service.price || 0;
      const guests = req.body.guests || 1;
      const extraGuestPrice = service.pricing?.perPersonPrice || service.pricing?.extraGuestPrice || 0;
      const extraGuests = guests > 1 ? guests - 1 : 0;
      const platformFeeRate = 0.05; // 5% platform fee
      const subtotal = basePrice + (extraGuests * extraGuestPrice);
      const platformFee = Math.round(subtotal * platformFeeRate);
      const serverCalculatedAmount = subtotal + platformFee;

      if (amount != null && Math.abs(Number(amount) - serverCalculatedAmount) > 1) {
        return res.status(400).json({
          success: false,
          message: 'Amount mismatch with server-calculated price',
          expectedAmount: serverCalculatedAmount,
          providedAmount: Number(amount)
        });
      }

      finalAmount = serverCalculatedAmount;
      finalCurrency = currency;
    }
    
    else {
      // Without bookingId, require backend-issued secure pricing token/context.
      if (!pricingToken || !pricingContext) {
        return res.status(400).json({
          success: false,
          message: 'Secure pricing context is required to create order'
        });
      }

      const tokenPayload = {
        propertyId: pricingContext.propertyId,
        checkIn: pricingContext.checkIn,
        checkOut: pricingContext.checkOut,
        guests: pricingContext.guests,
        nights: pricingContext.nights,
        totalAmount: pricingContext.totalAmount
      };

      let isTokenValid = false;
      try {
        isTokenValid = verifyPricingToken(tokenPayload, pricingToken);
      } catch (error) {
        isTokenValid = false;
      }

      if (!isTokenValid) {
        return res.status(400).json({
          success: false,
          message: 'Invalid pricing token'
        });
      }

      finalAmount = Number(pricingContext.totalAmount);
      finalCurrency = pricingContext.currency || finalCurrency;
      finalPropertyId = pricingContext.propertyId || finalPropertyId;

      if (propertyId && finalPropertyId && propertyId.toString() !== finalPropertyId.toString()) {
        return res.status(400).json({
          success: false,
          message: 'Property mismatch in pricing context'
        });
      }

      if (amount != null && Math.abs(Number(amount) - finalAmount) > 0.01) {
        return res.status(400).json({
          success: false,
          message: 'Amount mismatch with secure pricing context'
        });
      }
    }

    if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount for order creation'
      });
    }

    // Verify Razorpay is initialized, try to initialize if not
    if (!razorpayService.isInitialized()) {
      logger.error('Razorpay not initialized');
      return res.status(500).json({
        success: false,
        message: 'Payment gateway not configured. Please contact support.',
        error: 'Razorpay service not initialized. Please check server logs.'
      });
    }

    // Razorpay receipt ID must be max 40 characters
    const timestamp = Date.now().toString().slice(-10);
    const shortId = (finalPropertyId || bookingId || 'temp').toString().slice(-12);
    const randomStr = Math.random().toString(36).substr(2, 6);
    const receiptId = `RCP_${shortId}_${timestamp}_${randomStr}`.substring(0, 40);

    logger.info('Creating Razorpay order', { amount: finalAmount, currency: finalCurrency, bookingId });

    const order = await razorpayService.createOrder(finalAmount, finalCurrency, receiptId, {
      bookingId: bookingId?.toString() || null,
      propertyId: finalPropertyId?.toString() || null,
      userId: req.user._id.toString(),
      description: bookingId
        ? `Payment for booking ${bookingId}`
        : `Payment for property ${finalPropertyId || 'booking'}`
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // CRITICAL: Create CANONICAL Payment document immediately after Razorpay order
    // This is the SINGLE SOURCE OF TRUTH. No other code path may create a Payment
    // for this razorpayOrderId. All subsequent flows (webhooks, verification,
    // reconciliation) MUST UPDATE this document, never create duplicates.
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Check if payment already exists for this order (idempotency for retry)
    let canonicalPayment = await Payment.findOne({ razorpayOrderId: order.orderId });
    
    if (!canonicalPayment) {
      // Fetch booking and host info if bookingId provided
      let hostId = null;
      let bookingRef = null;
      if (bookingId) {
        const booking = await Booking.findById(bookingId).populate('host', '_id');
        if (booking) {
          hostId = booking.host?._id || booking.host;
          bookingRef = booking._id;
        }
      }

      canonicalPayment = await Payment.create({
        razorpayOrderId: order.orderId,
        booking: bookingRef,
        user: req.user._id,
        host: hostId,
        amount: finalAmount,
        currency: finalCurrency,
        status: 'pending',
        webhookStatus: 'not_received',
        orderStatus: 'created',
        paymentDetails: {
          paymentGateway: 'razorpay'
        },
        metadata: {
          source: 'create_order',
          propertyId: finalPropertyId,
          serviceId: serviceId || null,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent')
        },
        timeline: [{
          event: 'order_created',
          message: `Razorpay order created: ${order.orderId}`,
          timestamp: new Date(),
          source: 'system',
          data: {
            razorpayOrderId: order.orderId,
            amount: finalAmount,
            currency: finalCurrency,
            receipt: receiptId
          }
        }]
      });

      logger.info('Canonical payment document created', {
        paymentId: canonicalPayment._id,
        razorpayOrderId: order.orderId,
        amount: finalAmount
      });
    } else {
      logger.info('Payment document already exists for order (idempotent retry)', {
        paymentId: canonicalPayment._id,
        razorpayOrderId: order.orderId
      });
    }

    res.status(200).json({
      success: true,
      data: {
        orderId: order.orderId,
        amount: order.amount / 100,
        currency: order.currency,
        key: process.env.RAZORPAY_KEY_ID,
        receipt: order.receipt,
        paymentId: canonicalPayment._id // Return payment ID for frontend reference
      }
    });
  } catch (error) {
    logger.error('Error creating Razorpay order', { 
      error: error.message,
      stack: error.stack,
      errorObj: error.error,
      statusCode: error.statusCode
    });

    if (error.message && error.message.includes('Razorpay not initialized')) {
      return res.status(500).json({
        success: false,
        message: 'Payment gateway not configured. Please contact support.',
        error: 'Razorpay credentials missing'
      });
    }

    // Handle Razorpay API errors
    if (error.error && typeof error.error === 'object') {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.error.description || 'Failed to create payment order',
        error: error.error.reason || error.error.code || error.message
      });
    }

    // Handle amount validation errors
    if (error.message && error.message.includes('Amount too low')) {
      return res.status(400).json({
        success: false,
        message: error.message,
        error: 'INVALID_AMOUNT'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error creating payment order',
      error: error.message || 'Unknown error occurred'
    });
  }
};

// @desc    Razorpay webhook handler
// @route   POST /api/payments/webhook/razorpay
// @access  Public
const razorpayWebhook = async (req, res) => {
  // CRITICAL: Always return 200 to Razorpay to prevent infinite retries.
  // Internal errors are logged and handled by reconciliation.
  try {
    const signature = req.get('X-Razorpay-Signature');
    const payload = req.rawBody || (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
    const parsedBody = Buffer.isBuffer(req.body) ? JSON.parse(payload) : req.body;

    // Verify webhook signature
    const isValidSignature = razorpayService.verifyWebhookSignature(payload, signature);
    
    if (!isValidSignature) {
      logger.error('SECURITY: Invalid Razorpay webhook signature', {
        ip: req.ip,
        headers: { 'x-razorpay-signature': signature ? '[PRESENT]' : '[MISSING]' },
        event: parsedBody?.event || 'unknown'
      });
      return res.status(400).json({
        success: false,
        message: 'Invalid webhook signature'
      });
    }

    const event = parsedBody.event;
    const webhookEventId = parsedBody.account_id + '_' + (parsedBody.payload?.payment?.entity?.id || parsedBody.payload?.order?.entity?.id || '') + '_' + event + '_' + (parsedBody.created_at || '');

    logger.info('Razorpay webhook received', {
      event,
      webhookEventId,
      ip: req.ip,
      razorpayPaymentId: parsedBody.payload?.payment?.entity?.id,
      razorpayOrderId: parsedBody.payload?.payment?.entity?.order_id || parsedBody.payload?.order?.entity?.id
    });

    const paymentEntity = parsedBody.payload?.payment?.entity || parsedBody.payload?.payment;
    const orderEntity = parsedBody.payload?.order?.entity || parsedBody.payload?.order;
    const refundEntity = parsedBody.payload?.refund?.entity || parsedBody.payload?.refund;
    const disputeEntity = parsedBody.payload?.dispute?.entity || parsedBody.payload?.dispute;

    // Handle different webhook events
    switch (event) {
      case 'payment.authorized':
        await handleRazorpayPaymentAuthorized(paymentEntity, webhookEventId, parsedBody);
        break;

      case 'payment.captured':
        await handleRazorpayPaymentSuccess(paymentEntity, webhookEventId, parsedBody);
        break;
      
      case 'payment.failed':
        await handleRazorpayPaymentFailure(paymentEntity, webhookEventId, parsedBody);
        break;

      case 'payment.dispute.created':
        await handleRazorpayPaymentDisputeCreated(disputeEntity || paymentEntity);
        break;

      case 'order.paid':
        await handleRazorpayOrderPaid(orderEntity);
        break;
      
      case 'refund.created':
        await handleRazorpayRefundCreated(refundEntity);
        break;
      
      case 'refund.processed':
        await handleRazorpayRefundProcessed(refundEntity);
        break;

      case 'refund.failed':
        await handleRazorpayRefundFailed(refundEntity);
        break;
      
      default:
        logger.debug('Unhandled Razorpay webhook event', { event });
    }

    res.status(200).json({ received: true });
  } catch (error) {
    logger.error('Razorpay webhook processing error', {
      error: error.message,
      stack: error.stack
    });
    // STILL return 200 to prevent Razorpay from retrying permanently.
    // Reconciliation cron will pick up any missed events.
    res.status(200).json({ received: true, error: 'internal_processing_error' });
  }
};

// Handle successful Razorpay payment (payment.captured webhook)
const handleRazorpayPaymentSuccess = async (paymentEntity, webhookEventId, rawPayload) => {
  try {
    if (!paymentEntity?.id) {
      logger.warn('payment.captured webhook missing payment ID');
      return;
    }

    const rzpPaymentId = paymentEntity.id;
    const rzpOrderId = paymentEntity.order_id;

    logger.info('WEBHOOK_DEBUG: payment.captured handler started', {
      rzpPaymentId,
      rzpOrderId,
      webhookEventId,
      amountPaise: paymentEntity.amount,
      method: paymentEntity.method
    });

    // CRITICAL FIX: Use atomic $or query to find payment by EITHER razorpayPaymentId OR razorpayOrderId
    const lookupQuery = {
      $or: [
        { razorpayPaymentId: rzpPaymentId },
        ...(rzpOrderId ? [{ razorpayOrderId: rzpOrderId }] : [])
      ]
    };

    logger.info('WEBHOOK_DEBUG: Looking up payment with query', { lookupQuery });

    let payment = await Payment.findOne(lookupQuery);

    logger.info('WEBHOOK_DEBUG: Payment lookup result', {
      found: !!payment,
      paymentId: payment?._id?.toString(),
      currentStatus: payment?.status,
      currentWebhookStatus: payment?.webhookStatus,
      existingRzpPaymentId: payment?.razorpayPaymentId,
      existingRzpOrderId: payment?.razorpayOrderId
    });

    // Update razorpayPaymentId if found by order_id but missing payment_id
    if (payment && !payment.razorpayPaymentId && rzpPaymentId) {
      payment.razorpayPaymentId = rzpPaymentId;
      logger.info('WEBHOOK_DEBUG: Updated missing razorpayPaymentId on payment', { paymentId: payment._id });
    }

    if (!payment) {
      // CRITICAL: Payment captured but no DB record exists.
      // This should be RARE now that we create canonical payment at order creation.
      // Only create orphan if absolutely no record exists (safety net).
      logger.error('CRITICAL: payment.captured webhook — no DB record found', {
        rzpPaymentId: paymentEntity.id,
        rzpOrderId: paymentEntity.order_id,
        amount: paymentEntity.amount
      });

      // SAFETY: Use findOneAndUpdate with upsert to prevent duplicate creation
      // This ensures only ONE orphan record is created even if webhook is retried
      payment = await Payment.findOneAndUpdate(
        {
          $or: [
            { razorpayPaymentId: rzpPaymentId },
            ...(rzpOrderId ? [{ razorpayOrderId: rzpOrderId }] : [])
          ]
        },
        {
          $setOnInsert: {
            razorpayPaymentId: paymentEntity.id,
            razorpayOrderId: paymentEntity.order_id || null,
            amount: (paymentEntity.amount || 0) / 100,
            currency: paymentEntity.currency || 'INR',
            paymentMethod: paymentEntity.method || 'unknown',
            paymentDetails: { gatewayResponse: paymentEntity, paymentGateway: 'razorpay' },
            recoveryStatus: 'recovery_required',
            metadata: { source: 'webhook_orphan' },
            rawWebhookPayload: rawPayload
          },
          $set: {
            status: 'completed',
            webhookStatus: 'captured',
            webhookReceivedAt: new Date(),
            orderStatus: 'paid'
          },
          $push: {
            timeline: {
              event: 'webhook_orphan_created',
              message: 'Payment captured but no DB record found. Orphan record created for recovery.',
              timestamp: new Date(),
              source: 'webhook',
              data: { rzpPaymentId: paymentEntity.id, rzpOrderId: paymentEntity.order_id }
            }
          }
        },
        { upsert: true, new: true }
      );

      logger.error('Orphan payment created/updated, requires recovery', { paymentId: payment._id, rzpPaymentId: paymentEntity.id });
      return;
    }

    // Webhook event deduplication
    if (webhookEventId) {
      const alreadyProcessed = await Payment.isWebhookProcessed(payment._id, webhookEventId);
      logger.info('WEBHOOK_DEBUG: Deduplication check', { paymentId: payment._id, webhookEventId, alreadyProcessed });
      if (alreadyProcessed) {
        logger.info('WEBHOOK_DEBUG: Duplicate webhook event, skipping', { paymentId: payment._id, webhookEventId });
        return;
      }
    }

    // Idempotency: don't re-process already completed payments
    if (payment.status === 'completed') {
      logger.info('WEBHOOK_DEBUG: Payment already completed, skipping update', { paymentId: payment._id, currentWebhookStatus: payment.webhookStatus });
      // Still mark the webhook event as processed
      if (webhookEventId) await Payment.markWebhookProcessed(payment._id, webhookEventId, 'payment.captured');
      return;
    }

    // CRITICAL: Validate amount consistency before updating
    const rzpAmountRupees = (paymentEntity.amount || 0) / 100;
    const dbAmount = payment.amount || 0;
    const amountDiff = Math.abs(rzpAmountRupees - dbAmount);
    
    // Log amount comparison for debugging
    logger.info('WEBHOOK_DEBUG: Amount validation', {
      paymentId: payment._id,
      razorpayAmountPaise: paymentEntity.amount,
      razorpayAmountRupees: rzpAmountRupees,
      dbAmount: dbAmount,
      pricingBreakdownTotal: payment.pricingBreakdown?.customerBreakdown?.totalAmount,
      amountDiff: amountDiff,
      isMatch: amountDiff <= 1 // Allow ₹1 tolerance
    });

    // CRITICAL WARNING: Flag amount mismatch but don't block webhook processing
    if (amountDiff > 1) {
      logger.error('WEBHOOK_AMOUNT_MISMATCH: DB amount does not match Razorpay captured amount', {
        paymentId: payment._id,
        razorpayAmountRupees,
        dbAmount,
        amountDiff,
        pricingBreakdown: payment.pricingBreakdown?.customerBreakdown
      });
      
      // Add timeline entry for amount mismatch
      await Payment.addTimelineEntry(payment._id, {
        event: 'amount_mismatch_detected',
        message: `Amount mismatch: DB has ₹${dbAmount}, Razorpay captured ₹${rzpAmountRupees}`,
        source: 'webhook',
        data: { razorpayAmountRupees, dbAmount, amountDiff }
      });
    }

    // CRITICAL: Update payment fields
    logger.info('WEBHOOK_DEBUG: Updating payment document', {
      paymentId: payment._id,
      beforeStatus: payment.status,
      beforeWebhookStatus: payment.webhookStatus
    });

    payment.status = 'completed';
    payment.webhookStatus = 'captured';
    payment.webhookReceivedAt = new Date();
    payment.orderStatus = 'paid';
    payment.processedAt = new Date();
    payment.paymentDetails = payment.paymentDetails || {};
    payment.paymentDetails.gatewayResponse = paymentEntity;

    try {
      const savedPayment = await payment.save();
      logger.info('WEBHOOK_DEBUG: Payment save SUCCESS', {
        paymentId: savedPayment._id,
        afterStatus: savedPayment.status,
        afterWebhookStatus: savedPayment.webhookStatus,
        webhookReceivedAt: savedPayment.webhookReceivedAt,
        updatedAt: savedPayment.updatedAt
      });
    } catch (saveError) {
      logger.error('WEBHOOK_DEBUG: Payment save FAILED', {
        paymentId: payment._id,
        error: saveError.message,
        stack: saveError.stack
      });
      throw saveError;
    }

    // Add timeline entry
    await Payment.addTimelineEntry(payment._id, {
      event: 'payment.captured',
      message: 'Payment captured via webhook',
      source: 'webhook',
      data: { rzpPaymentId: paymentEntity.id, method: paymentEntity.method, amount: paymentEntity.amount }
    });

    // Mark webhook event as processed
    if (webhookEventId) await Payment.markWebhookProcessed(payment._id, webhookEventId, 'payment.captured');

    // Confirm the booking
    const booking = await Booking.findById(payment.booking);
    if (booking) {
      if (booking.paymentStatus !== 'paid') {
        booking.paymentStatus = 'paid';
        booking.status = 'confirmed';
        await booking.save();
        logger.info('Booking confirmed via payment.captured webhook', { bookingId: booking._id });

        await Payment.addTimelineEntry(payment._id, {
          event: 'booking_confirmed',
          message: 'Booking confirmed after payment capture',
          source: 'webhook',
          data: { bookingId: booking._id }
        });

        // Send confirmation email
        try {
          const { sendBookingConfirmationEmail } = require('../utils/sendEmail');
          const populatedBooking = await Booking.findById(booking._id)
            .populate('user', 'name email')
            .populate('listing', 'title location images')
            .populate('service', 'title');
          if (populatedBooking?.user?.email) {
            await sendBookingConfirmationEmail(populatedBooking.user.email, populatedBooking);
          }
        } catch (emailErr) {
          logger.warn('Failed to send confirmation email from webhook', { error: emailErr.message });
        }
      }
    } else {
      // Payment captured but booking not found — flag for recovery
      logger.error('CRITICAL: Payment captured but booking not found', { bookingId: payment.booking, paymentId: payment._id });
      await Payment.findByIdAndUpdate(payment._id, { recoveryStatus: 'recovery_required' });
      await Payment.addTimelineEntry(payment._id, {
        event: 'recovery_flagged',
        message: 'Payment captured but associated booking not found. Flagged for recovery.',
        source: 'webhook',
        data: { bookingId: payment.booking }
      });
    }

    logger.info('Razorpay payment.captured handled', { paymentId: payment._id });
  } catch (error) {
    logger.error('Error handling Razorpay payment.captured', { error: error.message, stack: error.stack });
  }
};

// Handle Razorpay payment authorized (awaiting capture — e.g. UPI/NetBanking)
const handleRazorpayPaymentAuthorized = async (paymentEntity, webhookEventId, rawPayload) => {
  try {
    if (!paymentEntity?.id) {
      logger.warn('Razorpay payment authorized webhook missing payment ID');
      return;
    }

    const rzpPaymentId = paymentEntity.id;
    const rzpOrderId = paymentEntity.order_id;

    logger.info('WEBHOOK_DEBUG: payment.authorized handler started', {
      rzpPaymentId,
      rzpOrderId,
      webhookEventId
    });

    // CRITICAL FIX: Use atomic $or query to find payment
    const lookupQuery = {
      $or: [
        { razorpayPaymentId: rzpPaymentId },
        ...(rzpOrderId ? [{ razorpayOrderId: rzpOrderId }] : [])
      ]
    };

    let payment = await Payment.findOne(lookupQuery);

    logger.info('WEBHOOK_DEBUG: payment.authorized lookup result', {
      found: !!payment,
      paymentId: payment?._id?.toString()
    });

    // Update razorpayPaymentId if found by order_id but missing payment_id
    if (payment && !payment.razorpayPaymentId && rzpPaymentId) {
      payment.razorpayPaymentId = rzpPaymentId;
    }

    if (!payment) {
      // Webhook arrived before DB record — use upsert to prevent duplicates
      logger.warn('payment.authorized webhook — no DB record found', {
        rzpPaymentId: paymentEntity.id,
        rzpOrderId: paymentEntity.order_id
      });

      // SAFETY: Use findOneAndUpdate with upsert to prevent duplicate creation
      payment = await Payment.findOneAndUpdate(
        {
          $or: [
            { razorpayPaymentId: rzpPaymentId },
            ...(rzpOrderId ? [{ razorpayOrderId: rzpOrderId }] : [])
          ]
        },
        {
          $setOnInsert: {
            razorpayPaymentId: paymentEntity.id,
            razorpayOrderId: paymentEntity.order_id || null,
            amount: (paymentEntity.amount || 0) / 100,
            currency: paymentEntity.currency || 'INR',
            paymentMethod: paymentEntity.method || 'unknown',
            paymentDetails: { gatewayResponse: paymentEntity, paymentGateway: 'razorpay' },
            metadata: { source: 'webhook_orphan' },
            rawWebhookPayload: rawPayload
          },
          $set: {
            status: 'authorized',
            webhookStatus: 'authorized',
            webhookReceivedAt: new Date()
          },
          $push: {
            timeline: {
              event: 'webhook_orphan_created',
              message: 'Payment authorized but no DB record found. Orphan record created.',
              timestamp: new Date(),
              source: 'webhook',
              data: { rzpPaymentId: paymentEntity.id, rzpOrderId: paymentEntity.order_id }
            }
          }
        },
        { upsert: true, new: true }
      );

      logger.warn('Orphan authorized payment created/updated', { paymentId: payment._id });
      return;
    }

    // Webhook event deduplication
    if (webhookEventId) {
      const alreadyProcessed = await Payment.isWebhookProcessed(payment._id, webhookEventId);
      if (alreadyProcessed) {
        logger.debug('Duplicate authorized webhook event, skipping', { paymentId: payment._id, webhookEventId });
        return;
      }
    }

    // 'authorized' means money is held but not yet captured (typical for UPI/NetBanking)
    if (payment.status !== 'completed') {
      payment.status = 'authorized';
      payment.webhookStatus = 'authorized';
      payment.webhookReceivedAt = new Date();
      payment.paymentDetails = payment.paymentDetails || {};
      payment.paymentDetails.gatewayResponse = paymentEntity;
      await payment.save();
    }

    // Add timeline entry
    await Payment.addTimelineEntry(payment._id, {
      event: 'payment.authorized',
      message: 'Payment authorized, awaiting capture',
      source: 'webhook',
      data: { rzpPaymentId: paymentEntity.id, method: paymentEntity.method }
    });

    if (webhookEventId) await Payment.markWebhookProcessed(payment._id, webhookEventId, 'payment.authorized');

    logger.info('Razorpay payment authorized, awaiting capture', { paymentId: payment._id });
  } catch (error) {
    logger.error('Error handling Razorpay payment authorized', { error: error.message, stack: error.stack });
  }
};

// Handle Razorpay payment dispute created
const handleRazorpayPaymentDisputeCreated = async (disputeEntity) => {
  try {
    if (!disputeEntity) {
      logger.warn('Razorpay dispute webhook missing dispute entity');
      return;
    }

    const paymentId = disputeEntity.payment_id || disputeEntity.payment?.id || disputeEntity.paymentId;
    if (!paymentId) {
      logger.warn('Razorpay dispute webhook missing payment reference');
      return;
    }

    const payment = await Payment.findOne({
      razorpayPaymentId: paymentId
    });

    if (payment) {
      payment.paymentDetails.gatewayResponse = {
        ...(payment.paymentDetails?.gatewayResponse || {}),
        dispute: disputeEntity
      };
      // Keep status within allowed enum; mark as processing until resolved
      payment.status = payment.status === 'completed' ? 'processing' : payment.status;
      await payment.save();

      const booking = await Booking.findById(payment.booking);
      if (booking) {
        booking.paymentStatus = 'pending';
        await booking.save();
      }

      logger.warn('Razorpay dispute created for payment', { paymentId: payment._id });
    } else {
      logger.warn('Payment not found for dispute', { rzpPaymentId: paymentId });
    }
  } catch (error) {
    logger.error('Error handling Razorpay dispute created', { error: error.message });
  }
};

// Handle Razorpay order paid (order-level confirmation)
const handleRazorpayOrderPaid = async (orderEntity) => {
  try {
    if (!orderEntity?.id) {
      logger.warn('Razorpay order.paid webhook missing order ID');
      return;
    }

    const payment = await Payment.findOne({
      razorpayOrderId: orderEntity.id
    });

    if (payment) {
      payment.status = 'completed';
      payment.paymentDetails.gatewayResponse = {
        ...(payment.paymentDetails?.gatewayResponse || {}),
        order: orderEntity
      };
      await payment.save();

      const booking = await Booking.findById(payment.booking);
      if (booking) {
        booking.paymentStatus = 'paid';
        booking.status = 'confirmed';
        await booking.save();
      }

      logger.info('Razorpay order paid', { paymentId: payment._id });
    } else {
      logger.warn('Payment not found for Razorpay order', { rzpOrderId: orderEntity.id });
    }
  } catch (error) {
    logger.error('Error handling Razorpay order paid', { error: error.message });
  }
};

// Handle failed Razorpay payment — store full failure details
const handleRazorpayPaymentFailure = async (paymentEntity, webhookEventId, rawPayload) => {
  try {
    if (!paymentEntity?.id) {
      logger.warn('payment.failed webhook missing payment ID');
      return;
    }

    const rzpPaymentId = paymentEntity.id;
    const rzpOrderId = paymentEntity.order_id;

    logger.info('WEBHOOK_DEBUG: payment.failed handler started', {
      rzpPaymentId,
      rzpOrderId,
      webhookEventId,
      errorCode: paymentEntity.error_code
    });

    // CRITICAL FIX: Use atomic $or query to find payment
    const lookupQuery = {
      $or: [
        { razorpayPaymentId: rzpPaymentId },
        ...(rzpOrderId ? [{ razorpayOrderId: rzpOrderId }] : [])
      ]
    };

    let payment = await Payment.findOne(lookupQuery);

    logger.info('WEBHOOK_DEBUG: payment.failed lookup result', {
      found: !!payment,
      paymentId: payment?._id?.toString()
    });

    // Update razorpayPaymentId if found by order_id but missing payment_id
    if (payment && !payment.razorpayPaymentId && rzpPaymentId) {
      payment.razorpayPaymentId = rzpPaymentId;
    }

    const failureDetails = {
      error_code: paymentEntity.error_code,
      error_description: paymentEntity.error_description,
      error_source: paymentEntity.error_source,
      error_step: paymentEntity.error_step,
      error_reason: paymentEntity.error_reason,
      error_metadata: paymentEntity.error_metadata,
      timestamp: new Date(),
    };

    if (!payment) {
      // CRITICAL: payment.failed but no DB record — use upsert to prevent duplicates
      logger.warn('payment.failed webhook — no DB record found', {
        rzpPaymentId: paymentEntity.id,
        rzpOrderId: paymentEntity.order_id,
        errorCode: paymentEntity.error_code
      });

      // SAFETY: Use findOneAndUpdate with upsert to prevent duplicate creation
      payment = await Payment.findOneAndUpdate(
        {
          $or: [
            { razorpayPaymentId: rzpPaymentId },
            ...(rzpOrderId ? [{ razorpayOrderId: rzpOrderId }] : [])
          ]
        },
        {
          $setOnInsert: {
            razorpayPaymentId: paymentEntity.id,
            razorpayOrderId: paymentEntity.order_id || null,
            amount: (paymentEntity.amount || 0) / 100,
            currency: paymentEntity.currency || 'INR',
            paymentMethod: paymentEntity.method || 'unknown',
            paymentDetails: { gatewayResponse: paymentEntity, paymentGateway: 'razorpay' },
            metadata: { source: 'webhook_orphan' },
            rawWebhookPayload: rawPayload
          },
          $set: {
            status: 'failed',
            webhookStatus: 'failed',
            webhookReceivedAt: new Date(),
            failureDetails
          },
          $push: {
            timeline: {
              event: 'webhook_orphan_created',
              message: `Payment failed but no DB record found. Orphan failure record created. Error: ${paymentEntity.error_description || paymentEntity.error_code || 'unknown'}`,
              timestamp: new Date(),
              source: 'webhook',
              data: { rzpPaymentId: paymentEntity.id, rzpOrderId: paymentEntity.order_id, failureDetails }
            }
          }
        },
        { upsert: true, new: true }
      );

      logger.warn('Orphan failure payment created/updated', { paymentId: payment._id, rzpPaymentId: paymentEntity.id });
      return;
    }

    // Webhook event deduplication
    if (webhookEventId) {
      const alreadyProcessed = await Payment.isWebhookProcessed(payment._id, webhookEventId);
      if (alreadyProcessed) {
        logger.debug('Duplicate failed webhook event, skipping', { paymentId: payment._id, webhookEventId });
        return;
      }
    }

    // Idempotency: don't overwrite completed/refunded payments with failed
    if (['completed', 'refunded', 'partially_refunded'].includes(payment.status)) {
      logger.warn('payment.failed received for already completed/refunded payment, skipping status change', {
        paymentId: payment._id,
        currentStatus: payment.status
      });
      // Still log the timeline entry
      await Payment.addTimelineEntry(payment._id, {
        event: 'payment.failed_ignored',
        message: `payment.failed webhook received but payment is already ${payment.status}. Failure ignored.`,
        source: 'webhook',
        data: { currentStatus: payment.status, failureDetails }
      });
      if (webhookEventId) await Payment.markWebhookProcessed(payment._id, webhookEventId, 'payment.failed');
      return;
    }

    // Idempotency: already failed
    if (payment.status === 'failed') {
      logger.debug('Payment already failed, updating timeline only', { paymentId: payment._id });
      await Payment.addTimelineEntry(payment._id, {
        event: 'payment.failed_duplicate',
        message: 'Duplicate payment.failed webhook received',
        source: 'webhook',
        data: { failureDetails }
      });
      if (webhookEventId) await Payment.markWebhookProcessed(payment._id, webhookEventId, 'payment.failed');
      return;
    }

    payment.status = 'failed';
    payment.webhookStatus = 'failed';
    payment.webhookReceivedAt = new Date();
    payment.paymentDetails = payment.paymentDetails || {};
    payment.paymentDetails.gatewayResponse = paymentEntity;
    payment.failureDetails = failureDetails;
    await payment.save();

    // Add timeline entry
    await Payment.addTimelineEntry(payment._id, {
      event: 'payment.failed',
      message: `Payment failed: ${paymentEntity.error_description || paymentEntity.error_code || 'unknown error'}`,
      source: 'webhook',
      data: { rzpPaymentId: paymentEntity.id, failureDetails }
    });

    if (webhookEventId) await Payment.markWebhookProcessed(payment._id, webhookEventId, 'payment.failed');

    // Cancel the associated booking — SAFELY
    if (payment.booking) {
      const booking = await Booking.findById(payment.booking);
      if (booking && booking.status !== 'cancelled') {
        // SAFETY: Only cancel if booking is NOT already confirmed with a successful payment
        if (booking.paymentStatus === 'paid' && booking.status === 'confirmed') {
          logger.warn('payment.failed received but booking is already confirmed+paid. Not cancelling.', {
            bookingId: booking._id,
            paymentId: payment._id
          });
          await Payment.addTimelineEntry(payment._id, {
            event: 'booking_cancel_skipped',
            message: 'Booking is already confirmed+paid. Skipping cancellation despite payment.failed.',
            source: 'webhook',
            data: { bookingId: booking._id, bookingStatus: booking.status, paymentStatus: booking.paymentStatus }
          });
        } else {
          booking.paymentStatus = 'failed';
          booking.status = 'cancelled';
          await booking.save();
          logger.info('Booking cancelled due to payment failure', { bookingId: booking._id });

          // SAFE availability revert: only if no confirmed booking exists for these dates
          try {
            const { updateAvailabilityStatus } = require('./availability.controller');
            // Check if another confirmed booking exists for the same property/dates
            const confirmedBooking = await Booking.findOne({
              _id: { $ne: booking._id },
              listing: booking.listing,
              status: 'confirmed',
              paymentStatus: 'paid',
              checkIn: booking.checkIn,
              checkOut: booking.checkOut
            });
            if (!confirmedBooking) {
              await updateAvailabilityStatus(payment.booking, 'available');
              logger.info('Availability reverted after payment failure', { bookingId: booking._id });
            } else {
              logger.info('Availability NOT reverted — another confirmed booking exists for these dates', {
                bookingId: booking._id,
                confirmedBookingId: confirmedBooking._id
              });
            }
          } catch (availabilityError) {
            logger.error('Error reverting availability status', { error: availabilityError.message });
          }
        }
      }
    }

    logger.warn('Razorpay payment.failed handled', { paymentId: payment._id, errorCode: paymentEntity.error_code });
  } catch (error) {
    logger.error('Error handling Razorpay payment.failed', { error: error.message, stack: error.stack });
  }
};

// Handle Razorpay refund created
const handleRazorpayRefundCreated = async (refundEntity) => {
  try {
    const refund = await Refund.findOne({
      razorpayRefundId: refundEntity.id
    });

    if (refund) {
      refund.status = 'processing';
      refund.gatewayResponse = refundEntity;
      await refund.save();

      logger.info('Razorpay refund created', { refundId: refund._id });
    }
  } catch (error) {
    logger.error('Error handling Razorpay refund created', { error: error.message });
  }
};

// Handle Razorpay refund failed
const handleRazorpayRefundFailed = async (refundEntity) => {
  try {
    if (!refundEntity?.id) {
      logger.warn('Razorpay refund.failed webhook missing refund ID');
      return;
    }

    const refund = await Refund.findOne({
      razorpayRefundId: refundEntity.id
    });

    if (refund) {
      refund.status = 'failed';
      refund.gatewayResponse = refundEntity;
      await refund.save();

      const booking = await Booking.findById(refund.booking);
      if (booking) {
        booking.refundStatus = 'pending';
        await booking.save();
      }

      logger.warn('Razorpay refund failed', { refundId: refund._id });
    } else {
      logger.warn('Refund record not found for Razorpay refund', { rzpRefundId: refundEntity.id });
    }
  } catch (error) {
    logger.error('Error handling Razorpay refund failed', { error: error.message });
  }
};

// Handle Razorpay refund processed
const handleRazorpayRefundProcessed = async (refundEntity) => {
  try {
    logger.info('Razorpay refund.processed webhook', { rzpRefundId: refundEntity.id, rzpPaymentId: refundEntity.payment_id, amount: refundEntity.amount / 100 });
    
    const refund = await Refund.findOne({
      razorpayRefundId: refundEntity.id
    });

    if (refund) {
      refund.status = 'completed';
      refund.processedAt = new Date();
      refund.gatewayResponse = refundEntity;
      await refund.save();


      // Update booking refund status
      const booking = await Booking.findById(refund.booking);
      if (booking) {
        booking.refunded = true;
        booking.refundStatus = 'completed';
        booking.paymentStatus = refund.amount === booking.totalAmount ? 'refunded' : 'partially_refunded';
        await booking.save();
        logger.info('Booking refund status updated', { bookingId: booking._id, paymentStatus: booking.paymentStatus });
      }

      // Update payment status
      const payment = await Payment.findById(refund.payment);
      if (payment) {
        if (refund.amount === payment.amount) {
          payment.status = 'refunded';
        } else {
          payment.status = 'partially_refunded';
        }
        await payment.save();
        logger.info('Payment status updated after refund', { paymentId: payment._id, status: payment.status });
      }

      logger.info('Refund completed', { refundId: refund._id, amount: refund.amount });
    } else {
      logger.warn('Refund record not found for processed refund', { rzpRefundId: refundEntity.id });
    }
  } catch (error) {
    logger.error('Error handling Razorpay refund processed', { error: error.message });
  }
};

// @desc    Get payment statistics with enhanced data
// @route   GET /api/payments/stats/overview
// @access  Private
const getPaymentStats = async (req, res) => {
  try {
    const userId = req.user.id;
    
    const totalPayments = await Payment.countDocuments({ user: userId });
    const completedPayments = await Payment.countDocuments({ user: userId, status: 'completed' });
    const totalAmount = await Payment.aggregate([
      { $match: { user: userId, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    const totalRefunds = await Refund.countDocuments({ user: userId });
    const refundAmount = await Refund.aggregate([
      { $match: { user: userId, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    // Get monthly payment trends
    const monthlyTrends = await Payment.aggregate([
      { $match: { user: userId, status: 'completed' } },
      {
        $group: {
          _id: { 
            year: { $year: '$createdAt' }, 
            month: { $month: '$createdAt' } 
          },
          count: { $sum: 1 },
          total: { $sum: '$amount' }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: 6 }
    ]);
    
    res.status(200).json({
      success: true,
      data: {
        totalPayments,
        completedPayments,
        totalAmount: totalAmount[0]?.total || 0,
        totalRefunds,
        refundAmount: refundAmount[0]?.total || 0,
        netSpent: (totalAmount[0]?.total || 0) - (refundAmount[0]?.total || 0),
        monthlyTrends
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching payment statistics',
      error: error.message
    });
  }
};

// @desc    Get monthly payment statistics
// @route   GET /api/payments/stats/monthly
// @access  Private
const getMonthlyPaymentStats = async (req, res) => {
  try {
    const { year = new Date().getFullYear() } = req.query;
    const userId = req.user.id;
    
    const monthlyStats = await Payment.aggregate([
      { $match: { user: userId, status: 'completed' } },
      {
        $group: {
          _id: { $month: '$createdAt' },
          count: { $sum: 1 },
          total: { $sum: '$amount' }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    res.status(200).json({
      success: true,
      data: { monthlyStats }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching monthly payment statistics',
      error: error.message
    });
  }
};

// @desc    Get payment method statistics
// @route   GET /api/payments/stats/methods
// @access  Private
const getPaymentMethodStats = async (req, res) => {
  try {
    const userId = req.user.id;
    
    const methodStats = await Payment.aggregate([
      { $match: { user: userId, status: 'completed' } },
      {
        $group: {
          _id: '$paymentMethod',
          count: { $sum: 1 },
          total: { $sum: '$amount' }
        }
      }
    ]);
    
    res.status(200).json({
      success: true,
      data: { methodStats }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching payment method statistics',
      error: error.message
    });
  }
};

// @desc    Get all payments for admin with enhanced details
// @route   GET /api/payments/admin/all
// @access  Private/Admin
const getAllPayments = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, search } = req.query;
    
    const query = {};
    if (status) {
      query.status = status;
    }
    if (search) {
      query.$or = [
        { 'paymentDetails.transactionId': { $regex: search, $options: 'i' } },
        { 'user.name': { $regex: search, $options: 'i' } },
        { 'host.name': { $regex: search, $options: 'i' } }
      ];
    }
    
    const payments = await Payment.find(query)
      .populate('user', 'name email')
      .populate('host', 'name email')
      .populate('booking', 'totalAmount currency checkIn checkOut receiptId')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();
    
    const total = await Payment.countDocuments(query);
    
    // Enhance payments with payout and refund information
    const enhancedPayments = await Promise.all(payments.map(async (payment) => {
      const payout = await Payout.findOne({ payment: payment._id })
        .select('status scheduledDate processedDate amount method');
      
      const refunds = await Refund.find({ payment: payment._id })
        .select('amount status reason type');
      
      return {
        ...payment.toObject(),
        payout,
        refunds,
        totalRefunded: payment.totalRefunded,
        netAmount: payment.netAmount,
        payoutAmount: payment.payoutAmount
      };
    }));
    
    res.status(200).json({
      success: true,
      data: {
        payments: enhancedPayments,
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
      message: 'Error fetching all payments',
      error: error.message
    });
  }
};

// @desc    Get pending payouts for admin
// @route   GET /api/payments/admin/payouts
// @access  Private/Admin
const getPendingPayouts = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    
    const payouts = await Payout.find({ status: 'pending' })
      .populate('host', 'name email')
      .populate('payment', 'amount')
      .populate('booking', 'totalAmount currency')
      .sort({ scheduledDate: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();
    
    const total = await Payout.countDocuments({ status: 'pending' });
    
    res.status(200).json({
      success: true,
      data: {
        payouts,
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
      message: 'Error fetching pending payouts',
      error: error.message
    });
  }
};

// @desc    Process host payout (admin)
// @route   POST /api/payments/admin/payouts/:payoutId/process
// @access  Private/Admin
const processHostPayout = async (req, res) => {
  try {
    const { payoutId } = req.params;
    const payoutData = req.body;
    
    const payout = await PaymentService.processHostPayout(payoutId, payoutData, req.user);
    
    res.status(200).json({
      success: true,
      message: 'Payout processing initiated successfully',
      data: { payout }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error processing payout',
      error: error.message
    });
  }
};

// @desc    Get payment statistics for admin
// @route   GET /api/payments/admin/stats
// @access  Private/Admin
const getAdminPaymentStats = async (req, res) => {
  try {
    const stats = await PaymentService.getAdminPaymentStats();
    
    res.status(200).json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching payment statistics',
      error: error.message
    });
  }
};

// @desc    Update payment status (admin)
// @route   PATCH /api/payments/admin/:paymentId/status
// @access  Private/Admin
const updatePaymentStatus = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { status } = req.body;
    
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    
    payment.status = status;
    await payment.save();
    
    // If payment is marked as failed, revert availability to 'available'
    if (status === 'failed' && payment.booking) {
      try {
        const { updateAvailabilityStatus } = require('./availability.controller');
        await updateAvailabilityStatus(payment.booking, 'available');
      } catch (availabilityError) {
        logger.error('Error reverting availability status', { error: availabilityError.message });
        // Don't fail the status update if availability update fails
      }
    }
    
    res.status(200).json({
      success: true,
      message: 'Payment status updated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating payment status',
      error: error.message
    });
  }
};

// @desc    Handle payment failure reported by frontend (user cancelled or Razorpay error)
// @route   POST /api/payments/:paymentId/fail
// @access  Private
const handlePaymentFailure = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const {
      error_code,
      error_description,
      error_source,
      error_step,
      error_reason,
      razorpayOrderId,
      razorpayPaymentId,
    } = req.body;

    // Find by DB id OR by razorpay order id (whichever frontend has)
    let payment = await Payment.findById(paymentId).catch(() => null);
    if (!payment && razorpayOrderId) {
      payment = await Payment.findOne({ razorpayOrderId });
    }

    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    if (payment.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Idempotency: already failed
    if (payment.status === 'failed') {
      return res.status(200).json({ success: true, message: 'Payment already marked as failed' });
    }

    // Store failure details
    payment.status = 'failed';
    payment.failureDetails = {
      error_code: error_code || 'CANCELLED',
      error_description: error_description || 'User cancelled or payment failed',
      error_source: error_source || 'customer',
      error_step: error_step || 'payment_authentication',
      error_reason: error_reason || 'user_cancelled',
      timestamp: new Date(),
    };
    if (razorpayPaymentId && !payment.razorpayPaymentId) {
      payment.razorpayPaymentId = razorpayPaymentId;
    }
    await payment.save();

    // Cancel the associated booking
    if (payment.booking) {
      const booking = await Booking.findById(payment.booking);
      if (booking && booking.status !== 'cancelled') {
        booking.paymentStatus = 'failed';
        booking.status = 'cancelled';
        await booking.save();
        logger.info('Booking cancelled due to frontend payment failure', { bookingId: booking._id });
      }

      // Revert date availability
      try {
        const { updateAvailabilityStatus } = require('./availability.controller');
        await updateAvailabilityStatus(payment.booking, 'available');
      } catch (availabilityError) {
        logger.error('Error reverting availability', { error: availabilityError.message });
      }
    }

    logger.warn('Payment marked as failed by frontend', { paymentId: payment._id, errorCode: error_code });

    res.status(200).json({
      success: true,
      message: 'Payment failure recorded',
      failureDetails: payment.failureDetails,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error handling payment failure',
      error: error.message,
    });
  }
};

// ============================================================================
// ADMIN DEBUG ENDPOINTS
// ============================================================================

// @desc    Search payment by various IDs (admin debug)
// @route   GET /api/payments/admin/debug/search
// @access  Private/Admin
const adminSearchPayment = async (req, res) => {
  try {
    const { paymentId, orderId, bookingId, userId, razorpayPaymentId, razorpayOrderId } = req.query;

    let payment = null;

    if (paymentId) {
      payment = await Payment.findById(paymentId);
    } else if (razorpayPaymentId) {
      payment = await Payment.findOne({ razorpayPaymentId });
    } else if (razorpayOrderId) {
      payment = await Payment.findOne({ razorpayOrderId });
    } else if (orderId) {
      payment = await Payment.findOne({ razorpayOrderId: orderId });
    } else if (bookingId) {
      payment = await Payment.findOne({ booking: bookingId });
    } else if (userId) {
      payment = await Payment.find({ user: userId }).sort({ createdAt: -1 }).limit(10);
    }

    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    // Populate related data
    const populatedPayment = Array.isArray(payment)
      ? await Payment.populate(payment, [
          { path: 'user', select: 'name email' },
          { path: 'host', select: 'name email' },
          { path: 'booking', select: 'status paymentStatus checkIn checkOut listing service' }
        ])
      : await Payment.findById(payment._id)
          .populate('user', 'name email')
          .populate('host', 'name email')
          .populate('booking', 'status paymentStatus checkIn checkOut listing service');

    res.status(200).json({
      success: true,
      data: populatedPayment
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error searching payment',
      error: error.message
    });
  }
};

// @desc    Get payment timeline (admin debug)
// @route   GET /api/payments/admin/debug/:paymentId/timeline
// @access  Private/Admin
const getPaymentTimeline = async (req, res) => {
  try {
    const { paymentId } = req.params;

    const payment = await Payment.findById(paymentId)
      .select('timeline processedWebhookEvents status webhookStatus failureDetails recoveryStatus createdAt updatedAt razorpayPaymentId razorpayOrderId');

    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    res.status(200).json({
      success: true,
      data: {
        paymentId: payment._id,
        razorpayPaymentId: payment.razorpayPaymentId,
        razorpayOrderId: payment.razorpayOrderId,
        status: payment.status,
        webhookStatus: payment.webhookStatus,
        recoveryStatus: payment.recoveryStatus,
        failureDetails: payment.failureDetails,
        timeline: payment.timeline || [],
        processedWebhookEvents: payment.processedWebhookEvents || [],
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching payment timeline',
      error: error.message
    });
  }
};

// @desc    Get orphan payments (admin debug)
// @route   GET /api/payments/admin/debug/orphans
// @access  Private/Admin
const getOrphanPayments = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const orphanPayments = await Payment.find({
      'metadata.source': 'webhook_orphan'
    })
      .select('razorpayPaymentId razorpayOrderId amount status recoveryStatus timeline createdAt rawWebhookPayload')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Payment.countDocuments({ 'metadata.source': 'webhook_orphan' });

    res.status(200).json({
      success: true,
      data: {
        orphanPayments,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalItems: total
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching orphan payments',
      error: error.message
    });
  }
};

// @desc    Get recovery queue (admin debug)
// @route   GET /api/payments/admin/debug/recovery-queue
// @access  Private/Admin
const getRecoveryQueue = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const recoveryPayments = await Payment.find({
      recoveryStatus: { $in: ['recovery_required', 'recovery_in_progress', 'recovery_failed'] }
    })
      .select('razorpayPaymentId razorpayOrderId amount status recoveryStatus recoveryAttempts booking timeline createdAt')
      .populate('booking', 'status paymentStatus')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Payment.countDocuments({
      recoveryStatus: { $in: ['recovery_required', 'recovery_in_progress', 'recovery_failed'] }
    });

    // Summary stats
    const stats = await Payment.aggregate([
      { $match: { recoveryStatus: { $in: ['recovery_required', 'recovery_in_progress', 'recovery_failed'] } } },
      { $group: { _id: '$recoveryStatus', count: { $sum: 1 }, totalAmount: { $sum: '$amount' } } }
    ]);

    res.status(200).json({
      success: true,
      data: {
        recoveryPayments,
        stats,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalItems: total
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching recovery queue',
      error: error.message
    });
  }
};

// @desc    Get failed payments (admin debug)
// @route   GET /api/payments/admin/debug/failed
// @access  Private/Admin
const getFailedPayments = async (req, res) => {
  try {
    const { page = 1, limit = 20, startDate, endDate } = req.query;

    const query = { status: 'failed' };
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const failedPayments = await Payment.find(query)
      .select('razorpayPaymentId razorpayOrderId amount failureDetails booking user createdAt')
      .populate('user', 'name email')
      .populate('booking', 'status listing service')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Payment.countDocuments(query);

    // Failure reason breakdown
    const failureBreakdown = await Payment.aggregate([
      { $match: query },
      { $group: { _id: '$failureDetails.error_code', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    res.status(200).json({
      success: true,
      data: {
        failedPayments,
        failureBreakdown,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalItems: total
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching failed payments',
      error: error.message
    });
  }
};

// @desc    Manually trigger reconciliation for a payment (admin debug)
// @route   POST /api/payments/admin/debug/:paymentId/reconcile
// @access  Private/Admin
const manualReconcile = async (req, res) => {
  try {
    const { paymentId } = req.params;

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    if (!payment.razorpayPaymentId) {
      return res.status(400).json({ success: false, message: 'Payment has no Razorpay payment ID' });
    }

    // Fetch latest status from Razorpay
    const rzpPayment = await razorpayService.getPaymentDetails(payment.razorpayPaymentId);

    // Add timeline entry
    await Payment.addTimelineEntry(payment._id, {
      event: 'manual_reconciliation',
      message: `Admin triggered manual reconciliation. Razorpay status: ${rzpPayment?.status}`,
      source: 'admin',
      data: { adminId: req.user._id, rzpStatus: rzpPayment?.status }
    });

    // Import and run reconciliation
    const { reconcilePayment } = require('../services/paymentReconciliation.service');
    const result = await reconcilePayment(payment);

    res.status(200).json({
      success: true,
      message: `Manual reconciliation completed: ${result}`,
      data: {
        result,
        razorpayStatus: rzpPayment?.status,
        paymentStatus: (await Payment.findById(paymentId)).status
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error during manual reconciliation',
      error: error.message
    });
  }
};

// @desc    Get reconciliation stats (admin debug)
// @route   GET /api/payments/admin/debug/reconciliation-stats
// @access  Private/Admin
const getReconciliationStats = async (req, res) => {
  try {
    const stats = await Payment.aggregate([
      {
        $facet: {
          byStatus: [
            { $group: { _id: '$status', count: { $sum: 1 }, totalAmount: { $sum: '$amount' } } }
          ],
          byRecoveryStatus: [
            { $match: { recoveryStatus: { $ne: 'none' } } },
            { $group: { _id: '$recoveryStatus', count: { $sum: 1 }, totalAmount: { $sum: '$amount' } } }
          ],
          orphanCount: [
            { $match: { 'metadata.source': 'webhook_orphan' } },
            { $count: 'count' }
          ],
          pendingReconciliation: [
            { $match: { status: { $in: ['pending', 'processing', 'authorized'] }, reconciliationAttempts: { $lt: 5 } } },
            { $count: 'count' }
          ],
          recentFailures: [
            { $match: { status: 'failed', createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } },
            { $count: 'count' }
          ]
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        byStatus: stats[0].byStatus,
        byRecoveryStatus: stats[0].byRecoveryStatus,
        orphanCount: stats[0].orphanCount[0]?.count || 0,
        pendingReconciliation: stats[0].pendingReconciliation[0]?.count || 0,
        recentFailures24h: stats[0].recentFailures[0]?.count || 0
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching reconciliation stats',
      error: error.message
    });
  }
};

module.exports = {
  processPayment,
  confirmPayment,
  cancelPayment,
  getPaymentById,
  getPaymentHistory,
  getHostPayments,
  getBookingPayments,
  processRefund,
  getRefundHistory,
  getRefundById,
  getPaymentMethods,
  addPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
  setDefaultPaymentMethod,
  createRazorpayOrder,
  stripeWebhook,
  paypalWebhook,
  razorpayWebhook,
  getPaymentStats,
  getMonthlyPaymentStats,
  getPaymentMethodStats,
  getAllPayments,
  getPendingPayouts,
  processHostPayout,
  getAdminPaymentStats,
  updatePaymentStatus,
  handlePaymentFailure,
  // Admin debug endpoints
  adminSearchPayment,
  getPaymentTimeline,
  getOrphanPayments,
  getRecoveryQueue,
  getFailedPayments,
  manualReconcile,
  getReconciliationStats
}; 

