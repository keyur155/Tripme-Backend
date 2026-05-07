const Coupon = require('../models/Coupon');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Booking = require('../models/Booking');

// @desc    Create coupon (admin only)
// @route   POST /api/coupons
// @access  Private (Admin only)
const createCoupon = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can create coupons'
      });
    }

    const {
      code,
      couponImage,
      discountType,
      amount,
      maxDiscount,
      minBookingAmount,
      validFrom,
      validTo,
      usageLimit,
      applicableToListings,
      applicableToServices
    } = req.body;

    // Check if coupon code already exists
    const existingCoupon = await Coupon.findOne({ code: code.toUpperCase() });
    if (existingCoupon) {
      return res.status(400).json({
        success: false,
        message: 'Coupon code already exists'
      });
    }

    const coupon = await Coupon.create({
      code: code.toUpperCase(),
      couponImage,
      discountType,
      amount,
      maxDiscount,
      minBookingAmount,
      validFrom,
      validTo,
      usageLimit,
      applicableToListings,
      applicableToServices,
      createdBy: req.user.id
    });

    res.status(201).json({
      success: true,
      message: 'Coupon created successfully',
      data: { coupon }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating coupon',
      error: error.message
    });
  }
};

// @desc    Get all coupons (admin only)
// @route   GET /api/coupons
// @access  Private (Admin only)
const getCoupons = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can view all coupons'
      });
    }

    const { page = 1, limit = 10, isActive, search } = req.query;

    const query = {};
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    if (search) {
      query.code = { $regex: search, $options: 'i' };
    }

    const coupons = await Coupon.find(query)
      .populate('createdBy', 'name')
      .populate('applicableToListings', 'title')
      .populate('applicableToServices', 'title')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Coupon.countDocuments(query);

    res.status(200).json({
      success: true,
      data: {
        coupons,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalItems: total,
          itemsPerPage: limit
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching coupons',
      error: error.message
    });
  }
};

// @desc    Get coupon by ID
// @route   GET /api/coupons/:id
// @access  Private (Admin only)
const getCoupon = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can view coupon details'
      });
    }

    const { id } = req.params;

    const coupon = await Coupon.findById(id)
      .populate('createdBy', 'name')
      .populate('applicableToListings', 'title')
      .populate('applicableToServices', 'title')
      .populate('usedBy.user', 'name email');

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Coupon not found'
      });
    }

    res.status(200).json({
      success: true,
      data: { coupon }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching coupon',
      error: error.message
    });
  }
};

// @desc    Update coupon (admin only)
// @route   PUT /api/coupons/:id
// @access  Private (Admin only)
const updateCoupon = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can update coupons'
      });
    }

    const { id } = req.params;
    const updateData = req.body;

    // If code is being updated, check for uniqueness
    if (updateData.code) {
      const existingCoupon = await Coupon.findOne({
        code: updateData.code.toUpperCase(),
        _id: { $ne: id }
      });
      if (existingCoupon) {
        return res.status(400).json({
          success: false,
          message: 'Coupon code already exists'
        });
      }
      updateData.code = updateData.code.toUpperCase();
    }

    const coupon = await Coupon.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    ).populate('createdBy', 'name');

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Coupon not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Coupon updated successfully',
      data: { coupon }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating coupon',
      error: error.message
    });
  }
};

// @desc    Delete coupon (admin only)
// @route   DELETE /api/coupons/:id
// @access  Private (Admin only)
const deleteCoupon = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can delete coupons'
      });
    }

    const { id } = req.params;

    const coupon = await Coupon.findByIdAndDelete(id);

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Coupon not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Coupon deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting coupon',
      error: error.message
    });
  }
};

// @desc    Validate coupon
// @route   POST /api/coupons/validate
// @access  Public
const validateCoupon = async (req, res) => {
  try {
    const { couponCode, bookingAmount, listingId, serviceId, userId } = req.body;
    console.log('req body', req.body);
    const coupon = await Coupon.findOne({
      code: couponCode.toUpperCase(),
      isActive: true,
      validFrom: { $lte: new Date() },
      validTo: { $gte: new Date() }
    });
    console.log('coupon', coupon);
    if (!coupon) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired coupon code'
      });
    }

    // Check usage limit
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
      return res.status(400).json({
        success: false,
        message: 'Coupon usage limit reached'
      });
    }

    // Check if user has already used this coupon
    if (userId) {
      const hasUsed = coupon.usedBy.some(usage => usage.user.toString() === userId);
      if (hasUsed) {
        return res.status(400).json({
          success: false,
          message: 'You have already used this coupon'
        });
      }
    }

    // Check minimum booking amount
    if (coupon.minBookingAmount && bookingAmount < coupon.minBookingAmount) {
      return res.status(400).json({
        success: false,
        message: `Minimum booking amount of ${coupon.minBookingAmount} required`
      });
    }

    // Check if coupon is applicable to the listing/service
    if (listingId && coupon.applicableToListings.length > 0) {
      const isApplicable = coupon.applicableToListings.some(
        listing => listing.toString() === listingId
      );
      if (!isApplicable) {
        return res.status(400).json({
          success: false,
          message: 'Coupon is not applicable to this listing'
        });
      }
    }

    if (serviceId && coupon.applicableToServices.length > 0) {
      const isApplicable = coupon.applicableToServices.some(
        service => service.toString() === serviceId
      );
      if (!isApplicable) {
        return res.status(400).json({
          success: false,
          message: 'Coupon is not applicable to this service'
        });
      }
    }

    // Calculate discount
    let discountAmount = 0;
    if (coupon.discountType === 'percentage') {
      discountAmount = (bookingAmount * coupon.amount) / 100;
      if (coupon.maxDiscount) {
        discountAmount = Math.min(discountAmount, coupon.maxDiscount);
      }
    } else {
      discountAmount = coupon.amount;
    }

    const finalAmount = bookingAmount - discountAmount;

    res.status(200).json({
      success: true,
      message: 'Coupon is valid',
      data: {
        coupon: {
          code: coupon.couponCode,
          discountType: coupon.discountType,
          amount: coupon.amount,
          maxDiscount: coupon.maxDiscount
        },
        discountAmount,
        finalAmount,
        originalAmount: bookingAmount
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error validating coupon',
      error: error.message
    });
  }
};

