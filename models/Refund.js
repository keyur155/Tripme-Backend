const mongoose = require('mongoose');
const { Schema } = mongoose;

const refundSchema = new Schema({
  booking: { 
    type: Schema.Types.ObjectId, 
    ref: 'Booking', 
    required: true 
  },
  payment: { 
    type: Schema.Types.ObjectId, 
    ref: 'Payment', 
    required: true 
  },
  user: { 
    type: Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  host: { 
    type: Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  amount: { 
    type: Number, 
    required: true, 
    min: [0, 'Refund amount must be non-negative'] 
  },
  currency: { 
    type: String, 
    default: 'INR',
    enum: ['INR', 'USD', 'EUR', 'GBP']
  },
  reason: {
    type: String,
    enum: ['cancellation', 'host_cancel', 'dispute', 'overpayment', 'service_issue', 'guest_request'],
    required: true
  },
  type: {
    type: String,
    enum: ['full', 'partial', 'service_fee_only', 'cleaning_fee_only', 'security_deposit_only'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'processing', 'completed', 'failed', 'rejected', 'cancelled'],
    default: 'pending'
  },
  processedAt: Date,
  approvedAt: Date,
  approvedBy: {
    type: Schema.Types.ObjectId,
    ref: 'Admin'
  },
  gatewayResponse: Schema.Types.Mixed,
  adminNotes: String,
  userNotes: String,
  refundMethod: {
    type: String,
    enum: ['original_payment_method', 'wallet_credit', 'voucher', 'bank_transfer'],
    default: 'original_payment_method'
  },
  refundReference: String,
  estimatedProcessingTime: {
    type: String,
    default: '3-5 business days'
  },
  // Razorpay specific fields
  razorpayRefundId: String,
  // Complete refund breakdown for consistency
  refundBreakdown: {
    // Base amounts
    baseAmount: Number,
    extraGuestCost: Number,
    hourlyExtension: Number,
    
    // Host-set fees
    cleaningFee: Number,
    serviceFee: Number,
    securityDeposit: Number,
    
    // Platform fees
    platformFee: Number,
    processingFee: Number,
    gst: Number,
    
    // Discounts
    discountAmount: Number,
    
    // Calculated amounts
    subtotal: Number,
    totalAmount: Number,
    hostEarning: Number,
    platformRevenue: Number
  }
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for refund status display
refundSchema.virtual('statusDisplay').get(function() {
  const statusMap = {
    'pending': 'Pending Review',
    'approved': 'Approved',
    'processing': 'Processing',
    'completed': 'Completed',
    'failed': 'Failed',
    'rejected': 'Rejected',
    'cancelled': 'Cancelled'
  };
  return statusMap[this.status] || this.status;
});

// Virtual for refund reason display
refundSchema.virtual('reasonDisplay').get(function() {
  const reasonMap = {
    'cancellation': 'Guest Cancellation',
    'host_cancel': 'Host Cancellation',
    'dispute': 'Dispute Resolution',
    'overpayment': 'Overpayment',
    'service_issue': 'Service Issue',
    'guest_request': 'Guest Request'
  };
  return reasonMap[this.reason] || this.reason;
});

// Indexes
refundSchema.index({ booking: 1 });
refundSchema.index({ payment: 1 });
refundSchema.index({ user: 1 });
refundSchema.index({ host: 1 });
refundSchema.index({ status: 1, createdAt: -1 });
refundSchema.index({ createdAt: -1 });
refundSchema.index({ 'refundReference': 1 });
refundSchema.index({ razorpayRefundId: 1 });

module.exports = mongoose.model('Refund', refundSchema);