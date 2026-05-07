const mongoose = require('mongoose');
const validator = require('validator');

const emailSubscriptionSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    validate: [validator.isEmail, 'Please enter a valid email']
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false 
  },
  name: {
    type: String,
    required: false,
    trim: true,
    maxlength: [100, 'Name cannot exceed 100 characters']
  },
  source: {
    type: String,
    enum: ['footer', 'landing_page', 'popup', 'manual'],
    default: 'footer'
  },
  status: {
    type: String,
    enum: ['active', 'unsubscribed', 'bounced'],
    default: 'active'
  },
  preferences: {
    exclusiveOffers: {
      type: Boolean,
      default: true
    },
    newsletters: {
      type: Boolean,
      default: true
    },
    updates: {
      type: Boolean,
      default: false
    }
  },
  subscribedAt: {
    type: Date,
    default: Date.now
  },
  unsubscribedAt: Date,
  lastEmailSent: Date,
  emailCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Indexes for better performance
emailSubscriptionSchema.index({ email: 1 }, { unique: true });
emailSubscriptionSchema.index({ userId: 1 });
emailSubscriptionSchema.index({ status: 1 });

module.exports = mongoose.model('EmailSubscription', emailSubscriptionSchema);