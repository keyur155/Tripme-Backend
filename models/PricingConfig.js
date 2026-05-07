const mongoose = require('mongoose');
const { logger } = require('../config/logger');

const pricingConfigSchema = new mongoose.Schema({
  // Platform fee configuration
  platformFeeRate: {
    type: Number,
    required: true,
    min: 0,
    max: 1, // 0-100% (0.15 = 15%)
    default: 0.03
  },
  // GST applied on subtotal (0-1)
  gstRate: {
    type: Number,
    min: 0,
    max: 1,
    default: 0.18
  },
  // Card/UPI processing fee (percentage, 0-1)
  processingFeeRate: {
    type: Number,
    min: 0,
    max: 1,
    default: 0.029
  },
  // Fixed processing fee (in rupees)
  processingFeeFixed: {
    type: Number,
    min: 0,
    default: 30
  },
  
  // Configuration metadata
  isActive: {
    type: Boolean,
    default: true
  },
  
  // Effective date range
  effectiveFrom: {
    type: Date,
    default: Date.now
  },
  
  effectiveTo: {
    type: Date,
    default: null // null means no end date
  },
  
  // Admin tracking
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // Change reason/notes
  changeReason: {
    type: String,
    maxlength: 500
  },
  
  // Version control
  version: {
    type: Number,
    default: 1
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
pricingConfigSchema.index({ isActive: 1, effectiveFrom: 1, effectiveTo: 1 });
pricingConfigSchema.index({ createdAt: -1 });

// Static method to get current active platform fee rate
pricingConfigSchema.statics.getCurrentPlatformFeeRate = async function() {
  const now = new Date();
  
  const activeConfig = await this.findOne({
    isActive: true,
    effectiveFrom: { $lte: now },
    $or: [
      { effectiveTo: null },
      { effectiveTo: { $gte: now } }
    ]
  }).sort({ effectiveFrom: -1 });
  
  if (!activeConfig) {
    // Fallback to default rate if no active config found
    logger.warn('No active pricing config found, using schema default platform fee rate: 3%');
    return 0.03;
  }
  
  return activeConfig.platformFeeRate;
};

// Get full current pricing config (platform, gst, processing)
pricingConfigSchema.statics.getCurrentPricingConfig = async function() {
  const now = new Date();
  const activeConfig = await this.findOne({
    isActive: true,
    effectiveFrom: { $lte: now },
    $or: [
      { effectiveTo: null },
      { effectiveTo: { $gte: now } }
    ]
  }).sort({ effectiveFrom: -1 });

  if (!activeConfig) {
    return {
      platformFeeRate: 0.03,
      gstRate: 0.18,
      processingFeeRate: 0.029,
      processingFeeFixed: 30
    };
  }

  return {
    platformFeeRate: activeConfig.platformFeeRate,
    gstRate: activeConfig.gstRate ?? 0.18,
    processingFeeRate: activeConfig.processingFeeRate ?? 0.029,
    processingFeeFixed: activeConfig.processingFeeFixed ?? 30
  };
};

// Static method to create new platform fee configuration
pricingConfigSchema.statics.updatePlatformFeeRate = async function(
  newRate,
  adminUserId,
  changeReason = '',
  options = {}
) {
  // Preserve existing ancillary rates if not provided
  const current = await this.getCurrentPricingConfig();
  const nextConfig = {
    platformFeeRate: newRate,
    gstRate: options.gstRate !== undefined ? options.gstRate : current.gstRate,
    processingFeeRate: options.processingFeeRate !== undefined ? options.processingFeeRate : current.processingFeeRate,
    processingFeeFixed: options.processingFeeFixed !== undefined ? options.processingFeeFixed : current.processingFeeFixed
  };

  // Deactivate current active configs
  await this.updateMany(
    { isActive: true },
    { 
      isActive: false,
      effectiveTo: new Date(),
      updatedBy: adminUserId
    }
  );
  
  // Create new active config
  const newConfig = new this({
    ...nextConfig,
    isActive: true,
    effectiveFrom: new Date(),
    effectiveTo: null,
    createdBy: adminUserId,
    changeReason: changeReason,
    version: await this.countDocuments() + 1
  });
  
  await newConfig.save();
  
  logger.info(`Platform fee rate updated to ${(newRate * 100).toFixed(1)}%`, { adminUserId });
  
  return newConfig;
};

// Static method to get pricing history
pricingConfigSchema.statics.getPricingHistory = async function(limit = 10) {
  return await this.find()
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email')
    .sort({ createdAt: -1 })
    .limit(limit);
};

module.exports = mongoose.model('PricingConfig', pricingConfigSchema);
