const mongoose = require('mongoose');
const slugify = require('slugify');

const propertySchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Please enter a title'],
    trim: true,
    maxlength: [100, 'Title cannot exceed 100 characters']
  },
  description: {
    type: String,
    required: [true, 'Please enter a description'],
    maxlength: [2000, 'Description cannot exceed 2000 characters']
  },
  host: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
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
    state: String,
    country: String,
    postalCode: String
  },
  type: {
    type: String,
    enum: ['villa', 'apartment', 'hostel', 'guesthouse', 'hotel', 'house', 'cottage', 'cabin', 'treehouse', 'boat', 'farm', 'camper', 'tent', 'castle'],
    required: true
  },
  propertyType: {
    type: String,
    enum: ['premium', 'standard', 'budget', 'luxury'],
    default: 'standard'
  },
  style: {
    type: String,
    enum: ['modern', 'traditional', 'minimalist', 'rustic', 'industrial', 'scandinavian', 'mediterranean', 'tropical'],
    default: 'modern'
  },
  placeType: {
    type: String,
    enum: ['entire', 'room','private', 'shared'],
    default: 'entire'
  },
  images: [{
    url: {
      type: String,
      required: false,
      validate: {
        validator: function(v) {
          return !v || /^https?:\/\/.+/.test(v);
        },
        message: 'Image URL must be a valid HTTP/HTTPS URL'
      }
    },
    publicId: {
      type: String,
      required: false
    },
     category: {  
    type: String,
    enum: [
      "Living room",
      "Bedroom",
      "Kitchen",
      "Bathroom",
      "Exterior",
      "Amenities",
      "Other"
    ],
    default: "Other"
  },
    isPrimary: {
      type: Boolean,
      default: false
    },
    caption: {
      type: String,
      maxlength: [200, 'Image caption cannot exceed 200 characters'],
      required: false
    },
    width: {
      type: Number,
      min: [0, 'Image width cannot be negative'],
      required: false
    },
    height: {
      type: Number,
      min: [0, 'Image height cannot be negative'],
      required: false
    },
    format: {
      type: String,
      enum: ['jpeg', 'jpg', 'png', 'gif', 'webp'],
      required: false
    },
    size: {
      type: Number,
      min: [0, 'Image size cannot be negative'],
      required: false
    }
  }],
  pricing: {
    basePrice: {
      type: Number,
      required: true,
      min: [1, 'Price must be at least 1']
    },
    // NEW: 24-hour based pricing
    basePrice24Hour: {
      type: Number,
      min: [0, '24-hour price cannot be negative'],
      default: 0
    },
    extraGuestPrice: {
      type: Number,
      default: 0
    },
    cleaningFee: {
      type: Number,
      default: 0
    },
    serviceFee: {
      type: Number,
      default: 0
    },
    securityDeposit: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      default: 'INR',
      enum: ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'INR']
    },
    weeklyDiscount: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    monthlyDiscount: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    }
  },
  hourlyBooking: {
    enabled: {
      type: Boolean,
      default: false
    },
    minStayDays: {
      type: Number,
      default: 1,
      min: 1
    },
    hourlyRates: {
      sixHours: {
        type: Number,
        default: 0.30,
        min: 0,
        max: 1
      },
      twelveHours: {
        type: Number,
        default: 0.60,
        min: 0,
        max: 1
      },
      eighteenHours: {
        type: Number,
        default: 0.75,
        min: 0,
        max: 1
      }
    }
  },
  // houseRules: [{
  //   type: String,
  //   // enum: ['no-smoking', 'no-pets', 'no-parties',  'no-unregistered-guests']
  // }],
  houseRules: {
  common: [{
    type: String
  }],
  additional: {
    type: Object,
    default: {}
  },
  default: { common: [], additional: {} }
},
  checkInTime: {
    type: String,
    default: '15:00'
  },
  checkOutTime: {
    type: String,
    default: '11:00'
  },
    // NEW: 24-hour booking settings
    enable24HourBooking: {
      type: Boolean,
      default: false
    },
    // NEW: 24-hour availability settings
    availabilitySettings: {
      minBookingHours: {
        type: Number,
        default: 24
      },
      maxBookingHours: {
        type: Number,
        default: 168 // 7 days max
      },
      hostBufferTime: {
        type: Number,
        default: 2 // Hours for property preparation
      },
      allowedCheckInTimes: [{
        type: String,
        match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format. Use HH:MM']
      }],
      advanceBookingDays: {
        type: Number,
        default: 365
      }
    },

  amenities: [{
    type: String,
    enum: ['wifi', 'tv', 'kitchen', 
      'washer', 'dryer', 'ac', 'heating',
       'workspace', 'pool', 'hot-tub', 'parking',
        'gym', 'breakfast', 'smoke-alarm', 
        'carbon-monoxide-alarm', 'first-aid-kit', 
        'fire-extinguisher', 'essentials', 'fireplace' ,'security']
  }],
  features: [{
    type: String,
    enum: ['ocean-view', 'mountain-view', 'city-view', 'garden', 'balcony', 'terrace', 'fireplace', 'elevator', 'wheelchair-accessible', 'pet-friendly', 'smoking-allowed', 'long-term-stays']
  }],
  services: [{
    type: String,
    enum: ['car-rental', 'airport-pickup', 'guided-tours', 'cooking-classes', 'yoga-classes', 'massage', 'cleaning', 'laundry', 'concierge', 'breakfast', 'dinner']
  }],
  maxGuests: {
    type: Number,
    required: true,
    min: 1
  },
  minNights: {
    type: Number,
    default: 1,
    min: 1
  },
  bedrooms: {
    type: Number,
    required: true,
    min: 1
  },
  beds: {
    type: Number,
    required: true,
    min: 1
  },
  bathrooms: {
    type: Number,
    required: true,
    min: 1
  },
  cancellationPolicy: {
    type: String,
    enum: ['flexible', 'moderate', 'strict', 'super-strict'],
    default: 'moderate'
  },
  isFeatured: {
    type: Boolean,
    default: false
  },
  isDraft: {
    type: Boolean,
    default: true
  },
  isSponsored: {
    type: Boolean,
    default: false
  },
  isTopRated: {
    type: Boolean,
    default: false
  },
  seo: {
    metaTitle: String,
    metaDescription: String,
    slug: {
      type: String,
      unique: true
    }
  },
  status: {
    type: String,
    enum: ['draft', 'published', 'suspended', 'deleted'],
    default: 'draft'
  },
  approvalStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: null
  },
  isPublished: {
    type: Boolean,
    default: false
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: {
    type: Date
  },
  approvalReason: {
    type: String,
    maxlength: [500, 'Approval reason cannot exceed 500 characters']
  },
  rejectionReason: {
    type: String,
    maxlength: [500, 'Rejection reason cannot exceed 500 characters']
  },
  rating: {
    average: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    },
    cleanliness: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    },
    accuracy: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    },
    communication: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    },
    location: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    },
    checkIn: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    },
    value: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    }
  },
  reviewCount: {
    type: Number,
    default: 0
  },
  // Admin-assigned badges (override dynamic badges)
  adminBadges: {
    highlight: [{
      type: { type: String },
      label: { type: String },
      priority: { type: Number, default: 1 }
    }],
    details: [{
      type: { type: String },
      label: { type: String },
      priority: { type: Number, default: 1 }
    }],
    insights: [{
      type: { type: String },
      label: { type: String },
      priority: { type: Number, default: 1 }
    }],
    urgency: [{
      type: { type: String },
      label: { type: String },
      priority: { type: Number, default: 1 }
    }]
  },
  // Flag to use admin badges instead of dynamic ones
  useAdminBadges: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
