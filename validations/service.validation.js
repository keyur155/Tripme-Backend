const Joi = require('joi');

const validateService = (req, res, next) => {
  const schema = Joi.object({
    title: Joi.string().min(3).max(100).required(),
    description: Joi.string().min(10).max(500).required(),
    serviceType: Joi.string()
      .valid('tour-guide', 'transport', 'fitness', 'chef', 'photographer', 'hairdresser', 'yoga-teacher', 'transportation', 'cleaning', 'music', 'art', 'other')
      .required(),
    duration: Joi.object({
      value: Joi.number().positive().optional(),
      minDuration: Joi.number().positive().optional(),
      maxDuration: Joi.number().positive().optional(),
      unit: Joi.string().valid('minutes', 'hours', 'days').required()
    }).required(),
    location: Joi.object({
      type: Joi.string().valid('Point').required(),
      coordinates: Joi.array().items(Joi.number()).length(2).required(),
      address: Joi.string().optional(),
      userAddress: Joi.string().optional(),
      city: Joi.string().optional(),
      state: Joi.string().optional(),
      country: Joi.string().optional(),
      pincode: Joi.string().optional()
    }).required(),
    groupSize: Joi.object({
      min: Joi.number().min(1).optional(),
      max: Joi.number().min(1).required()
    }).optional(),
    pricing: Joi.object({
      basePrice: Joi.number().positive().required(),
      perPersonPrice: Joi.number().min(0).optional(),
      minPrice: Joi.number().min(0).optional(),
      maxPrice: Joi.number().min(0).optional(),
      currency: Joi.string().default('INR')
    }).required(),
    cancellationPolicy: Joi.string()
      .valid('flexible', 'moderate', 'strict', 'non-refundable')
      .optional(),
    requirements: Joi.array().items(Joi.string()).optional(),
    media: Joi.array().items(
      Joi.object({
        url: Joi.string().uri().required(),
        type: Joi.string().valid('image', 'video').required(),
        caption: Joi.string().max(200).optional().allow('')
      })
    ).optional(),
    status: Joi.string()
      .valid('draft', 'published', 'suspended', 'deleted')
      .optional()
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

const validateServiceUpdate = (req, res, next) => {
  const schema = Joi.object({
    title: Joi.string().min(3).max(100).optional(),
    description: Joi.string().min(10).max(500).optional(),
    serviceType: Joi.string()
      .valid('tour-guide', 'transport', 'fitness', 'chef', 'photographer', 'hairdresser', 'yoga-teacher', 'transportation', 'cleaning', 'music', 'art', 'other')
      .optional(),
    duration: Joi.object({
      value: Joi.number().positive().optional(),
      minDuration: Joi.number().positive().optional(),
      maxDuration: Joi.number().positive().optional(),
      unit: Joi.string().valid('minutes', 'hours', 'days').optional()
    }).optional(),
    location: Joi.object({
      type: Joi.string().valid('Point').optional(),
      coordinates: Joi.array().items(Joi.number()).length(2).optional(),
      address: Joi.string().optional(),
      userAddress: Joi.string().optional(),
      city: Joi.string().optional(),
      state: Joi.string().optional(),
      country: Joi.string().optional(),
      pincode: Joi.string().optional()
    }).optional(),
    groupSize: Joi.object({
      min: Joi.number().min(1).optional(),
      max: Joi.number().min(1).optional()
    }).optional(),
    pricing: Joi.object({
      basePrice: Joi.number().positive().optional(),
      perPersonPrice: Joi.number().min(0).optional(),
      minPrice: Joi.number().min(0).optional(),
      maxPrice: Joi.number().min(0).optional(),
      currency: Joi.string().optional()
    }).optional(),
    cancellationPolicy: Joi.string()
      .valid('flexible', 'moderate', 'strict', 'non-refundable')
      .optional(),
    requirements: Joi.array().items(Joi.string()).optional(),
    media: Joi.array().items(
      Joi.object({
        url: Joi.string().uri().optional(),
        type: Joi.string().valid('image', 'video').optional(),
        caption: Joi.string().max(200).optional().allow('')
      })
    ).optional(),
    status: Joi.string()
      .valid('draft', 'published', 'suspended', 'deleted')
      .optional()
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

module.exports = {
  validateService,
  validateServiceUpdate
}; 