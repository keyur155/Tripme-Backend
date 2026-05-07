const Joi = require('joi');

// Payment processing validation
const validatePayment = Joi.object({
  bookingId: Joi.string().required().messages({
    'string.empty': 'Booking ID is required',
    'any.required': 'Booking ID is required'
  }),
  paymentMethod: Joi.string().valid(
    'credit_card', 
    'debit_card', 
    'paypal', 
    'bank_transfer', 
    'wallet', 
    'upi', 
    'net_banking'
  ).required().messages({
    'string.empty': 'Payment method is required',
    'any.only': 'Invalid payment method',
    'any.required': 'Payment method is required'
  }),
  couponCode: Joi.string().optional().allow(''),
  ipAddress: Joi.string().ip().optional(),
  userAgent: Joi.string().optional(),
  // Security fields
  idempotencyKey: Joi.string().required().messages({
    'string.empty': 'Idempotency key is required',
    'any.required': 'Idempotency key is required'
  }),
  paymentData: Joi.object({
    razorpayOrderId: Joi.string().optional(),
    razorpayPaymentId: Joi.string().optional(),
    razorpaySignature: Joi.string().optional(),
    razorpayPaymentDetails: Joi.object().optional(),
    amount: Joi.number().min(0.01).optional(),
    currency: Joi.string().valid('INR', 'USD', 'EUR', 'GBP').optional(),
    subtotal: Joi.number().min(0).optional(),
    platformFee: Joi.number().min(0).optional(),
    gst: Joi.number().min(0).optional(),
    processingFee: Joi.number().min(0).optional(),
    discountAmount: Joi.number().min(0).optional()
  }).optional().custom((value, helpers) => {
    if (!value) return value;
    const hasRazorpayProof = !!(value.razorpayOrderId && value.razorpayPaymentId && value.razorpaySignature);
    const hasAmountBundle = value.amount != null && value.subtotal != null;
    if (!hasRazorpayProof && !hasAmountBundle) {
      return helpers.error('any.invalid');
    }
    return value;
  }, 'Razorpay proof or pricing bundle validation').messages({
    'any.invalid': 'paymentData must include Razorpay proof fields or amount+subtotal'
  }),
  securityMetadata: Joi.object({
    userAgent: Joi.string().optional(),
    timestamp: Joi.string().optional(),
    clientVersion: Joi.string().optional()
  }).optional()
});

// Refund validation
const validateRefund = Joi.object({
  amount: Joi.number().positive().required().messages({
    'number.base': 'Refund amount must be a number',
    'number.positive': 'Refund amount must be positive',
    'any.required': 'Refund amount is required'
  }),
  reason: Joi.string().valid(
    'cancellation',
    'host_cancel',
    'dispute',
    'overpayment',
    'service_issue',
    'guest_request'
  ).required().messages({
    'string.empty': 'Refund reason is required',
    'any.only': 'Invalid refund reason',
    'any.required': 'Refund reason is required'
  }),
  type: Joi.string().valid(
    'full',
    'partial',
    'service_fee_only',
    'cleaning_fee_only'
  ).required().messages({
    'string.empty': 'Refund type is required',
    'any.only': 'Invalid refund type',
    'any.required': 'Refund type is required'
  }),
  userNotes: Joi.string().max(500).optional().allow(''),
  adminNotes: Joi.string().max(500).optional().allow('')
});

