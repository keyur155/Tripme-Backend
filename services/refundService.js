/**
 * Comprehensive Refund Service
 * Handles all refund scenarios with proper breakdown and recording
 */

const Refund = require('../models/Refund');
const Booking = require('../models/Booking');
const Payment = require('../models/Payment');
const { calculateRefundBreakdown } = require('../utils/refundCalculator');
const razorpayService = require('./razorpay.service');

class RefundService {
  /**
   * Process refund for different scenarios
   * @param {string} bookingId - Booking ID
   * @param {string} reason - Refund reason
   * @param {string} type - Refund type
   * @param {Object} options - Additional options
   * @returns {Object} Refund record
   */
  static async processRefund(bookingId, reason, type, options = {}) {
    try {
      console.log('🔄 ===========================================');
      console.log('🔄 REFUND SERVICE - PROCESSING REFUND');
      console.log('🔄 ===========================================');
      console.log('📋 Booking ID:', bookingId);
      console.log('📝 Reason:', reason);
      console.log('📝 Type:', type);
      console.log('🔄 ===========================================');
      
      const booking = await Booking.findById(bookingId)
        .populate('user', 'name email')
        .populate('host', 'name email')
        .populate('payment');

      if (!booking) {
        throw new Error('Booking not found');
      }

      if (!booking.payment) {
        throw new Error('No payment found for this booking');
      }

      console.log('✅ Booking found:', booking._id);
      console.log('✅ Payment found:', booking.payment._id);
      console.log('💳 Razorpay Payment ID:', booking.payment.razorpayPaymentId || 'N/A');

      // Calculate refund amount based on scenario
      const refundData = await this.calculateRefundAmount(booking, reason, type, options);
      
      console.log('💰 ===========================================');
      console.log('💰 REFUND CALCULATION');
      console.log('💰 ===========================================');
      console.log('💰 Refund Amount:', refundData.amount, booking.currency || 'INR');
      console.log('💰 Original Booking Amount:', booking.totalAmount);
      console.log('💰 Refund Type:', type);
      console.log('💰 ===========================================');
      
      // Create refund record
      const refund = new Refund({
        booking: booking._id,
        payment: booking.payment._id,
        user: booking.user._id,
        host: booking.host._id,
        amount: refundData.amount,
        currency: booking.currency || 'INR',
        reason: reason,
        type: type,
        status: 'pending', // Always start as pending for admin approval
        refundBreakdown: refundData.breakdown,
        userNotes: options.userNotes || '',
        adminNotes: options.adminNotes || '',
        refundMethod: 'original_payment_method',
        refundReference: `REF-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
        estimatedProcessingTime: '3-5 business days'
      });

      await refund.save();
      console.log('✅ Refund record created in database:', refund._id);
      console.log('📋 Refund Reference:', refund.refundReference);

      // Process refund through Razorpay if payment was made via Razorpay
      const payment = await Payment.findById(booking.payment._id);
      if (payment && payment.razorpayPaymentId && refundData.amount > 0) {
        try {
          // For host cancellations, automatically process refund
          if (reason === 'host_cancel') {
            console.log('🔄 ===========================================');
            console.log('🔄 INITIATING RAZORPAY REFUND');
            console.log('🔄 ===========================================');
            console.log('💳 Razorpay Payment ID:', payment.razorpayPaymentId);
            console.log('💰 Refund Amount:', refundData.amount, 'INR');
            console.log('💰 Refund Amount (Paise):', Math.round(refundData.amount * 100));
            console.log('📋 Refund Reference:', refund.refundReference);
            console.log('🔄 ===========================================');
            
            const razorpayRefund = await razorpayService.createRefund(
              payment.razorpayPaymentId,
              refundData.amount,
              `Host cancellation refund - ${refund.refundReference}`,
              {
                bookingId: booking._id.toString(),
                refundReference: refund.refundReference
              }
            );

            console.log('✅ ===========================================');
            console.log('✅ RAZORPAY REFUND INITIATED');
            console.log('✅ ===========================================');
            console.log('💳 Razorpay Refund ID:', razorpayRefund.refundId);
            console.log('💳 Original Payment ID:', razorpayRefund.paymentId);
            console.log('💰 Refund Amount:', razorpayRefund.amount, razorpayRefund.currency);
            console.log('📊 Refund Status:', razorpayRefund.status);
            console.log('⚡ Refund Speed:', razorpayRefund.speed);
            console.log('📅 Created At:', razorpayRefund.createdAt);
            console.log('✅ ===========================================');

            // Update refund with Razorpay details
            refund.razorpayRefundId = razorpayRefund.refundId;
            refund.gatewayResponse = razorpayRefund;
            refund.status = 'processing'; // Move to processing since refund initiated
            refund.processedAt = new Date();
            await refund.save();

            console.log('✅ Refund record updated with Razorpay details');
            console.log('📊 Refund Status: processing (waiting for Razorpay webhook)');
          } else {
            // For other refunds, mark as pending for admin approval
            // Admin will process refund through Razorpay after approval
            console.log(`📋 Refund created, pending admin approval for Razorpay processing`);
          }
        } catch (razorpayError) {
          console.error('❌ ===========================================');
          console.error('❌ RAZORPAY REFUND ERROR');
          console.error('❌ ===========================================');
          console.error('❌ Error:', razorpayError.message);
          console.error('❌ Stack:', razorpayError.stack);
          console.error('❌ ===========================================');
          // Don't fail the refund creation, but log the error
          refund.adminNotes = (refund.adminNotes || '') + ` | Razorpay refund error: ${razorpayError.message}`;
          await refund.save();
          // Refund record is created, but Razorpay processing failed
          // Admin can retry manually
        }
      } else {
        if (!payment) {
          console.log('⚠️ Payment not found - skipping Razorpay refund');
        } else if (!payment.razorpayPaymentId) {
          console.log('⚠️ No Razorpay Payment ID - payment was not made via Razorpay');
        } else if (refundData.amount <= 0) {
          console.log('⚠️ Refund amount is 0 - skipping Razorpay refund');
        }
      }

      // Update booking refund status
      booking.refundAmount = refundData.amount;
      booking.refunded = refundData.amount > 0;
      booking.refundStatus = refundData.amount > 0 ? 'pending' : 'not_applicable';
      await booking.save();

      console.log('✅ Booking updated with refund details');
      console.log('✅ ===========================================');
      console.log('✅ REFUND PROCESSING COMPLETE');
      console.log('✅ ===========================================');

      return refund;
    } catch (error) {
      console.error('❌ ===========================================');
      console.error('❌ REFUND PROCESSING FAILED');
      console.error('❌ ===========================================');
      console.error('❌ Error:', error.message);
      console.error('❌ Stack:', error.stack);
      console.error('❌ ===========================================');
      throw new Error(`Refund processing failed: ${error.message}`);
    }
  }

  /**
   * Calculate refund amount based on scenario
   * @param {Object} booking - Booking object
   * @param {string} reason - Refund reason
   * @param {string} type - Refund type
   * @param {Object} options - Additional options
   * @returns {Object} Refund amount and breakdown
   */
  static async calculateRefundAmount(booking, reason, type, options = {}) {
    const pricingBreakdown = booking.pricingBreakdown;
    
    // Scenario 1: Host cancels before accepting booking - FULL REFUND
    if (reason === 'host_cancel' && booking.status === 'pending') {
      return {
        amount: booking.totalAmount, // Full refund including all fees
        breakdown: this.createRefundBreakdown(pricingBreakdown, 'full', booking)
      };
    }

    // Scenario 2: User cancels before host accepts - FULL REFUND
    if (reason === 'cancellation' && booking.status === 'pending') {
      return {
        amount: booking.totalAmount, // Full refund including all fees
        breakdown: this.createRefundBreakdown(pricingBreakdown, 'full', booking)
      };
    }

    // Scenario 3: Security deposit refund (always refunded)
    if (type === 'security_deposit_only') {
      const securityDeposit = pricingBreakdown?.customerBreakdown?.securityDeposit || 
                             booking.securityDeposit || 0;
      return {
        amount: securityDeposit,
        breakdown: this.createRefundBreakdown(pricingBreakdown, 'security_deposit_only', booking)
      };
    }

    // Scenario 4: Cancellation policy based refund - EXCLUDE PLATFORM FEES
    if (reason === 'cancellation' && booking.status === 'confirmed') {
      const refundData = this.calculateCancellationRefundWithPolicy(booking, options);
      return {
        amount: refundData.amount,
        breakdown: refundData.breakdown
      };
    }

    // Scenario 5: Host cancels after accepting - FULL REFUND
    if (reason === 'host_cancel' && booking.status === 'confirmed') {
      return {
        amount: booking.totalAmount, // Full refund + compensation
        breakdown: this.createRefundBreakdown(pricingBreakdown, 'full', booking)
      };
    }

    // Scenario 6: Service issues or disputes - FULL REFUND
    if (reason === 'service_issue' || reason === 'dispute') {
      return {
        amount: booking.totalAmount, // Full refund
        breakdown: this.createRefundBreakdown(pricingBreakdown, 'full', booking)
      };
    }

    // Default: No refund
    return {
      amount: 0,
      breakdown: this.createRefundBreakdown(pricingBreakdown, 'none', booking)
    };
  }

  /**
   * Calculate refund based on cancellation policy (EXCLUDES PLATFORM FEES)
   * @param {Object} booking - Booking object
   * @param {Object} options - Additional options
   * @returns {Object} Refund amount and breakdown
   */
  static calculateCancellationRefundWithPolicy(booking, options = {}) {
    const pricingBreakdown = booking.pricingBreakdown;
    const customerBreakdown = pricingBreakdown?.customerBreakdown || {};
    
    // Calculate refundable amount (excluding platform fees and service charges)
    const refundableAmount = this.calculateRefundableAmount(booking);
    
    const cancellationPolicy = booking.cancellationPolicy || 'moderate';
    const checkInTime = booking.checkIn || booking.timeSlot?.startTime;
    const hoursUntilCheckIn = (new Date(checkInTime) - new Date()) / (1000 * 60 * 60);
    const daysUntilCheckIn = hoursUntilCheckIn / 24;

    let refundPercentage = 0;
    let policyDescription = '';

    switch (cancellationPolicy) {
      case 'flexible':
        // Full refund if cancelled more than 24 hours before check-in
        refundPercentage = hoursUntilCheckIn > 24 ? 100 : 0;
        policyDescription = hoursUntilCheckIn > 24 ? 
          'Full refund (excluding platform fees) if cancelled more than 24 hours before check-in' :
          'No refund if cancelled within 24 hours of check-in';
        break;
      
      case 'moderate':
        // Full refund if cancelled more than 5 days before check-in
        refundPercentage = daysUntilCheckIn > 5 ? 100 : 0;
        policyDescription = daysUntilCheckIn > 5 ? 
          'Full refund (excluding platform fees) if cancelled more than 5 days before check-in' :
          'No refund if cancelled within 5 days of check-in';
        break;
      
      case 'strict':
        // 50% refund if cancelled more than 7 days before check-in
        refundPercentage = daysUntilCheckIn > 7 ? 50 : 0;
        policyDescription = daysUntilCheckIn > 7 ? 
          '50% refund (excluding platform fees) if cancelled more than 7 days before check-in' :
          'No refund if cancelled within 7 days of check-in';
        break;
      
      case 'super_strict':
        // No refunds
        refundPercentage = 0;
        policyDescription = 'No refunds under any circumstances';
        break;
      
      default:
        refundPercentage = 0;
        policyDescription = 'Standard cancellation policy applies';
    }

    const refundAmount = (refundableAmount * refundPercentage) / 100;
    
    return {
      amount: refundAmount,
      breakdown: this.createRefundBreakdown(pricingBreakdown, 
        refundPercentage === 100 ? 'full_excluding_fees' : 
        refundPercentage > 0 ? 'partial_excluding_fees' : 'none', booking),
      policyDescription,
      refundPercentage
    };
  }

  /**
   * Calculate refundable amount (excluding platform fees and service charges)
   * @param {Object} booking - Booking object
   * @returns {number} Refundable amount
   */
  static calculateRefundableAmount(booking) {
    const pricingBreakdown = booking.pricingBreakdown;
    const customerBreakdown = pricingBreakdown?.customerBreakdown || {};
    
    // Include in refund:
    // - Base amount
    // - Extra guest costs
    // - Hourly extension costs
    // - Cleaning fee (host-set)
    // - Service fee (host-set)
    // - Security deposit
    // - Discount amount (if any)
    
    // Exclude from refund:
    // - Platform fee
    // - Processing fee
    // - GST (on platform fees)
    
    const refundableAmount = 
      (customerBreakdown.baseAmount || 0) +
      (customerBreakdown.extraGuestCost || 0) +
      (customerBreakdown.hourlyExtension || 0) +
      (customerBreakdown.cleaningFee || 0) +
      (customerBreakdown.serviceFee || 0) +
      (customerBreakdown.securityDeposit || 0) +
      (customerBreakdown.discountAmount || 0);
    
    return Math.max(0, refundableAmount);
  }

  /**
   * Calculate refund based on cancellation policy (LEGACY - for backward compatibility)
   * @param {Object} booking - Booking object
   * @param {Object} options - Additional options
   * @returns {number} Refund amount
   */
  static calculateCancellationRefund(booking, options = {}) {
    const refundData = this.calculateCancellationRefundWithPolicy(booking, options);
    return refundData.amount;
  }

  /**
   * Create refund breakdown for consistency
   * @param {Object} pricingBreakdown - Pricing breakdown from booking
   * @param {string} refundType - Type of refund
   * @param {Object} booking - Booking object
   * @returns {Object} Refund breakdown
   */
  static createRefundBreakdown(pricingBreakdown, refundType, booking) {
    const customerBreakdown = pricingBreakdown?.customerBreakdown || {};
    const hostBreakdown = pricingBreakdown?.hostBreakdown || {};
    const platformBreakdown = pricingBreakdown?.platformBreakdown || {};

    const baseBreakdown = {
      baseAmount: customerBreakdown.baseAmount || 0,
      extraGuestCost: 0, // Not stored in current structure
      hourlyExtension: customerBreakdown.hourlyExtension || 0,
      cleaningFee: customerBreakdown.cleaningFee || 0,
      serviceFee: customerBreakdown.serviceFee || 0,
      securityDeposit: customerBreakdown.securityDeposit || 0,
      platformFee: customerBreakdown.platformFee || 0,
      processingFee: customerBreakdown.processingFee || 0,
      gst: customerBreakdown.gst || 0,
      discountAmount: customerBreakdown.discountAmount || 0,
      subtotal: customerBreakdown.subtotal || 0,
      totalAmount: customerBreakdown.totalAmount || booking.totalAmount,
      hostEarning: hostBreakdown.hostEarning || 0,
      platformRevenue: platformBreakdown.platformRevenue || 0
    };

    // Calculate refund amounts based on type
    let refundAmount = 0;
    let refundBreakdown = { ...baseBreakdown };

    switch (refundType) {
      case 'full':
        refundAmount = baseBreakdown.totalAmount;
        // All amounts are refunded
        break;
      
      case 'full_excluding_fees':
        // Full refund excluding platform fees and service charges
        refundAmount = baseBreakdown.baseAmount + baseBreakdown.extraGuestCost + 
                      baseBreakdown.hourlyExtension + baseBreakdown.cleaningFee + 
                      baseBreakdown.serviceFee + baseBreakdown.securityDeposit + 
                      baseBreakdown.discountAmount;
        refundBreakdown.platformFee = 0;
        refundBreakdown.processingFee = 0;
        refundBreakdown.gst = 0;
        break;
      
      case 'partial':
        // Only refund base amount and host fees, not platform fees
        refundAmount = baseBreakdown.baseAmount + baseBreakdown.cleaningFee + 
                      baseBreakdown.serviceFee + baseBreakdown.securityDeposit;
        refundBreakdown.platformFee = 0;
        refundBreakdown.processingFee = 0;
        refundBreakdown.gst = 0;
        break;
      
      case 'partial_excluding_fees':
        // Partial refund excluding platform fees and service charges
        // This will be calculated based on the percentage from cancellation policy
        refundAmount = (baseBreakdown.baseAmount + baseBreakdown.extraGuestCost + 
                       baseBreakdown.hourlyExtension + baseBreakdown.cleaningFee + 
                       baseBreakdown.serviceFee + baseBreakdown.securityDeposit + 
                       baseBreakdown.discountAmount) * 0.5; // 50% for strict policy
        refundBreakdown.platformFee = 0;
        refundBreakdown.processingFee = 0;
        refundBreakdown.gst = 0;
        break;
      
      case 'security_deposit_only':
        refundAmount = baseBreakdown.securityDeposit;
        refundBreakdown.baseAmount = 0;
        refundBreakdown.cleaningFee = 0;
        refundBreakdown.serviceFee = 0;
        refundBreakdown.platformFee = 0;
        refundBreakdown.processingFee = 0;
        refundBreakdown.gst = 0;
        break;
      
      case 'service_fee_only':
        refundAmount = baseBreakdown.serviceFee;
        refundBreakdown.baseAmount = 0;
        refundBreakdown.cleaningFee = 0;
        refundBreakdown.securityDeposit = 0;
        refundBreakdown.platformFee = 0;
        refundBreakdown.processingFee = 0;
        refundBreakdown.gst = 0;
        break;
      
      case 'cleaning_fee_only':
        refundAmount = baseBreakdown.cleaningFee;
        refundBreakdown.baseAmount = 0;
        refundBreakdown.serviceFee = 0;
        refundBreakdown.securityDeposit = 0;
        refundBreakdown.platformFee = 0;
        refundBreakdown.processingFee = 0;
        refundBreakdown.gst = 0;
        break;
      
      default:
        refundAmount = 0;
        // No refund
    }

    return {
      ...refundBreakdown,
      refundAmount: refundAmount
    };
  }

  /**
   * Get refund history for a user
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @returns {Array} Refund records
   */
  static async getRefundHistory(userId, options = {}) {
    const { page = 1, limit = 10, status } = options;
    
    const query = { user: userId };
    if (status) {
      query.status = status;
    }

    const refunds = await Refund.find(query)
      .populate('booking', 'totalAmount currency checkIn checkOut')
      .populate('payment', 'amount paymentMethod')
      .populate('host', 'name')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Refund.countDocuments(query);

    return {
      refunds,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total
      }
    };
  }

  /**
   * Update refund status
   * @param {string} refundId - Refund ID
   * @param {string} status - New status
   * @param {Object} options - Additional options
   * @returns {Object} Updated refund
   */
  static async updateRefundStatus(refundId, status, options = {}) {
    const refund = await Refund.findById(refundId)
      .populate('booking', 'totalAmount refundAmount refunded refundStatus');
    
    if (!refund) {
      throw new Error('Refund not found');
    }

    const oldStatus = refund.status;
    refund.status = status;
    
    if (status === 'approved') {
      refund.approvedAt = new Date();
      refund.approvedBy = options.approvedBy;
    }
    
    if (status === 'processing') {
      refund.processedAt = new Date();
    }
    
    if (status === 'completed') {
      refund.processedAt = new Date();
      
      // Update booking status when refund is completed
      if (refund.booking) {
        refund.booking.refunded = true;
        refund.booking.refundStatus = 'completed';
        refund.booking.paymentStatus = refund.amount === refund.booking.totalAmount ? 'refunded' : 'partially_refunded';
        await refund.booking.save();
      }
    }
    
    if (status === 'rejected') {
      // Update booking status when refund is rejected
      if (refund.booking) {
        refund.booking.refunded = false;
        refund.booking.refundStatus = 'rejected';
        await refund.booking.save();
      }
    }
    
    if (options.adminNotes) {
      refund.adminNotes = options.adminNotes;
    }

    await refund.save();
    
    console.log(`✅ Refund ${refundId} status updated from ${oldStatus} to ${status}`);
    return refund;
  }

  /**
   * Get all pending refunds for admin review
   * @param {Object} options - Query options
   * @returns {Object} Pending refunds with pagination
   */
  static async getPendingRefunds(options = {}) {
    const { page = 1, limit = 20, reason, type } = options;
    
    const query = { status: 'pending' };
    if (reason) query.reason = reason;
    if (type) query.type = type;

    const refunds = await Refund.find(query)
      .populate('booking', 'totalAmount currency checkIn checkOut status')
      .populate('payment', 'amount paymentMethod status')
      .populate('user', 'name email')
      .populate('host', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Refund.countDocuments(query);

    return {
      refunds,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total
      }
    };
  }

  /**
   * Admin approve refund
   * @param {string} refundId - Refund ID
   * @param {string} adminId - Admin user ID
   * @param {string} adminNotes - Admin notes
   * @returns {Object} Updated refund
   */
  static async approveRefund(refundId, adminId, adminNotes = '') {
    return await this.updateRefundStatus(refundId, 'approved', {
      approvedBy: adminId,
      adminNotes: adminNotes || 'Refund approved by admin'
    });
  }

  /**
   * Admin reject refund
   * @param {string} refundId - Refund ID
   * @param {string} adminId - Admin user ID
   * @param {string} adminNotes - Admin notes
   * @returns {Object} Updated refund
   */
  static async rejectRefund(refundId, adminId, adminNotes = '') {
    return await this.updateRefundStatus(refundId, 'rejected', {
      approvedBy: adminId,
      adminNotes: adminNotes || 'Refund rejected by admin'
    });
  }

  /**
   * Admin mark refund as processing
   * @param {string} refundId - Refund ID
   * @param {string} adminId - Admin user ID
   * @param {string} adminNotes - Admin notes
   * @returns {Object} Updated refund
   */
  static async markRefundAsProcessing(refundId, adminId, adminNotes = '') {
    return await this.updateRefundStatus(refundId, 'processing', {
      approvedBy: adminId,
      adminNotes: adminNotes || 'Refund processing initiated by admin'
    });
  }

  /**
   * Admin mark refund as completed
   * @param {string} refundId - Refund ID
   * @param {string} adminId - Admin user ID
   * @param {string} adminNotes - Admin notes
   * @returns {Object} Updated refund
   */
  static async markRefundAsCompleted(refundId, adminId, adminNotes = '') {
    return await this.updateRefundStatus(refundId, 'completed', {
      approvedBy: adminId,
      adminNotes: adminNotes || 'Refund completed by admin'
    });
  }

  /**
   * Process refund through Razorpay (called when admin approves or for host cancellations)
   * @param {string} refundId - Refund ID
   * @returns {Object} Updated refund with Razorpay details
   */
  static async processRazorpayRefund(refundId) {
    try {
      const refund = await Refund.findById(refundId)
        .populate('payment')
        .populate('booking');

      if (!refund) {
        throw new Error('Refund not found');
      }

      const payment = refund.payment;
      if (!payment.razorpayPaymentId) {
        throw new Error('Payment was not made through Razorpay');
      }

      if (refund.razorpayRefundId) {
        console.log(`ℹ️ Refund already processed through Razorpay: ${refund.razorpayRefundId}`);
        return refund;
      }

      // Create refund through Razorpay
      const razorpayRefund = await razorpayService.createRefund(
        payment.razorpayPaymentId,
        refund.amount,
        `Refund for ${refund.reason} - ${refund.refundReference}`,
        {
          bookingId: refund.booking._id.toString(),
          refundReference: refund.refundReference
        }
      );

      // Update refund with Razorpay details
      refund.razorpayRefundId = razorpayRefund.refundId;
      refund.gatewayResponse = razorpayRefund;
      refund.status = 'processing';
      refund.processedAt = new Date();
      await refund.save();

      console.log(`✅ Razorpay refund processed: ${razorpayRefund.refundId}`);
      return refund;
    } catch (error) {
      console.error('❌ Error processing Razorpay refund:', error);
      throw new Error(`Failed to process Razorpay refund: ${error.message}`);
    }
  }
}

module.exports = RefundService;