// @desc    Get coupon usage statistics
// @route   GET /api/coupons/:id/stats
// @access  Private (Admin only)
const getCouponStats = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can view coupon statistics'
      });
    }

    const { id } = req.params;

    const coupon = await Coupon.findById(id);
    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Coupon not found'
      });
    }

    // Get bookings that used this coupon
    const bookingsWithCoupon = await Booking.find({ couponApplied: id })
      .populate('user', 'name email')
      .populate('listing', 'title')
      .populate('service', 'title')
      .sort({ createdAt: -1 });

    const totalDiscountGiven = bookingsWithCoupon.reduce(
      (sum, booking) => sum + (booking.discountAmount || 0),
      0
    );

    const usageByMonth = await Booking.aggregate([
      { $match: { couponApplied: id } },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          },
          count: { $sum: 1 },
          totalDiscount: { $sum: '$discountAmount' }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: 12 }
    ]);

    const stats = {
      totalUsage: coupon.usedCount,
      totalDiscountGiven,
      usageLimit: coupon.usageLimit,
      remainingUsage: coupon.usageLimit ? coupon.usageLimit - coupon.usedCount : null,
      usageByMonth,
      recentBookings: bookingsWithCoupon.slice(0, 10)
    };

    res.status(200).json({
      success: true,
      data: { stats }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching coupon statistics',
      error: error.message
    });
  }
};

// @desc    Get user's coupon usage history
// @route   GET /api/coupons/my-usage
// @access  Private
const getMyCouponUsage = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    const bookings = await Booking.find({
      user: req.user.id,
      couponApplied: { $exists: true, $ne: null }
    })
      .populate('couponApplied', 'code discountType amount')
      .populate('listing', 'title images')
      .populate('service', 'title media')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Booking.countDocuments({
      user: req.user.id,
      couponApplied: { $exists: true, $ne: null }
    });

    res.status(200).json({
      success: true,
      data: {
        bookings,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalItems: total,
          itemsPerPage: limit
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching coupon usage history',
      error: error.message
    });
  }
};

// @desc    Get available coupons for user
// @route   GET /api/coupons/available
// @access  Private
const getAvailableCoupons = async (req, res) => {
  try {
    const { listingId, serviceId, bookingAmount } = req.query;

    const query = {
      isActive: true,
      validFrom: { $lte: new Date() },
      validTo: { $gte: new Date() }
    };

    // Filter by applicable listings/services
    if (listingId) {
      query.$or = [
        { applicableToListings: { $size: 0 } }, // No restrictions
        { applicableToListings: listingId }
      ];
    }

    if (serviceId) {
      query.$or = [
        { applicableToServices: { $size: 0 } }, // No restrictions
        { applicableToServices: serviceId }
      ];
    }

    // Filter by minimum booking amount
    if (bookingAmount) {
      query.$or = [
        { minBookingAmount: { $exists: false } },
        { minBookingAmount: { $lte: Number(bookingAmount) } }
      ];
    }

    const coupons = await Coupon.find(query)
      .populate('applicableToListings', 'title')
      .populate('applicableToServices', 'title')
      .sort({ amount: -1 });

    // Filter out coupons that user has already used
    const availableCoupons = coupons.filter(coupon => {
      const hasUsed = coupon.usedBy.some(usage => usage.user.toString() === req.user.id);
      return !hasUsed;
    });

    res.status(200).json({
      success: true,
      data: { coupons: availableCoupons }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching available coupons',
      error: error.message
    });
  }
};

// @desc    Get public active coupons (no authentication required)
// @route   GET /api/coupons/public
// @access  Public
const getPublicActiveCoupons = async (req, res) => {
  try {
    const { limit = 6, isActive = true } = req.query;

    // More lenient query - remove strict date filtering for now
    const query = {
      isActive: isActive === 'true'
      // Temporarily remove date filtering to see all active coupons
      // validFrom: { $lte: new Date() },
      // validTo: { $gte: new Date() }
    };

    const coupons = await Coupon.find(query)
      .select('code couponImage discountType amount maxDiscount minBookingAmount validFrom validTo usageLimit usedCount')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    res.status(200).json({
      success: true,
      data: { coupons }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching public coupons',
      error: error.message
    });
  }
};

module.exports = {
  createCoupon,
  getCoupons,
  getCoupon,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
  getCouponStats,
  getMyCouponUsage,
  getAvailableCoupons,
  getPublicActiveCoupons
};

// --- STUBS FOR UNIMPLEMENTED ROUTE HANDLERS ---
const notImplemented = (name) => (req, res) => res.status(501).json({ success: false, message: `${name} not implemented yet` });

const stubMethods = [
  'getAllCoupons',
  'getMyCoupons',
  'getCouponById',
  'useCoupon',
  'getCouponUsage',
  'getCouponUsageHistory',
  'getPopularCoupons',
  'getCouponEffectiveness',
  'getAllCouponsAdmin',
  'getExpiredCoupons',
  'getActiveCoupons',
  'updateCouponStatus',
  'bulkCreateCoupons'
];
stubMethods.forEach((name) => {
  if (typeof module.exports[name] === 'undefined') {
    module.exports[name] = notImplemented(name);
  }
}); 