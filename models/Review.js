// const mongoose = require('mongoose');

// const reviewSchema = new mongoose.Schema({
//   booking: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'Booking',
//     required: true
//   },
//   reviewer: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'User',
//     required: true
//   },
//   reviewedUser: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'User',
//     required: true
//   },
//   listing: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'Property'
//   },
//   service: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'Service'
//   },
//   reviewType: {
//     type: String,
//     enum: ['property', 'service', 'host', 'guest'],
//     required: true
//   },
//   rating: {
//     type: Number,
//     required: true,
//     min: 1,
//     max: 5
//   },
//   subRatings: {
//     cleanliness: {
//       type: Number,
//       min: 1,
//       max: 5
//     },
//     accuracy: {
//       type: Number,
//       min: 1,
//       max: 5
//     },
//     communication: {
//       type: Number,
//       min: 1,
//       max: 5
//     },
//     location: {
//       type: Number,
//       min: 1,
//       max: 5
//     },
//     checkIn: {
//       type: Number,
//       min: 1,
//       max: 5
//     },
//     value: {
//       type: Number,
//       min: 1,
//       max: 5
//     }
//   },
//   comment: {
//     type: String,
//     maxlength: [2000, 'Review cannot exceed 2000 characters']
//   },
//   hostResponse: {
//     text: String,
//     respondedAt: Date
//   },
//   isPublished: {
//     type: Boolean,
//     default: true
//   },
//   reported: {
//     isReported: Boolean,
//     reason: String,
//     reportedBy: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'User'
//     },
//     reportedAt: Date
//   }
// }, {
//   timestamps: true
// });

// // Custom validator to ensure either listing or service is provided, but not both
// reviewSchema.pre('save', function(next) {
//   if (!this.listing && !this.service) {
//     return next(new Error('Either listing or service must be provided'));
//   }
//   if (this.listing && this.service) {
//     return next(new Error('Cannot have both listing and service in the same review'));
//   }
//   next();
// });

// // Indexes
// reviewSchema.index({ booking: 1 }, { unique: true });
// reviewSchema.index({ reviewer: 1 });
// reviewSchema.index({ reviewedUser: 1 });
// reviewSchema.index({ listing: 1 });
// reviewSchema.index({ service: 1 });
// reviewSchema.index({ rating: 1 });
// reviewSchema.index({ reviewType: 1 });

// // Note: Host review validation moved to controller for performance
// // This validation is now handled in the review controller before saving

// // Static method to check if host can review
// reviewSchema.statics.canHostReview = async function(bookingId, hostId) {
//   const booking = await mongoose.model('Booking').findById(bookingId).populate('user');
//   if (!booking) return false;

//   // Check if guest has already reviewed
//   const guestReview = await this.findOne({
//     booking: bookingId,
//     reviewer: booking.user._id
//   });

//   return !!guestReview;
// };

// module.exports = mongoose.model('Review', reviewSchema);


const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  booking: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: true
  },
  property: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Property'
  },
  reviewer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  host: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  rating: {
    overall: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    cleanliness: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    communication: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    checkIn: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    accuracy: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    location: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    value: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    }
  },
  comment: {
    type: String,
    required: true,
    maxlength: [2000, 'Review cannot exceed 2000 characters']
  },
  response: {
    comment: String,
    respondedAt: Date,
    respondedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  images: [String], // Review photos
  isVerified: {
    type: Boolean,
    default: false // Verified stay review
  },
  isPublic: {
    type: Boolean,
    default: true
  },
  helpfulCount: {
    type: Number,
    default: 0
  },
  helpfulVotes: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    votedAt: {
      type: Date,
      default: Date.now
    }
  }],
  reports: [{
    reason: String,
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    reportedAt: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true
});

reviewSchema.statics.canHostReview = async function(bookingId, hostId) {
  const booking = await mongoose.model('Booking').findById(bookingId).populate('user');
  if (!booking) return false;

  // Check if guest has already reviewed
  const guestReview = await this.findOne({
    booking: bookingId,
    reviewer: booking.user._id
  });

  return !!guestReview;
};


reviewSchema.pre('save', function(next) {
  if (!this.property && !this.service) {
    return next(new Error('Either listing or service must be provided'));
  }
  if (this.property && this.service) {
    return next(new Error('Cannot have both listing and service in the same review'));
  }
  next();
});

// Indexes
reviewSchema.index({ booking: 1 }, { unique: true });
reviewSchema.index({ property: 1 });
reviewSchema.index({ reviewer: 1 });
reviewSchema.index({ host: 1 });
reviewSchema.index({ 'rating.overall': 1 });
reviewSchema.index({ createdAt: -1 });

// reviewSchema.index({ booking: 1 }, { unique: true });
// reviewSchema.index({ reviewer: 1 });
// reviewSchema.index({ reviewedUser: 1 });
// reviewSchema.index({ listing: 1 });
// reviewSchema.index({ service: 1 });
// reviewSchema.index({ rating: 1 });
// reviewSchema.index({ reviewType: 1 });

module.exports = mongoose.model('Review', reviewSchema);