propertySchema.index({ location: '2dsphere' });
propertySchema.index({ host: 1 });
propertySchema.index({ title: 'text', description: 'text' });
propertySchema.index({ 'seo.slug': 1 }, { unique: true, sparse: true });
propertySchema.index({ propertyType: 1 });
propertySchema.index({ isFeatured: 1 });
propertySchema.index({ isSponsored: 1 });
propertySchema.index({ isTopRated: 1 });
propertySchema.index({ status: 1 });
propertySchema.index({ approvalStatus: 1 });

// Virtuals
propertySchema.virtual('reviews', {
  ref: 'Review',
  localField: '_id',
  foreignField: 'listing'
});

propertySchema.virtual('bookings', {
  ref: 'Booking',
  localField: '_id',
  foreignField: 'listing'
});
// propertySchema.virtual('badges').get(function () {
//   const badges = [];

//   // ⭐ Rating based
//   if (this.rating?.average >= 4.5) {
//     badges.push({ label: "Highly rated" });
//   }

//   if (this.rating?.checkIn >= 4.7) {
//     badges.push({ label: "Exceptional check-in"});
//   }

//   if (this.rating?.location >= 4.7) {
//     badges.push({ label: "Great location" });
//   }

//   if (this.reviewCount >= 20) {
//     badges.push({ label: "Loved by guests" });
//   }

//   // 🆕 New
//   const days =
//     (Date.now() - new Date(this.createdAt)) / (1000 * 60 * 60 * 24);

//   if (days < 15) {
//     badges.push({ label: "New", icon: "🆕" });
//   }

