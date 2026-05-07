const Joi = require('joi');

// Create listing validation
const validateListing = (req, res, next) => {
  
  console.log('validateListing', req.body);
  const schema = Joi.object({
    title: Joi.string()
      .min(10)
      .max(200)
      .required()
      .messages({
        'string.min': 'Title must be at least 10 characters long',
        'string.max': 'Title cannot exceed 200 characters',
        'any.required': 'Title is required'
      }),
    description: Joi.string()
      .min(50)
      .max(2000)
      .required()
      .messages({
        'string.min': 'Description must be at least 50 characters long',
        'string.max': 'Description cannot exceed 2000 characters',
        'any.required': 'Description is required'
      }),
    type: Joi.string()
      .valid('villa', 'apartment', 'hostel', 'house', 'cottage', 'cabin', 'treehouse', 'boat')
      .required()
      .messages({
        'any.only': 'Property type must be one of the valid options',
        'any.required': 'Property type is required'
      }),
    // propertyType: Joi.string()
    //   .valid('premium', 'standard', 'budget', 'luxury')
    //   .default('standard')
    //   .messages({
    //     'any.only': 'Property category must be one of: premium, standard, budget, luxury',
    //     'any.required': 'Property category is required'
    //   }),
    // style: Joi.string()
    //   .valid('modern', 'traditional', 'minimalist', 'rustic', 'industrial', 'scandinavian', 'mediterranean', 'tropical')
    //   .default('modern')
    //   .messages({
    //     'any.only': 'Style must be one of the valid options'
    //   }),

    maxGuests: Joi.number()
      .min(1)
      .max(20)
      .required()
      .messages({
        'number.min': 'Maximum guests must be at least 1',
        'number.max': 'Maximum guests cannot exceed 20',
        'any.required': 'Maximum guests is required'
      }),
    bedrooms: Joi.number()
      .min(0)
      .max(20)
      .required()
      .messages({
        'number.min': 'Bedrooms cannot be negative',
        'number.max': 'Bedrooms cannot exceed 20',
        'any.required': 'Number of bedrooms is required'
      }),
    bathrooms: Joi.number()
      .min(0)
      .max(20)
      .required()
      .messages({
        'number.min': 'Bathrooms cannot be negative',
        'number.max': 'Bathrooms cannot exceed 20',
        'any.required': 'Number of bathrooms is required'
      }),
    minNights: Joi.number()
      .min(1)
      .max(365)
      .default(1)
      .messages({
        'number.min': 'Minimum nights must be at least 1',
        'number.max': 'Minimum nights cannot exceed 365'
      }),
    beds: Joi.number()
      .min(1)
      .max(50)
      .required()
      .messages({
        'number.min': 'Number of beds must be at least 1',
        'number.max': 'Number of beds cannot exceed 50',
        'any.required': 'Number of beds is required'
      }),
    pricing: Joi.object({
      basePrice: Joi.number()
        .min(1)
        .max(10000)
        .required()
        .messages({
          'number.min': 'Base price must be at least $1',
          'number.max': 'Base price cannot exceed $10,000',
          'any.required': 'Base price is required'
        }),
      basePrice24Hour: Joi.number()
        .min(0)
        .max(10000)
        .optional()
        .allow(null)
        .messages({
          'number.min': '24-hour price cannot be negative',
          'number.max': '24-hour price cannot exceed $10,000'
        }),
      extraGuestPrice: Joi.number()
        .min(0)
        .max(1000)
        .default(0)
        .messages({
          'number.min': 'Extra guest price cannot be negative',
          'number.max': 'Extra guest price cannot exceed $1,000'
        }),
      cleaningFee: Joi.number()
        .min(0)
        .max(1000)
        .default(0)
        .messages({
          'number.min': 'Cleaning fee cannot be negative',
          'number.max': 'Cleaning fee cannot exceed $1,000'
        }),
      serviceFee: Joi.number()
        .min(0)
        .max(1000)
        .default(0)
        .messages({
          'number.min': 'Service fee cannot be negative',
          'number.max': 'Service fee cannot exceed $1,000'
        }),
      securityDeposit: Joi.number()
        .min(0)
        .max(5000)
        .default(0)
        .messages({
          'number.min': 'Security deposit cannot be negative',
          'number.max': 'Security deposit cannot exceed $5,000'
        }),
         weekendPremium: Joi.number()
        .min(0)
        .max(100)
        .default(0)
        .messages({
          'number.min': 'weekedPremium cannot be negative',
          'number.max': 'weekedPremium cannot exceed 100%'
        }),
      currency: Joi.string()
        .valid('USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'INR')
        .default('INR')
        .messages({
          'any.only': 'Currency must be one of the supported currencies'
        }),
      weeklyDiscount: Joi.number()
        .min(0)
        .max(100)
        .default(0)
        .messages({
          'number.min': 'Weekly discount cannot be negative',
          'number.max': 'Weekly discount cannot exceed 100%'
        }),
      monthlyDiscount: Joi.number()
        .min(0)
        .max(100)
        .default(0)
        .messages({
          'number.min': 'Monthly discount cannot be negative',
          'number.max': 'Monthly discount cannot exceed 100%'
        }),
    }).required(),

   
    
    hourlyBooking: Joi.object({
      enabled: Joi.boolean()
        .default(false)
        .messages({
          'boolean.base': 'Hourly booking enabled must be a boolean'
        }),
      minStayDays: Joi.number()
        .min(1)
        .max(30)
        .default(1)
        .messages({
          'number.min': 'Minimum stay days must be at least 1',
          'number.max': 'Minimum stay days cannot exceed 30'
        }),
      hourlyRates: Joi.object({
        sixHours: Joi.number()
          .min(0)
          .max(1)
          .default(0.30)
          .messages({
            'number.min': '6-hour rate cannot be negative',
            'number.max': '6-hour rate cannot exceed 100%'
          }),
        twelveHours: Joi.number()
          .min(0)
          .max(1)
          .default(0.60)
          .messages({
            'number.min': '12-hour rate cannot be negative',
            'number.max': '12-hour rate cannot exceed 100%'
          }),
        eighteenHours: Joi.number()
          .min(0)
          .max(1)
          .default(0.75)
          .messages({
            'number.min': '18-hour rate cannot be negative',
            'number.max': '18-hour rate cannot exceed 100%'
          })
      }).default({
        sixHours: 0.30,
        twelveHours: 0.60,
        eighteenHours: 0.75
      })
    }).default({
      enabled: false,
      minStayDays: 1,
      hourlyRates: {
        sixHours: 0.30,
        twelveHours: 0.60,
        eighteenHours: 0.75
      }
    }),
    location: Joi.object({
      type: Joi.string()
        .valid('Point')
        .required()
        .messages({
          'any.only': 'Location type must be Point',
          'any.required': 'Location type is required'
        }),
      coordinates: Joi.array()
        .items(Joi.number())
        .length(2)
        .required()
        .messages({
          'array.length': 'Coordinates must be an array of 2 numbers [longitude, latitude]',
          'any.required': 'Coordinates are required'
        }),
      address: Joi.string()
        .min(10)
        .max(500)
        .required()
        .messages({
          'string.min': 'Address must be at least 10 characters long',
          'string.max': 'Address cannot exceed 500 characters',
          'any.required': 'Address is required'
        }),
      userAddress: Joi.string()
        .min(10)
        .max(1000)
        .required()
        .messages({
          'string.min': 'User address must be at least 10 characters long',
          'string.max': 'User address cannot exceed 1000 characters',
          'any.required': 'User address is required'
        }),
      city: Joi.string()
        .min(2)
        .max(100)
        .required()
        .messages({
          'string.min': 'City must be at least 2 characters long',
          'string.max': 'City cannot exceed 100 characters',
          'any.required': 'City is required'
        }),
      state: Joi.string()
        .min(2)
        .max(100)
        .required()
        .messages({
          'string.min': 'State must be at least 2 characters long',
          'string.max': 'State cannot exceed 100 characters',
          'any.required': 'State is required'
        }),
      country: Joi.string()
        .min(2)
        .max(100)
        .required()
        .messages({
          'string.min': 'Country must be at least 2 characters long',
          'string.max': 'Country cannot exceed 100 characters',
          'any.required': 'Country is required'
        }),
      postalCode: Joi.string()
        .pattern(/^[A-Za-z0-9\s-]+$/)
        .min(3)
        .max(20)
        .required()
        .messages({
          'string.pattern.base': 'Please provide a valid postal code',
          'string.min': 'Postal code must be at least 3 characters long',
          'string.max': 'Postal code cannot exceed 20 characters',
          'any.required': 'Postal code is required'
        })
    }).required(),
    amenities: Joi.array()
      .items(Joi.string())
      .max(50)
      .messages({
        'array.max': 'Cannot exceed 50 amenities'
      }),
    features: Joi.array()
      .items(Joi.string())
      .max(50)
      .messages({
        'array.max': 'Cannot exceed 50 features'
      }),
    // houseRules: Joi.array()
    //   .items(Joi.string())
    //   .max(20)
    //   .messages({
    //     'array.max': 'Cannot exceed 20 house rules'
    //   }),
houseRules: Joi.object({
  common: Joi.array()
    .items(Joi.string())
    .max(20)
    .optional()
    .messages({
      'array.max': 'Cannot exceed 20 common house rules'
    }),
  additional: Joi.object()
    .optional()
    .messages({
      'object.base': 'Additional house rules must be an object'
    })
}).optional()
.messages({
  'object.base': 'House rules must be an object'
}),

    checkInTime: Joi.string()
      .pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .default('15:00')
      .messages({
        'string.pattern.base': 'Check-in time must be in HH:MM format'
      }),
    checkOutTime: Joi.string()
      .pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .default('11:00')
      .messages({
        'string.pattern.base': 'Check-out time must be in HH:MM format'
      }),
    cancellationPolicy: Joi.string()
      .valid('flexible', 'moderate', 'strict', 'super-strict')
      .default('moderate')
      .messages({
        'any.only': 'Cancellation policy must be one of: flexible, moderate, strict, super-strict'
      }),
    images: Joi.array()
      .items(Joi.object({
        url: Joi.string().uri().optional().allow('').messages({
          'string.uri': 'Image URL must be a valid URI'
        }),
         category: Joi.string()
        .valid(
          "Living room",
          "Bedroom",
          "Kitchen",
          "Bathroom",
          "Exterior",
          "Amenities",
          "Other"
        )
        .optional()
        .default("Other"),
        publicId: Joi.string().optional().allow(''),
        isPrimary: Joi.boolean().optional(),
        caption: Joi.string().optional().allow(''),
        width: Joi.number().optional(),
        height: Joi.number().optional(),
        format: Joi.string().optional().allow(''),
        size: Joi.number().optional()
      }))
      .max(20)
      .optional()
      .messages({
        'array.max': 'Cannot exceed 20 images'
      }),
    availability: Joi.object({
      instantBookable: Joi.boolean().default(false),
      minStay: Joi.number().min(1).max(365).default(1),
      maxStay: Joi.number().min(1).max(365).default(365),
      advanceBookingDays: Joi.number().min(0).max(365).default(365),
      cancellationPolicy: Joi.string()
        .valid('flexible', 'moderate', 'strict', 'super_strict')
        .default('moderate')
        .messages({
          'any.only': 'Cancellation policy must be one of: flexible, moderate, strict, super_strict'
        })
    }).optional(),
    safety: Joi.object({
      smokeDetector: Joi.boolean().default(false),
      carbonMonoxideDetector: Joi.boolean().default(false),
      fireExtinguisher: Joi.boolean().default(false),
      firstAidKit: Joi.boolean().default(false),
      emergencyContact: Joi.string().max(200).optional()
    }).optional(),
    accessibility: Joi.object({
      wheelchairAccessible: Joi.boolean().default(false),
      stepFreeAccess: Joi.boolean().default(false),
      wideDoorways: Joi.boolean().default(false),
      accessibleBathroom: Joi.boolean().default(false),
      accessibleParking: Joi.boolean().default(false)
    }).optional()
  }).unknown(true); // Allow unknown fields

  const { error } = schema.validate(req.body);
  if (error) {

    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }))
    });
  }

  next();
};



