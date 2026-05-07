const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
    validate: {
      validator: function(v) {
        return /^[A-Z0-9]{3,20}$/.test(v);
      },
      message: 'Coupon code must be 3-20 characters long and contain only uppercase letters and numbers'
    }
  },
  couponImage: {
    type: String,
    required: true
  },
  discountType: {
    type: String,
    enum: ['percentage', 'fixed'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  maxDiscount: {
    type: Number,
    min: 0
  },
  minBookingAmount: {
    type: Number,
    min: 0
  },
  validFrom: {
    type: Date,
    required: true
  },
  validTo: {
    type: Date,
    required: true
  },
  usageLimit: {
    type: Number,
    min: 1
  },
  usedCount: {
    type: Number,
    default: 0
  },
  usedBy: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    usedAt: Date
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  applicableToListings: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Property'
  }],
  applicableToServices: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service'
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  }
}, {
  timestamps: true
});

// Indexes
couponSchema.index({ code: 1 }, { unique: true });
couponSchema.index({ validFrom: 1 });
couponSchema.index({ validTo: 1 });
couponSchema.index({ isActive: 1 });

// Pre-save hook to validate dates
couponSchema.pre('save', function(next) {
  if (this.validFrom >= this.validTo) {
    throw new Error('Valid From date must be before Valid To date');
  }
  next();
});

module.exports = mongoose.model('Coupon', couponSchema);