// Payout method update validation
const validatePayoutMethod = Joi.object({
  method: Joi.string().valid(
    'bank_transfer',
    'paypal',
    'stripe_connect',
    'manual',
    'wallet'
  ).required().messages({
    'string.empty': 'Payout method is required',
    'any.only': 'Invalid payout method',
    'any.required': 'Payout method is required'
  }),
  bankDetails: Joi.when('method', {
    is: 'bank_transfer',
    then: Joi.object({
      accountNumber: Joi.string().required().messages({
        'string.empty': 'Account number is required for bank transfer',
        'any.required': 'Account number is required for bank transfer'
      }),
      ifscCode: Joi.string().required().messages({
        'string.empty': 'IFSC code is required for bank transfer',
        'any.required': 'IFSC code is required for bank transfer'
      }),
      accountHolderName: Joi.string().required().messages({
        'string.empty': 'Account holder name is required for bank transfer',
        'any.required': 'Account holder name is required for bank transfer'
      }),
      bankName: Joi.string().required().messages({
        'string.empty': 'Bank name is required for bank transfer',
        'any.required': 'Bank name is required for bank transfer'
      })
    }),
    otherwise: Joi.forbidden()
  }),
  paypalDetails: Joi.when('method', {
    is: 'paypal',
    then: Joi.object({
      paypalEmail: Joi.string().email().required().messages({
        'string.email': 'Valid PayPal email is required',
        'string.empty': 'PayPal email is required',
        'any.required': 'PayPal email is required'
      }),
      paypalId: Joi.string().optional()
    }),
    otherwise: Joi.forbidden()
  }),
  stripeDetails: Joi.when('method', {
    is: 'stripe_connect',
    then: Joi.object({
      stripeAccountId: Joi.string().required().messages({
        'string.empty': 'Stripe account ID is required',
        'any.required': 'Stripe account ID is required'
      })
    }),
    otherwise: Joi.forbidden()
  })
});

// Payout cancellation validation
const validatePayoutCancellation = Joi.object({
  reason: Joi.string().max(500).optional().allow('')
});

// Admin payout processing validation
const validateAdminPayout = Joi.object({
  method: Joi.string().valid(
    'bank_transfer',
    'paypal',
    'stripe_connect',
    'manual',
    'wallet'
  ).required().messages({
    'string.empty': 'Payout method is required',
    'any.only': 'Invalid payout method',
    'any.required': 'Payout method is required'
  }),
  reference: Joi.string().max(100).optional().allow(''),
  notes: Joi.string().max(500).optional().allow(''),
  bankDetails: Joi.when('method', {
    is: 'bank_transfer',
    then: Joi.object({
      accountNumber: Joi.string().required(),
      ifscCode: Joi.string().required(),
      accountHolderName: Joi.string().required(),
      bankName: Joi.string().required()
    }),
    otherwise: Joi.forbidden()
  }),
  paypalDetails: Joi.when('method', {
    is: 'paypal',
    then: Joi.object({
      paypalEmail: Joi.string().email().required(),
      paypalId: Joi.string().optional()
    }),
    otherwise: Joi.forbidden()
  }),
  stripeDetails: Joi.when('method', {
    is: 'stripe_connect',
    then: Joi.object({
      stripeAccountId: Joi.string().required()
    }),
    otherwise: Joi.forbidden()
  })
});

// Payout reversal validation
const validatePayoutReversal = Joi.object({
  reason: Joi.string().max(500).required().messages({
    'string.empty': 'Reversal reason is required',
    'any.required': 'Reversal reason is required'
  }),
  notes: Joi.string().max(500).optional().allow('')
});

// Bulk payout processing validation
const validateBulkPayout = Joi.object({
  payoutIds: Joi.array().items(Joi.string().hex().length(24)).min(1).required().messages({
    'array.min': 'At least one payout ID is required',
    'array.base': 'Payout IDs must be an array',
    'any.required': 'Payout IDs are required'
  }),
  method: Joi.string().valid(
    'bank_transfer',
    'paypal',
    'stripe_connect',
    'manual',
    'wallet'
  ).required(),
  notes: Joi.string().max(500).optional().allow('')
});

// Payment method validation
const validatePaymentMethod = Joi.object({
  type: Joi.string().valid('card', 'upi', 'wallet', 'net_banking').required(),
  details: Joi.object().required(),
  isDefault: Joi.boolean().default(false)
});

// Payment method update validation
const validatePaymentMethodUpdate = Joi.object({
  details: Joi.object().required()
});

module.exports = {
  validatePayment,
  validateRefund,
  validatePayoutMethod,
  validatePayoutCancellation,
  validateAdminPayout,
  validatePayoutReversal,
  validateBulkPayout,
  validatePaymentMethod,
  validatePaymentMethodUpdate
}; 
