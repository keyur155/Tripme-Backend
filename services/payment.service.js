const Payment = require('../models/Payment');
const Payout = require('../models/Payout');
const Refund = require('../models/Refund');
const Booking = require('../models/Booking');
const User = require('../models/User');
const Notification = require('../models/Notification');
const PaymentAuditLog = require('../models/PaymentAuditLog');
const { calculatePricingBreakdown, validatePricingConsistency } = require('../utils/pricingUtils');

class PaymentService {
  /**
   * Calculate fees and commission for a booking
   */
  static calculateFees(bookingData) {
    const {
      subtotal = 0,
      cleaningFee = 0,
      securityDeposit = 0,
      taxRate = 0.18, // 18% GST
      platformFeeRate = 0.15, // 15% platform fee
      processingFeeRate = 0.029, // 2.9% processing fee
      processingFeeFixed = 30 // ₹30 fixed fee
    } = bookingData;

    // Calculate taxes
    const taxes = Math.round(subtotal * taxRate * 100) / 100;
    
    // Calculate TripMe service fee
    const platformFee = Math.round(subtotal * platformFeeRate * 100) / 100;
    
    // Calculate processing fee
    const processingFee = Math.round((subtotal * processingFeeRate + processingFeeFixed) * 100) / 100;
    
    // Calculate host earning (subtotal minus TripMe service fee)
    const hostEarning = Math.round((subtotal - platformFee) * 100) / 100;
    
    // Calculate total amount (customer pays subtotal + TripMe service fee + GST + processing fee)
    const totalAmount = subtotal + platformFee + taxes + processingFee;
    
    return {
      subtotal,
      taxes,
      cleaningFee,
      securityDeposit,
      platformFee,
      processingFee,
      hostEarning,
      totalAmount,
      breakdown: {
        baseAmount: subtotal,
        taxes,
        cleaningFee,
        securityDeposit,
        platformFee,
        processingFee,
        hostEarning
      }
    };
  }