//   // 🔥 Optional (if you add stats later)
//   if (this.stats?.views > 1000) {
//     badges.push({ label: "Trending" });
//   }

//   return badges;
// });

// Pre-save hook to generate slug


const HIGHLIGHT_BADGES = [
  {
    type: "guest_favorite",
    label: "Guest favourite",
    icon: "🏆",
    priority: 1,
    condition: (l) => l.rating?.average >= 4.7 && l.reviewCount >= 20
  },
  {
    type: "top_5_percent",
    label: "Top 5% of homes",
    icon: "🥇",
    priority: 2,
    condition: (l) => l.rankScore >= 95 // optional future
  },
  {
    type: "super_host",
    label: "Superhost",
    icon: "⭐",
    priority: 3,
    condition: (l) => l.host?.rating >= 4.8 && l.host?.reviewCount > 50
  },
  {
    type: "rare_find",
    label: "Rare find",
    icon: "💎",
    priority: 4,
    condition: (l) => (l.availabilityMeta?.remainingSlots || 0) <= 1
  }
];

const DETAIL_BADGES = [
  {
    type: "checkin",
    label: "Exceptional check-in",
    icon: "🔑",
    priority: 1,
    condition: (l) => l.rating?.checkIn >= 4.7
  },
  {
    type: "cleanliness",
    label: "Sparkling clean",
    icon: "🧼",
    priority: 2,
    condition: (l) => l.rating?.cleanliness >= 4.7
  },
  {
    type: "location",
    label: "Great location",
    icon: "📍",
    priority: 3,
    condition: (l) => l.rating?.location >= 4.7
  },
  {
    type: "value",
    label: "Great value",
    icon: "💰",
    priority: 4,
    condition: (l) => l.rating?.value >= 4.7
  },
  {
    type: "host_exp",
    label: "Experienced host",
    icon: "👤",
    priority: 5,
    condition: (l) => l.host?.createdAt && (new Date().getFullYear() - new Date(l.host.createdAt).getFullYear()) >= 3
  }
];

const INSIGHT_BADGES = [
  {
    type: "price_low",
    label: "Price is lower than average",
    icon: "🏷️",
    priority: 1,
    condition: (l) => l.pricing?.basePrice < (l.avgPrice || 0)
  },
  {
    type: "high_demand",
    label: "In high demand",
    icon: "🔥",
    priority: 2,
    condition: (l) => (l.stats?.bookingsLast7Days || 0) > 5
  },
  {
    type: "trending",
    label: "Trending",
    icon: "📈",
    priority: 3,
    condition: (l) => (l.stats?.views || 0) > 1000
  }
];

const URGENCY_BADGES = [
  {
    type: "only_one_left",
    label: "Only 1 left",
    icon: "⚡",
    priority: 1,
    condition: (l) => (l.availabilityMeta?.remainingSlots || 0) === 1
  },
  {
    type: "limited_slots",
    label: "Limited availability",
    icon: "⏳",
    priority: 2,
    condition: (l) => (l.availabilityMeta?.remainingSlots || 0) <= 3
  }
];

const pickBadges = (list, listing, limit) => {
  return list
    .filter(b => b.condition(listing))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, limit)
    .map(({ condition, ...rest }) => rest);
};

propertySchema.virtual('badges').get(function () {
  // Admin-only badge system: Only return badges if admin has assigned them
  // No dynamic badges by default - badges must be explicitly assigned via admin panel
  if (this.adminBadges) {
    const adminHighlight = this.adminBadges.highlight || [];
    const adminDetails = this.adminBadges.details || [];
    const adminInsights = this.adminBadges.insights || [];
    const adminUrgency = this.adminBadges.urgency || [];
    
    // Return admin badges (frontend handles icons based on badge type)
    return {
      highlight: adminHighlight.map(b => ({ type: b.type, label: b.label, priority: b.priority })),
      details: adminDetails.map(b => ({ type: b.type, label: b.label, priority: b.priority })),
      insights: adminInsights.map(b => ({ type: b.type, label: b.label, priority: b.priority })),
      urgency: adminUrgency.map(b => ({ type: b.type, label: b.label, priority: b.priority }))
    };
  }

  // Return empty badges if no admin badges assigned
  return {
    highlight: [],
    details: [],
    insights: [],
    urgency: []
  };
});

propertySchema.pre('save', function(next) {
  // Generate slug if title is modified or if slug is missing/null
  if (this.isModified('title') || !this.seo?.slug) {
    if (!this.seo) {
      this.seo = {};
    }
    this.seo.slug = slugify(this.title, { lower: true });
  }
  next();
});

module.exports = mongoose.model('Property', propertySchema);