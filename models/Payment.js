const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  booking: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: false // Allow null for orphan webhook records
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false // Allow null for orphan webhook records
  },
  host: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false // Allow null for orphan webhook records
  },
  amount: {
    type: Number,
    required: false, // Allow null for orphan webhook records
    min: [0, 'Payment amount must be non-negative']
  },
  paymentMethod: {
    type: String,
    enum: ['credit_card', 'debit_card', 'paypal', 'bank_transfer', 'wallet', 'upi', 'net_banking', 'unknown'],
    default: 'unknown'
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
  // Recovery tracking
  recoveryStatus: {
    type: String,
    enum: ['none', 'recovery_required', 'recovery_in_progress', 'recovered', 'recovery_failed'],
    default: 'none'
  },
  recoveryAttempts: {
    type: Number,
    default: 0
  },
  recoveredAt: Date,
  // Processed webhook event IDs for idempotency
  processedWebhookEvents: [{
    eventId: String,
    event: String,
    processedAt: { type: Date, default: Date.now }
  }],
  // Full payment timeline logs — append-only, never overwrite
  timeline: [{
    event: { type: String, required: true },
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    source: {
      type: String,
      enum: ['system', 'webhook', 'frontend', 'reconciliation', 'admin', 'recovery'],
      default: 'system'
    },
    data: mongoose.Schema.Types.Mixed
  }],
  
  // Fee breakdown
  subtotal: {
    type: Number,
    required: false, // Allow null for orphan webhook records
    default: 0,
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
      enum: ['web', 'mobile_app', 'api', 'webhook_orphan', 'webhook' , 'create_order'],
      default: 'web'
    },
    idempotencyKey: String,
    sessionId: String,
    requestId: String,
    bookingType: String,
    propertyId: mongoose.Schema.Types.ObjectId,
    serviceId: mongoose.Schema.Types.ObjectId,
    securityVersion: String
  },
  // Raw webhook payload storage for orphan records
  rawWebhookPayload: mongoose.Schema.Types.Mixed
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
  // ═══════════════════════════════════════════════════════════════════════════
  // NEW BUSINESS MODEL:
  // - Platform earns ONLY processingFee (platformFee is DEPRECATED = 0)
  // - Host receives FULL subtotal (hostEarning = subtotal)
  // - Customer pays: subtotal + GST + processingFee
  // ═══════════════════════════════════════════════════════════════════════════
  
  const amountExplicitlySet = this.isModified('amount') && this.amount > 0;
  
  // Only auto-calculate amount if:
  // 1. Amount was NOT explicitly set, AND
  // 2. One of the component fields changed
  if (!amountExplicitlySet && 
      (this.isModified('subtotal') || this.isModified('taxes') || this.isModified('serviceFee') || 
       this.isModified('cleaningFee') || this.isModified('securityDeposit') || 
       this.isModified('processingFee') || this.isModified('discountAmount'))) {
    
    // NEW FORMULA: Total = subtotal + GST + processingFee (NO platformFee)
    this.amount = this.subtotal + 
                  this.taxes + 
                  this.processingFee - 
                  (this.discountAmount || 0);
    
    // Ensure amount is never negative
    this.amount = Math.max(0, this.amount);
  }
  
  // Set commission structure according to new business model
  // Only set if not already explicitly set
  if (this.subtotal > 0 && !this.commission?.hostEarning) {
    // NEW BUSINESS MODEL:
    // - platformFee = 0 (DEPRECATED)
    // - hostEarning = FULL subtotal (no deduction)
    // - processingFee = platform's only revenue
    this.commission = this.commission || {};
    this.commission.platformFee = 0; // DEPRECATED: No longer charged
    this.commission.hostEarning = this.subtotal; // Host receives FULL subtotal
    this.commission.processingFee = this.processingFee || 0;
  }
  
  // Ensure payout.amount matches subtotal (host receives full subtotal)
  if (this.payout && this.subtotal > 0 && !this.payout.amount) {
    this.payout.amount = this.subtotal;
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
// CRITICAL: Unique indexes to prevent duplicate payment documents
// sparse: true allows multiple null values (for payments without Razorpay IDs)
paymentSchema.index({ razorpayOrderId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ razorpayPaymentId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ status: 1, createdAt: -1 }); // Reconciliation queries
paymentSchema.index({ recoveryStatus: 1 }); // Recovery queries
paymentSchema.index({ 'metadata.source': 1 }); // Orphan tracking
paymentSchema.index({ 'processedWebhookEvents.eventId': 1 }); // Webhook dedup

// Static method: add timeline entry without overwriting history
paymentSchema.statics.addTimelineEntry = async function(paymentId, entry) {
  return this.findByIdAndUpdate(paymentId, {
    $push: {
      timeline: {
        event: entry.event,
        message: entry.message,
        timestamp: entry.timestamp || new Date(),
        source: entry.source || 'system',
        data: entry.data || {}
      }
    }
  }, { new: true });
};

// Static method: check if webhook event already processed
paymentSchema.statics.isWebhookProcessed = async function(paymentId, eventId) {
  const payment = await this.findOne({
    _id: paymentId,
    'processedWebhookEvents.eventId': eventId
  });
  return !!payment;
};

// Static method: mark webhook event as processed
paymentSchema.statics.markWebhookProcessed = async function(paymentId, eventId, eventType) {
  return this.findByIdAndUpdate(paymentId, {
    $push: {
      processedWebhookEvents: {
        eventId,
        event: eventType,
        processedAt: new Date()
      }
    }
  });
};

module.exports = mongoose.model('Payment', paymentSchema);