  /**
   * Process a payment for a booking with comprehensive validation
   */
  static async processPayment(bookingId, paymentData, user) {
    const startTime = Date.now();
    
    try {
      const booking = await Booking.findById(bookingId)
        .populate('listing')
        .populate('service')
        .populate('host');

      if (!booking) {
        throw new Error('Booking not found');
      }

      // CRITICAL: Always recalculate pricing server-side for validation
      console.log('🔄 Recalculating pricing server-side for validation...');
      
      // Extract pricing parameters from booking
      const pricingParams = {
        basePrice: booking.listing?.pricing?.basePrice || booking.service?.pricing?.basePrice || 0,
        nights: booking.bookingType === 'property' ? 
          Math.ceil((new Date(booking.checkOut) - new Date(booking.checkIn)) / (1000 * 60 * 60 * 24)) : 1,
        cleaningFee: booking.cleaningFee || 0,
        serviceFee: booking.serviceFee || 0,
        securityDeposit: booking.securityDeposit || 0,
        extraGuestPrice: booking.listing?.pricing?.extraGuestPrice || booking.service?.pricing?.perPersonPrice || 0,
        extraGuests: booking.guests?.adults > 1 ? booking.guests.adults - 1 : 0,
        hourlyExtension: booking.hourlyExtension?.cost || 0,
        discountAmount: booking.discountAmount || 0,
        currency: booking.currency || 'INR'
      };

      // Recalculate pricing using unified pricing utilities
      const backendPricing = await calculatePricingBreakdown(pricingParams);
      
      // Get frontend pricing from payment data for comparison
      const frontendPricing = paymentData.pricingBreakdown || {
        subtotal: paymentData.subtotal || 0,
        platformFee: paymentData.platformFee || 0,
        gst: paymentData.gst || 0,
        processingFee: paymentData.processingFee || 0,
        totalAmount: paymentData.amount || 0
      };

      // Validate pricing consistency
      const validation = validatePricingConsistency(frontendPricing, backendPricing);
      
      if (!validation.isValid) {
        console.error('❌ PRICING VALIDATION FAILED:', validation.errors);
        
        // Log the validation failure
        await PaymentAuditLog.logPaymentCalculation({
          paymentId: null, // Will be set after payment creation
          bookingId: bookingId,
          userId: user._id,
          hostId: booking.host._id,
          inputParameters: pricingParams,
          frontendCalculation: frontendPricing,
          backendCalculation: backendPricing,
          validation: validation,
          rateInfo: {
            requestedRate: frontendPricing.platformFeeRate || 0.15,
            appliedRate: backendPricing.platformFeeRate,
            rateSource: 'database',
            rateFetchedAt: new Date()
          },
          security: {
            ipAddress: paymentData.ipAddress,
            userAgent: paymentData.userAgent,
            sessionId: paymentData.sessionId,
            idempotencyKey: paymentData.idempotencyKey,
            requestId: paymentData.requestId
          },
          audit: {
            action: 'validation_failed',
            reason: 'Frontend and backend pricing calculations do not match',
            severity: 'critical'
          }
        });
        
        throw new Error(`ERR_PRICE_MISMATCH: Frontend and backend pricing calculations do not match. Errors: ${JSON.stringify(validation.errors)}`);
      }

      console.log('✅ Pricing validation passed - frontend and backend calculations match');

      // Use backend calculation for payment (most current and accurate)
      const feeBreakdown = {
        subtotal: backendPricing.subtotal,
        taxes: backendPricing.gst,
        cleaningFee: backendPricing.cleaningFee,
        securityDeposit: backendPricing.securityDeposit,
        platformFee: backendPricing.platformFee,
        processingFee: backendPricing.processingFee,
        hostEarning: backendPricing.hostEarning,
        totalAmount: backendPricing.totalAmount
      };

      // Generate transaction ID and invoice ID
      const transactionId = paymentData.transactionId || `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const invoiceId = `INV_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const receiptId = `RCP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Create payment record with comprehensive data
      const payment = await Payment.create({
        booking: bookingId,
        user: user._id,
        host: booking.host._id,
        amount: booking.totalAmount, // Use the booking's total amount as the single source of truth
        currency: booking.currency || 'INR',
        paymentMethod: paymentData.paymentMethod || 'credit_card',
        
        // Payment details with transaction information
        paymentDetails: {
          transactionId: transactionId,
          paymentGateway: paymentData.gateway || 'razorpay',
          gatewayResponse: paymentData.gatewayResponse || {
            status: 'success',
            transactionId: transactionId,
            processedAt: new Date().toISOString(),
            gateway: paymentData.gateway || 'razorpay'
          }
        },
        // Razorpay specific fields
        razorpayOrderId: paymentData.razorpayOrderId || null,
        razorpayPaymentId: paymentData.razorpayPaymentId || null,
        razorpaySignature: paymentData.razorpaySignature || null,
        
        // Fee breakdown
        subtotal: feeBreakdown.subtotal,
        taxes: feeBreakdown.taxes,
        gst: feeBreakdown.taxes, // GST is the same as taxes
        serviceFee: backendPricing.serviceFee,
        cleaningFee: feeBreakdown.cleaningFee,
        securityDeposit: feeBreakdown.securityDeposit,
        processingFee: feeBreakdown.processingFee,
        discountAmount: booking.discountAmount || 0,
        
        // Commission structure
        commission: {
          platformFee: feeBreakdown.platformFee,
          hostEarning: feeBreakdown.hostEarning,
          processingFee: feeBreakdown.processingFee
        },
        
        // Complete pricing breakdown for audit trail
        pricingBreakdown: backendPricing.breakdown,
        
        // Payout tracking initialization
        payout: {
          status: 'pending',
          scheduledDate: booking.bookingType === 'property' && booking.checkIn ? 
            new Date(new Date(booking.checkIn).getTime() + 24 * 60 * 60 * 1000) : // 24 hours after check-in
            new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now for services
          amount: feeBreakdown.hostEarning,
          method: 'bank_transfer',
          reference: `PAYOUT_${Date.now()}`,
          notes: `Payout for booking ${booking.receiptId || booking._id}`
        },
        
        // Invoice and receipt information
        invoiceId: invoiceId,
        receiptUrl: `/receipts/${receiptId}`, // TODO: Generate actual receipt URL
        
        // Coupon information if applied
        coupon: booking.couponApplied || null,
        
        // Status and processing
        status: 'processing', // Will be updated after verification
        
        // Security and audit metadata
        metadata: {
          ipAddress: paymentData.ipAddress,
          userAgent: paymentData.userAgent,
          source: paymentData.source || 'web',
          idempotencyKey: paymentData.idempotencyKey,
          sessionId: paymentData.sessionId,
          requestId: paymentData.requestId,
          bookingType: booking.bookingType,
          propertyId: booking.listing,
          serviceId: booking.service,
          timestamp: new Date().toISOString(),
          securityVersion: '1.0'
        }
      });

      // Log successful payment calculation
      await PaymentAuditLog.logPaymentCalculation({
        paymentId: payment._id,
        bookingId: bookingId,
        userId: user._id,
        hostId: booking.host._id,
        inputParameters: pricingParams,
        frontendCalculation: frontendPricing,
        backendCalculation: backendPricing,
        validation: validation,
        rateInfo: {
          requestedRate: frontendPricing.platformFeeRate || 0.15,
          appliedRate: backendPricing.platformFeeRate,
          rateSource: 'database',
          rateFetchedAt: new Date()
        },
        security: {
          ipAddress: paymentData.ipAddress,
          userAgent: paymentData.userAgent,
          sessionId: paymentData.sessionId,
          idempotencyKey: paymentData.idempotencyKey,
          requestId: paymentData.requestId
        },
        audit: {
          action: 'payment_created',
          reason: 'Payment created successfully with validated pricing',
          severity: 'low'
        }
      });

      // Update booking (but keep as pending until payment is verified)
      booking.paymentStatus = 'pending'; // Will be updated after payment verification
      booking.status = 'pending'; // Will be updated after payment verification
      booking.platformFee = feeBreakdown.platformFee;
      booking.hostFee = feeBreakdown.hostEarning;
      await booking.save();

      // Schedule payout for host
      await this.scheduleHostPayout(payment._id, bookingId, feeBreakdown.hostEarning, booking.host._id);

      // Send notifications
      await this.sendPaymentNotifications(payment, booking, user);

      // Update audit log with processing time
      const processingTime = Date.now() - startTime;
      await PaymentAuditLog.updatePaymentStatus(payment._id, 'completed', { processingTimeMs: processingTime });

      return { payment, feeBreakdown };
    } catch (error) {
      // Log payment failure
      if (bookingId) {
        await PaymentAuditLog.updatePaymentStatus(bookingId, 'failed', { 
          rejectionReason: error.message 
        });
      }
      
      throw new Error(`Payment processing failed: ${error.message}`);
    }
  }

  /**
   * Schedule a payout for the host
   */
  static async scheduleHostPayout(paymentId, bookingId, amount, hostId) {
    try {
      // Schedule payout for 24 hours after check-in (or immediately if service)
      const booking = await Booking.findById(bookingId);
      let scheduledDate = new Date();
      
      if (booking.bookingType === 'property' && booking.checkIn) {
        scheduledDate = new Date(booking.checkIn);
        scheduledDate.setHours(scheduledDate.getHours() + 24);
      }

      const payout = await Payout.create({
        host: hostId,
        payment: paymentId,
        booking: bookingId,
        amount,
        currency: 'INR',
        status: 'pending',
        method: 'bank_transfer', // Default method
        scheduledDate,
        fees: {
          processingFee: 0,
          taxDeduction: 0,
          netAmount: amount
        }
      });

      return payout;
    } catch (error) {
      console.error('Error scheduling payout:', error);
      throw error;
    }
  }

  /**
   * Process a refund
   */
  static async processRefund(paymentId, refundData, adminUser = null) {
    try {
      const payment = await Payment.findById(paymentId)
        .populate('booking')
        .populate('user')
        .populate('host');

      if (!payment) {
        throw new Error('Payment not found');
      }

      const {
        amount,
        reason,
        type,
        adminNotes,
        userNotes
      } = refundData;

      // Validate refund amount
      if (amount > payment.amount) {
        throw new Error('Refund amount cannot exceed payment amount');
      }

      // Create refund record
      const refund = await Refund.create({
        booking: payment.booking._id,
        payment: paymentId,
        user: payment.user._id,
        host: payment.host._id,
        amount,
        reason,
        type,
        status: adminUser ? 'approved' : 'pending',
        approvedAt: adminUser ? new Date() : null,
        approvedBy: adminUser?._id,
        adminNotes,
        userNotes,
        refundReference: `REF_${Date.now()}`,
        refundBreakdown: this.calculateRefundBreakdown(payment, amount, type)
      });

      // Update payment
      payment.refunds.push({
        amount,
        reason,
        type,
        processedAt: new Date(),
        transactionId: refund.refundReference,
        adminNotes
      });

      // Update payment status
      if (amount === payment.amount) {
        payment.status = 'refunded';
      } else {
        payment.status = 'partially_refunded';
      }

      await payment.save();

      // Update booking
      if (payment.booking) {
        const booking = await Booking.findById(payment.booking._id);
        if (booking) {
          booking.refundAmount = (booking.refundAmount || 0) + amount;
          booking.paymentStatus = amount === payment.amount ? 'refunded' : 'partially_refunded';
          await booking.save();
        }
      }

      // Send notifications
      await this.sendRefundNotifications(refund, payment, adminUser);

      return refund;
    } catch (error) {
      throw new Error(`Refund processing failed: ${error.message}`);
    }
  }

  /**
   * Calculate refund breakdown based on refund type
   */
  static calculateRefundBreakdown(payment, refundAmount, refundType) {
    const breakdown = {
      baseAmount: 0,
      serviceFee: 0,
      cleaningFee: 0,
      taxes: 0,
      platformFee: 0
    };

    switch (refundType) {
      case 'full':
        // Full refund - return everything
        breakdown.baseAmount = payment.subtotal;
        breakdown.taxes = payment.taxes;
        breakdown.cleaningFee = payment.cleaningFee;
        breakdown.platformFee = payment.commission.platformFee;
        break;
      
      case 'service_fee_only':
        // Only refund service fee (platform fee)
        breakdown.platformFee = Math.min(refundAmount, payment.commission.platformFee);
        break;
      
      case 'cleaning_fee_only':
        // Only refund cleaning fee
        breakdown.cleaningFee = Math.min(refundAmount, payment.cleaningFee);
        break;
      
      case 'partial':
        // Partial refund - proportional distribution
        const refundRatio = refundAmount / payment.amount;
        breakdown.baseAmount = Math.round(payment.subtotal * refundRatio * 100) / 100;
        breakdown.taxes = Math.round(payment.taxes * refundRatio * 100) / 100;
        breakdown.cleaningFee = Math.round(payment.cleaningFee * refundRatio * 100) / 100;
        breakdown.platformFee = Math.round(payment.commission.platformFee * refundRatio * 100) / 100;
        break;
    }

    return breakdown;
  }

  /**
   * Process host payout
   */
  static async processHostPayout(payoutId, payoutData, adminUser) {
    try {
      const payout = await Payout.findById(payoutId)
        .populate('host')
        .populate('payment')
        .populate('booking');

      if (!payout) {
        throw new Error('Payout not found');
      }

      const {
        method,
        reference,
        notes,
        bankDetails,
        paypalDetails,
        stripeDetails
      } = payoutData;

      // Update payout details
      payout.method = method;
      payout.reference = reference;
      payout.notes = notes;
      payout.status = 'processing';

      // Set method-specific details
      if (method === 'bank_transfer' && bankDetails) {
        payout.bankDetails = bankDetails;
      } else if (method === 'paypal' && paypalDetails) {
        payout.paypalDetails = paypalDetails;
      } else if (method === 'stripe_connect' && stripeDetails) {
        payout.stripeDetails = stripeDetails;
      }

      // Set manual payout details if applicable
      if (method === 'manual') {
        payout.manualPayout = {
          processedBy: adminUser._id,
          processedAt: new Date(),
          notes: notes
        };
      }

      await payout.save();

      // TODO: Integrate with actual payment gateway for processing
      // For now, simulate processing
      setTimeout(async () => {
        payout.status = 'completed';
        payout.processedDate = new Date();
        await payout.save();

        // Send notification to host
        await Notification.create({
          user: payout.host._id,
          type: 'payout_completed',
          title: 'Payout Completed',
          message: `Your payout of ₹${payout.amount} has been processed successfully.`,
          data: { payoutId: payout._id, amount: payout.amount }
        });
      }, 5000); // Simulate 5 second processing

      return payout;
    } catch (error) {
      throw new Error(`Payout processing failed: ${error.message}`);
    }
  }

  /**
   * Get payment statistics for admin
   */
  static async getAdminPaymentStats() {
    try {
      const [
        totalPayments,
        totalAmount,
        totalPlatformFees,
        totalHostPayouts,
        pendingPayouts,
        totalRefunds,
        refundAmount
      ] = await Promise.all([
        Payment.countDocuments({ status: 'completed' }),
        Payment.aggregate([
          { $match: { status: 'completed' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Payment.aggregate([
          { $match: { status: 'completed' } },
          { $group: { _id: null, total: { $sum: '$commission.platformFee' } } }
        ]),
        Payout.countDocuments({ status: 'completed' }),
        Payout.countDocuments({ status: 'pending' }),
        Refund.countDocuments({ status: 'completed' }),
        Refund.aggregate([
          { $match: { status: 'completed' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ])
      ]);

      return {
        totalPayments,
        totalAmount: totalAmount[0]?.total || 0,
        totalPlatformFees: totalPlatformFees[0]?.total || 0,
        totalHostPayouts,
        pendingPayouts,
        totalRefunds,
        refundAmount: refundAmount[0]?.total || 0,
        netRevenue: (totalAmount[0]?.total || 0) - (refundAmount[0]?.total || 0)
      };
    } catch (error) {
      throw new Error(`Failed to get payment stats: ${error.message}`);
    }
  }

  /**
   * Get host payout statistics
   */
  static async getHostPayoutStats(hostId) {
    try {
      const [
        totalPayouts,
        totalAmount,
        pendingPayouts,
        pendingAmount,
        completedPayouts,
        completedAmount
      ] = await Promise.all([
        Payout.countDocuments({ host: hostId }),
        Payout.aggregate([
          { $match: { host: hostId } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Payout.countDocuments({ host: hostId, status: 'pending' }),
        Payout.aggregate([
          { $match: { host: hostId, status: 'pending' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Payout.countDocuments({ host: hostId, status: 'completed' }),
        Payout.aggregate([
          { $match: { host: hostId, status: 'completed' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ])
      ]);

      return {
        totalPayouts,
        totalAmount: totalAmount[0]?.total || 0,
        pendingPayouts,
        pendingAmount: pendingAmount[0]?.total || 0,
        completedPayouts,
        completedAmount: completedAmount[0]?.total || 0
      };
    } catch (error) {
      throw new Error(`Failed to get host payout stats: ${error.message}`);
    }
  }

  /**
   * Send payment notifications
   */
  static async sendPaymentNotifications(payment, booking, user) {
    try {
      // Notify host
      await Notification.create({
        user: booking.host._id,
        type: 'payment_received',
        title: 'Payment Received',
        message: `Payment of ₹${payment.amount} received for booking #${booking.receiptId}`,
        data: { 
          bookingId: booking._id, 
          paymentId: payment._id,
          amount: payment.amount
        }
      });