// Update listing validation
const validateListingUpdate = (req, res, next) => {
  
  const schema = Joi.object({
    title: Joi.string()
      .min(10)
      .max(200)
      .optional()
      .messages({
        'string.min': 'Title must be at least 10 characters long',
        'string.max': 'Title cannot exceed 200 characters'
      }),
    description: Joi.string()
      .min(50)
      .max(2000)
      .optional()
      .messages({
        'string.min': 'Description must be at least 50 characters long',
        'string.max': 'Description cannot exceed 2000 characters'
      }),
    propertyType: Joi.string()
      .valid('premium', 'standard', 'budget', 'luxury')
      .optional()
      .messages({
        'any.only': 'Property type must be one of: premium, standard, budget, luxury'
      }),
    type: Joi.string()
      .valid('villa', 'apartment', 'hostel', 'house', 'cottage', 'cabin', 'treehouse', 'boat')
      .optional()
      .messages({
        'any.only': 'Property type must be one of the valid options'
      }),
    style: Joi.string()
      .valid('modern', 'traditional', 'minimalist', 'rustic', 'industrial', 'scandinavian', 'mediterranean', 'tropical')
      .optional()
      .messages({
        'any.only': 'Style must be one of the valid options'
      }),
    roomType: Joi.string()
      .valid('entire', 'room', 'shared')
      .optional()
      .messages({
        'any.only': 'Room type must be entire, room, or shared'
      }),
    placeType: Joi.string()
      .valid('entire', 'room', 'shared')
      .optional()
      .messages({
        'any.only': 'Place type must be entire, room, or shared'
      }),
    maxGuests: Joi.number()
      .min(1)
      .max(20)
      .optional()
      .messages({
        'number.min': 'Maximum guests must be at least 1',
        'number.max': 'Maximum guests cannot exceed 20'
      }),
    bedrooms: Joi.number()
      .min(0)
      .max(20)
      .optional()
      .messages({
        'number.min': 'Bedrooms cannot be negative',
        'number.max': 'Bedrooms cannot exceed 20'
      }),
    bathrooms: Joi.number()
      .min(0)
      .max(20)
      .optional()
      .messages({
        'number.min': 'Bathrooms cannot be negative',
        'number.max': 'Bathrooms cannot exceed 20'
      }),
    beds: Joi.number()
      .min(1)
      .max(50)
      .optional()
      .messages({
        'number.min': 'Number of beds must be at least 1',
        'number.max': 'Number of beds cannot exceed 50'
      }),
    minNights: Joi.number()
      .min(1)
      .max(365)
      .optional()
      .messages({
        'number.min': 'Minimum nights must be at least 1',
        'number.max': 'Minimum nights cannot exceed 365'
      }),
    pricing: Joi.object({
      basePrice: Joi.number()
        .min(1)
        .max(10000)
        .optional()
        .messages({
          'number.min': 'Base price must be at least $1',
          'number.max': 'Base price cannot exceed $10,000'
        }),
      basePrice24Hour: Joi.number()
        .min(0)
        .max(10000)
        .optional()
        .allow(null)
        .messages({
          'number.min': '24-hour price cannot be negative',
          'number.max': '24-hour price cannot exceed $10,000'
        }),
      extraGuestPrice: Joi.number()
        .min(0)
        .max(1000)
        .optional()
        .messages({
          'number.min': 'Extra guest price cannot be negative',
          'number.max': 'Extra guest price cannot exceed $1,000'
        }),
      cleaningFee: Joi.number()
        .min(0)
        .max(1000)
        .optional()
        .messages({
          'number.min': 'Cleaning fee cannot be negative',
          'number.max': 'Cleaning fee cannot exceed $1,000'
        }),
      serviceFee: Joi.number()
        .min(0)
        .max(1000)
        .optional()
        .messages({
          'number.min': 'Service fee cannot be negative',
          'number.max': 'Service fee cannot exceed $1,000'
        }),
      securityDeposit: Joi.number()
        .min(0)
        .max(5000)
        .optional()
        .messages({
          'number.min': 'Security deposit cannot be negative',
          'number.max': 'Security deposit cannot exceed $5,000'
        }),
      currency: Joi.string()
        .valid('USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'INR')
        .optional()
        .messages({
          'any.only': 'Currency must be one of the supported currencies'
        }),
      weeklyDiscount: Joi.number()
        .min(0)
        .max(100)
        .optional()
        .messages({
          'number.min': 'Weekly discount cannot be negative',
          'number.max': 'Weekly discount cannot exceed 100%'
        }),
      monthlyDiscount: Joi.number()
        .min(0)
        .max(100)
        .optional()
        .messages({
          'number.min': 'Monthly discount cannot be negative',
          'number.max': 'Monthly discount cannot exceed 100%'
        })
    }).optional(),
    location: Joi.object({
      type: Joi.string()
        .valid('Point')
        .optional()
        .messages({
          'any.only': 'Location type must be Point'
        }),
      coordinates: Joi.array()
        .items(Joi.number())
        .length(2)
        .optional()
        .messages({
          'array.length': 'Coordinates must be an array of 2 numbers [longitude, latitude]'
        }),
      address: Joi.string()
        .min(10)
        .max(500)
        .optional()
        .messages({
          'string.min': 'Address must be at least 10 characters long',
          'string.max': 'Address cannot exceed 500 characters'
        }),
      userAddress: Joi.string()
        .min(10)
        .max(1000)
        .optional()
        .messages({
          'string.min': 'User address must be at least 10 characters long',
          'string.max': 'User address cannot exceed 1000 characters'
        }),
      city: Joi.string()
        .min(2)
        .max(100)
        .optional()
        .messages({
          'string.min': 'City must be at least 2 characters long',
          'string.max': 'City cannot exceed 100 characters'
        }),
      state: Joi.string()
        .min(2)
        .max(100)
        .optional()
        .messages({
          'string.min': 'State must be at least 2 characters long',
          'string.max': 'State cannot exceed 100 characters'
        }),
      country: Joi.string()
        .min(2)
        .max(100)
        .optional()
        .messages({
          'string.min': 'Country must be at least 2 characters long',
          'string.max': 'Country cannot exceed 100 characters'
        }),
      postalCode: Joi.string()
        .pattern(/^[A-Za-z0-9\s-]+$/)
        .min(3)
        .max(20)
        .optional()
        .messages({
          'string.pattern.base': 'Please provide a valid postal code',
          'string.min': 'Postal code must be at least 3 characters long',
          'string.max': 'Postal code cannot exceed 20 characters'
        })
    }).optional(),
    amenities: Joi.array()
      .items(Joi.string().valid('wifi', 'tv', 'kitchen', 'washer', 'dryer', 'ac', 'heating', 'workspace', 'pool', 'hot-tub', 'parking', 'gym', 'breakfast', 'smoke-alarm', 'carbon-monoxide-alarm', 'first-aid-kit', 'fire-extinguisher', 'essentials' ,'security'))
      .max(50)
      .optional()
      .messages({
        'array.max': 'Cannot exceed 50 amenities'
      }),
    // houseRules: Joi.array()
    //   .items(Joi.string().valid('no-smoking', 'no-pets', 'no-parties', 'no-loud-music', 'no-shoes', 'no-unregistered-guests'))
    //   .max(20)
    //   .optional()
    //   .messages({
    //     'array.max': 'Cannot exceed 20 house rules'
    //   }),

    houseRules: Joi.object({
  common: Joi.array()
    .items(Joi.string())
    .max(20)
    .optional()
    .messages({
      'array.max': 'Cannot exceed 20 common house rules'
    }),
  additional: Joi.object()
    .optional()
    .messages({
      'object.base': 'Additional house rules must be an object'
    })
}).optional()
.messages({
  'object.base': 'House rules must be an object'
}),
    features: Joi.array()
      .items(Joi.string().valid('ocean-view', 'mountain-view', 'city-view', 'garden', 'balcony', 'terrace', 'fireplace', 'elevator', 'wheelchair-accessible', 'pet-friendly', 'smoking-allowed', 'long-term-stays'))
      .max(20)
      .optional()
      .messages({
        'array.max': 'Cannot exceed 20 features'
      }),
    services: Joi.array()
      .items(Joi.string().valid('car-rental', 'airport-pickup', 'guided-tours', 'cooking-classes', 'yoga-classes', 'massage', 'cleaning', 'laundry', 'concierge', 'breakfast', 'dinner'))
      .max(20)
      .optional()
      .messages({
        'array.max': 'Cannot exceed 20 services'
      }),
    images: Joi.array()
      .items(Joi.object({
        url: Joi.string().uri().optional().allow(''),
        publicId: Joi.string().optional().allow(''),
        isPrimary: Joi.boolean().optional(),
        caption: Joi.string().optional().allow(''),
        width: Joi.number().optional(),
        height: Joi.number().optional(),
        format: Joi.string().optional().allow(''),
        size: Joi.number().optional()
      }))
      .max(20)
      .optional()
      .messages({
        'array.max': 'Cannot exceed 20 images'
      }),
    bookingSettings: Joi.object({
      instantBookable: Joi.boolean().optional(),
      minStay: Joi.number().min(1).max(365).optional(),
      maxStay: Joi.number().min(1).max(365).optional(),
      advanceBookingDays: Joi.number().min(0).max(365).optional(),
      
    }).optional(),
    cancellationPolicy: Joi.string()
      .valid('flexible', 'moderate', 'strict', 'super-strict')
      .optional()
      .messages({
        'any.only': 'Cancellation policy must be one of: flexible, moderate, strict, super-strict'
      }),
    checkInTime: Joi.string()
      .pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .optional()
      .messages({
        'string.pattern.base': 'Check-in time must be in HH:MM format'
      }),
    checkOutTime: Joi.string()
      .pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .optional()
      .messages({
        'string.pattern.base': 'Check-out time must be in HH:MM format'
      }),
    status: Joi.string()
      .valid('draft', 'published', 'suspended', 'deleted')
      .optional()
      .messages({
        'any.only': 'Status must be one of: draft, published, suspended, deleted'
      }),
    seo: Joi.object({
      metaTitle: Joi.string().max(60).optional(),
      metaDescription: Joi.string().max(160).optional(),
      slug: Joi.string().optional()
    }).optional(),
    isFeatured: Joi.boolean().optional(),
    isDraft: Joi.boolean().optional(),
    isSponsored: Joi.boolean().optional(),
    isTopRated: Joi.boolean().optional(),
    enable24HourBooking: Joi.boolean().optional(),
    hourlyBooking: Joi.object({
      enabled: Joi.boolean()
        .optional()
        .messages({
          'boolean.base': 'Hourly booking enabled must be a boolean'
        }),
      minStayDays: Joi.number()
        .min(1)
        .max(30)
        .optional()
        .messages({
          'number.min': 'Minimum stay days must be at least 1',
          'number.max': 'Minimum stay days cannot exceed 30'
        }),
      hourlyRates: Joi.object({
        sixHours: Joi.number()
          .min(0)
          .max(1)
          .optional()
          .messages({
            'number.min': '6-hour rate cannot be negative',
            'number.max': '6-hour rate cannot exceed 100%'
          }),
        twelveHours: Joi.number()
          .min(0)
          .max(1)
          .optional()
          .messages({
            'number.min': '12-hour rate cannot be negative',
            'number.max': '12-hour rate cannot exceed 100%'
          }),
        eighteenHours: Joi.number()
          .min(0)
          .max(1)
          .optional()
          .messages({
            'number.min': '18-hour rate cannot be negative',
            'number.max': '18-hour rate cannot exceed 100%'
          })
      }).optional()
    }).optional(),
    rating: Joi.object({
      average: Joi.number().min(0).max(5).optional(),
      cleanliness: Joi.number().min(0).max(5).optional(),
      accuracy: Joi.number().min(0).max(5).optional(),
      communication: Joi.number().min(0).max(5).optional(),
      location: Joi.number().min(0).max(5).optional(),
      value: Joi.number().min(0).max(5).optional(),
      checkIn: Joi.number().min(0).max(5).optional()
    }).optional(),
    reviewCount: Joi.number().min(0).optional(),
    availability: Joi.array()
      .items(Joi.object({
        date: Joi.date().required(),
        isAvailable: Joi.boolean().required(),
        price: Joi.number().min(0).optional()
      }))
      .optional(),
    safety: Joi.object({
      smokeDetector: Joi.boolean().optional(),
      carbonMonoxideDetector: Joi.boolean().optional(),
      fireExtinguisher: Joi.boolean().optional(),
      firstAidKit: Joi.boolean().optional(),
      emergencyContact: Joi.string().max(200).optional()
    }).optional(),
    accessibility: Joi.object({
      wheelchairAccessible: Joi.boolean().optional(),
      stepFreeAccess: Joi.boolean().optional(),
      wideDoorways: Joi.boolean().optional(),
      accessibleBathroom: Joi.boolean().optional(),
      accessibleParking: Joi.boolean().optional()
    }).optional()
  });

  const { error } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }))
    });
  }

  next();
};

