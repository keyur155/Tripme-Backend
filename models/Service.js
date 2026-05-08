const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Please enter a title'],
    trim: true,
    maxlength: [100, 'Title cannot exceed 100 characters']
  },
  description: {
    type: String,
    required: [true, 'Please enter a description'],
    maxlength: [500, 'Description cannot exceed 500 characters']
  },
  provider: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  serviceType: {
    type: String,
    enum: ['tour-guide', 'transport', 'fitness', 'chef', 'photographer', 'hairdresser', 'yoga-teacher', 'transportation', 'cleaning', 'music', 'art', 'other'],
    required: true
  },
  duration: {
    value: {
      type: Number,
      required: false
    },
    minDuration: {
      type: Number,
      required: false
    },
    maxDuration: {
      type: Number,
      required: false
    },
    unit: {
      type: String,
      enum: ['minutes', 'hours', 'days'],
      required: true
    }
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      required: true
    },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: function(coords) {
          return coords.length === 2 && 
                 coords[0] >= -180 && coords[0] <= 180 && // longitude
                 coords[1] >= -90 && coords[1] <= 90;     // latitude
        },
        message: 'Coordinates must be an array of 2 numbers: [longitude, latitude]'
      }
    },
    address: String,
    userAddress: String, // User's own address description
    city: String,
    country: String
  },
  groupSize: {
    min: {
      type: Number,
      default: 1
    },
    max: {
      type: Number,
      required: true
    }
  },
  availableSlots: [{
    startTime: Date,
    endTime: Date,
    isAvailable: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ['available', 'unavailable', 'on-hold', 'booked'],
      default: 'available'
    }
  }],
  pricing: {
    basePrice: {
      type: Number,
      required: true
    },
    perPersonPrice: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      default: 'INR'
    }
  },
  cancellationPolicy: {
    type: String,
    enum: ['flexible', 'moderate', 'strict', 'non-refundable'],
    default: 'moderate'
  },
  requirements: [String],
  media: [{
    url: {
      type: String,
      required: true,
      validate: {
        validator: function(v) {
          return /^https?:\/\/.+/.test(v);
        },
        message: 'Media URL must be a valid HTTP/HTTPS URL'
      }
    },
    type: {
      type: String,
      enum: ['image', 'video'],
      required: true
    },
    caption: {
      type: String,
      maxlength: [200, 'Media caption cannot exceed 200 characters']
    }
  }],
  rating: {
    average: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    },
    quality: Number,
    communication: Number,
    value: Number
  },
  reviewCount: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['draft', 'published', 'suspended', 'deleted'],
    default: 'draft'
  },
  seo: {
    metaTitle: String,
    metaDescription: String,
    slug: {
      type: String,
      unique: true
    }
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
serviceSchema.index({ location: '2dsphere' });
serviceSchema.index({ provider: 1 });
serviceSchema.index({ title: 'text', description: 'text' });
serviceSchema.index({ 'seo.slug': 1 }, { unique: true });

// Virtuals
serviceSchema.virtual('reviews', {
  ref: 'Review',
  localField: '_id',
  foreignField: 'service'
});

serviceSchema.virtual('bookings', {
  ref: 'Booking',
  localField: '_id',
  foreignField: 'service'
});

module.exports = mongoose.model('Service', serviceSchema);