      // Notify user
      await Notification.create({
        user: user._id,
        type: 'payment_successful',
        title: 'Payment Successful',
        message: `Your payment of ₹${payment.amount} has been processed successfully.`,
        data: { 
          bookingId: booking._id, 
          paymentId: payment._id,
          amount: payment.amount
        }
      });
    } catch (error) {
      console.error('Error sending payment notifications:', error);
    }
  }

  /**
   * Send refund notifications
   */
  static async sendRefundNotifications(refund, payment, adminUser) {
    try {
      // Notify user
      await Notification.create({
        user: payment.user._id,
        type: 'refund_processed',
        title: 'Refund Processed',
        message: `Your refund of ₹${refund.amount} has been processed.`,
        data: { 
          refundId: refund._id,
          amount: refund.amount,
          reason: refund.reason
        }
      });

      // Notify host if it's a host cancellation
      if (refund.reason === 'host_cancel') {
        await Notification.create({
          user: payment.host._id,
          type: 'refund_issued',
          title: 'Refund Issued',
          message: `A refund of ₹${refund.amount} has been issued due to cancellation.`,
          data: { 
            refundId: refund._id,
            amount: refund.amount,
            reason: refund.reason
          }
        });
      }
    } catch (error) {
      console.error('Error sending refund notifications:', error);
    }
  }
}

module.exports = PaymentService;