// Search listings validation
const validateListingSearch = (req, res, next) => {
  const schema = Joi.object({
    location: Joi.string()
      .min(2)
      .max(200)
      .optional()
      .messages({
        'string.min': 'Location must be at least 2 characters long',
        'string.max': 'Location cannot exceed 200 characters'
      }),
    // FIXED: Removed .greater('now') - same-day check-in is allowed
    checkIn: Joi.date()
      .optional()
      .messages({
        'date.base': 'Check-in date must be a valid date'
      }),
    checkOut: Joi.date()
      .greater(Joi.ref('checkIn'))
      .optional()
      .messages({
        'date.greater': 'Check-out date must be after check-in date'
      }),
    guests: Joi.number()
      .min(1)
      .max(20)
      .optional()
      .messages({
        'number.min': 'Number of guests must be at least 1',
        'number.max': 'Number of guests cannot exceed 20'
      }),
    priceMin: Joi.number()
      .min(0)
      .max(10000)
      .optional()
      .messages({
        'number.min': 'Minimum price cannot be negative',
        'number.max': 'Minimum price cannot exceed $10,000'
      }),
    priceMax: Joi.number()
      .min(0)
      .max(10000)
      .optional()
      .messages({
        'number.min': 'Maximum price cannot be negative',
        'number.max': 'Maximum price cannot exceed $10,000'
      }),
    propertyType: Joi.array()
      .items(Joi.string().valid('apartment', 'house', 'villa', 'cabin', 'condo', 'loft', 'studio', 'chalet', 'castle', 'treehouse', 'boat', 'camper', 'yurt', 'tent', 'cave', 'island', 'lighthouse', 'windmill', 'other'))
      .optional()
      .messages({
        'any.only': 'Property type must be one of the valid options'
      }),
    amenities: Joi.array()
      .items(Joi.string())
      .optional(),
    instantBookable: Joi.boolean()
      .optional(),
    superhost: Joi.boolean()
      .optional(),
    page: Joi.number()
      .min(1)
      .default(1)
      .messages({
        'number.min': 'Page must be at least 1'
      }),
    limit: Joi.number()
      .min(1)
      .max(100)
      .default(20)
      .messages({
        'number.min': 'Limit must be at least 1',
        'number.max': 'Limit cannot exceed 100'
      }),
    sortBy: Joi.string()
      .valid('price', 'rating', 'distance', 'relevance')
      .default('relevance')
      .messages({
        'any.only': 'Sort by must be one of: price, rating, distance, relevance'
      }),
    sortOrder: Joi.string()
      .valid('asc', 'desc')
      .default('asc')
      .messages({
        'any.only': 'Sort order must be either asc or desc'
      })
  });

  const { error } = schema.validate(req.query);
  if (error) {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }))
    });
  }

  next();
};

module.exports = {
  validateListing,
  validateListingUpdate,
  validateListingSearch
};
