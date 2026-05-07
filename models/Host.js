// models/Host.js
const mongoose = require('mongoose');

const hostSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  responseRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  responseTime: {
    type: String,
    enum: ['within an hour', 'within a few hours', 'within a day']
  },
  isSuperhost: {
    type: Boolean,
    default: false
  },
  hostingSince: {
    type: Date,
    default: Date.now
  },
  totalReviews: {
    type: Number,
    default: 0
  },
  averageRating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5
  },
  savedListings: [{
  type: mongoose.Schema.Types.ObjectId,
  ref: 'Property'
}],
  totalBookings: {
    type: Number,
    default: 0
  },
  verificationStatus: {
    type: String,
    enum: ['pending', 'verified', 'rejected'],
    default: 'pending'
  }
}, {
  timestamps: true
});

// Virtual for computed fields
hostSchema.virtual('reviewCount').get(function() {
  return this.totalReviews;
});

hostSchema.virtual('rating').get(function() {
  return this.averageRating;
});

module.exports = mongoose.model('Host', hostSchema);