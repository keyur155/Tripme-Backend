const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  booking: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  host: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: [0.01, 'Payment amount must be greater than 0']
  },
  paymentMethod: {
    type: String,
    enum: ['credit_card', 'debit_card', 'paypal', 'bank_transfer', 'wallet', 'upi', 'net_banking'],
    required: true
  },
  paymentDetails: {
    cardLast4: String,
    cardBrand: String,
    paymentGateway: String,
    transactionId: String,
    gatewayResponse: mongoose.Schema.Types.Mixed
  },
  // Razorpay specific fields
  razorpayOrderId: String,
  razorpayPaymentId: String,
  razorpaySignature: String,
  // Razorpay order-level status (created, attempted, paid)
  orderStatus: {
    type: String,
    enum: ['created', 'attempted', 'paid', 'unknown'],
    default: 'created'
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'authorized', 'completed', 'failed', 'refunded', 'partially_refunded', 'cancelled'],
    default: 'pending'
  },
  // Webhook tracking
  webhookStatus: {
    type: String,
    enum: ['not_received', 'authorized', 'captured', 'failed', 'processing'],
    default: 'not_received'
  },
  webhookReceivedAt: Date,
  // Failure details from Razorpay
  failureDetails: {
    error_code: String,
    error_description: String,
    error_source: String,
    error_step: String,
    error_reason: String,
    error_metadata: mongoose.Schema.Types.Mixed,
    timestamp: Date
  },
  // Reconciliation tracking
  reconciledAt: Date,
  reconciliationAttempts: {
    type: Number,
    default: 0
  },
  
  // Fee breakdown
  subtotal: {
    type: Number,
    required: true,
    min: [0, 'Subtotal must be non-negative']
  },
  taxes: {
    type: Number,
    default: 0,
    min: [0, 'Taxes must be non-negative']
  },
  gst: {
    type: Number,
    default: 0,
    min: [0, 'GST must be non-negative']
  },
  processingFee: {
    type: Number,
    default: 0,
    min: [0, 'Processing fee must be non-negative']
  },
  serviceFee: {
    type: Number,
    default: 0,
    min: [0, 'Service fee must be non-negative']
  },
  cleaningFee: {
    type: Number,
    default: 0,
    min: [0, 'Cleaning fee must be non-negative']
  },
  securityDeposit: {
    type: Number,
    default: 0,
    min: [0, 'Security deposit must be non-negative']
  },
  
  // Commission and payout structure
  commission: {
    platformFee: {
      type: Number,
      default: 0,
      min: [0, 'Platform fee must be non-negative']
    },
    hostEarning: {
      type: Number,
      default: 0,
      min: [0, 'Host earning must be non-negative']
    },
    processingFee: {
      type: Number,
      default: 0,
      min: [0, 'Processing fee must be non-negative']
    }
  },
  
  // Complete pricing breakdown for consistency
  pricingBreakdown: {
    customerBreakdown: {
      baseAmount: Number,
      extraGuestCost: Number,
      cleaningFee: Number,
      serviceFee: Number,
      securityDeposit: Number,
      hourlyExtension: Number,
      discountAmount: Number,
      subtotal: Number,
      platformFee: Number,
      gst: Number,
      processingFee: Number,
      totalAmount: Number
    },
    hostBreakdown: {
      baseAmount: Number,
      extraGuestCost: Number,
      cleaningFee: Number,
      serviceFee: Number,
      securityDeposit: Number,
      hourlyExtension: Number,
      discountAmount: Number,
      subtotal: Number,
      platformFee: Number,
      hostEarning: Number
    },
    platformBreakdown: {
      platformFee: Number,
      processingFee: Number,
      gst: Number,
      platformRevenue: Number
    }
  },
  
  // Payout tracking
  payout: {
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
      default: 'pending'
    },
    scheduledDate: Date,
    processedDate: Date,
    amount: Number,
    method: {
      type: String,
      enum: ['bank_transfer', 'paypal', 'stripe_connect', 'manual'],
      default: 'bank_transfer'
    },
    reference: String,
    notes: String
  },
  
  // Refund tracking
  refunds: [{
    amount: {
      type: Number,
      required: true,
      min: [0, 'Refund amount must be non-negative']
    },
    reason: {
      type: String,
      enum: ['cancellation', 'host_cancel', 'dispute', 'overpayment', 'service_issue'],
      required: true
    },
    type: {
      type: String,
      enum: ['full', 'partial', 'service_fee_only'],
      required: true
    },
    processedAt: {
      type: Date,
      default: Date.now
    },
    transactionId: String,
    gatewayResponse: mongoose.Schema.Types.Mixed,
    adminNotes: String
  }],
  
  // Additional fields
  coupon: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Coupon'
  },
  discountAmount: {
    type: Number,
    default: 0,
    min: [0, 'Discount amount must be non-negative']
  },
  currency: {
    type: String,
    default: 'INR',
    enum: ['INR', 'USD', 'EUR', 'GBP']
  },
  invoiceId: String,
  receiptUrl: String,
  
  // Metadata
  metadata: {
    ipAddress: String,
    userAgent: String,
    source: {
      type: String,
      enum: ['web', 'mobile_app', 'api'],
      default: 'web'
    }
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for total refunded amount
paymentSchema.virtual('totalRefunded').get(function() {
  if (!this.refunds || this.refunds.length === 0) return 0;
  return this.refunds.reduce((sum, refund) => sum + refund.amount, 0);
});

// Virtual for net amount after refunds
paymentSchema.virtual('netAmount').get(function() {
  return this.amount - this.totalRefunded;
});

// Virtual for payout amount (host earning minus refunds)
paymentSchema.virtual('payoutAmount').get(function() {
  const refundedAmount = this.totalRefunded;
  const hostEarning = this.commission.hostEarning;
  
  // If refund is more than host earning, host gets nothing
  if (refundedAmount >= hostEarning) return 0;
  
  return hostEarning - refundedAmount;
});

// Pre-save hook to calculate totals
paymentSchema.pre('save', function(next) {
  // Ensure total amount equals subtotal + all fees - discount
  if (this.isModified('subtotal') || this.isModified('taxes') || this.isModified('serviceFee') || 
      this.isModified('cleaningFee') || this.isModified('securityDeposit') || 
      this.isModified('processingFee') || this.isModified('discountAmount')) {
    
    // Calculate total amount correctly (subtotal already includes base amount + fees)
    // Total = subtotal + platform fee + GST + processing fee
    this.amount = this.subtotal + 
                  (this.commission?.platformFee || 0) + 
                  this.taxes + 
                  this.processingFee - 
                  (this.discountAmount || 0);
    
    // Ensure amount is never negative
    this.amount = Math.max(0, this.amount);
  }
  
  // Calculate commission if not set - USE DYNAMIC RATE FROM PRICING BREAKDOWN
  if (!this.commission.platformFee && this.subtotal > 0) {
    // Try to get platform fee rate from pricing breakdown first
    let platformFeeRate = 0.15; // Fallback rate
    
    if (this.pricingBreakdown?.customerBreakdown?.platformFee && this.subtotal > 0) {
      // Calculate rate from stored breakdown
      platformFeeRate = this.pricingBreakdown.customerBreakdown.platformFee / this.subtotal;
      // Rate derived from pricing breakdown
    } else {
      // No pricing breakdown found, using fallback platform fee rate: 15%
    }
    
    this.commission.platformFee = Math.round(this.subtotal * platformFeeRate * 100) / 100;
    this.commission.hostEarning = Math.round((this.subtotal - this.commission.platformFee) * 100) / 100;
    
    // Recalculate amount with correct platform fee
    this.amount = this.subtotal + 
                  this.commission.platformFee + 
                  this.taxes + 
                  this.processingFee - 
                  (this.discountAmount || 0);
  }
  
  next();
});

// Indexes
paymentSchema.index({ booking: 1 });
paymentSchema.index({ user: 1 });
paymentSchema.index({ host: 1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ 'payout.status': 1 });
paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ transactionId: 1 });
paymentSchema.index({ 'payout.scheduledDate': 1 });
paymentSchema.index({ razorpayOrderId: 1 });
paymentSchema.index({ razorpayPaymentId: 1 });

module.exports = mongoose.model('Payment', paymentSchema);