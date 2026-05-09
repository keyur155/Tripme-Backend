const mongoose = require('mongoose');
const PricingConfig = require('../models/PricingConfig');
const User = require('../models/User');
const Property = require('../models/Property');
const Booking = require('../models/Booking');
const Payment = require('../models/Payment');
const Review = require('../models/Review');
const PaymentAuditLog = require('../models/PaymentAuditLog');
const Admin = require('../models/Admin');
const Session = require('../models/Session');
const KycVerification = require('../models/KycVerification');
const jwt = require('jsonwebtoken');
const razorpayService = require('../services/razorpay.service');

// Dashboard Stats
const getDashboardStats = async (req, res) => {
  try {
    // Get user stats
    const totalUsers = await User.countDocuments();
    const newUsersThisMonth = await User.countDocuments({
      createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
    });
    const totalHosts = await User.countDocuments({ role: 'host' });
    const pendingKYC = await User.countDocuments({
      role: 'host',
      'kyc.status': { $in: ['pending', 'submitted'] }
    });

    // Get property stats
    const totalProperties = await Property.countDocuments();
    const activeProperties = await Property.countDocuments({ status: 'active' });
    const pendingProperties = await Property.countDocuments({ status: 'pending' });

    // Get booking stats
    const totalBookings = await Booking.countDocuments();
    const completedBookings = await Booking.countDocuments({ status: 'completed' });
    const pendingBookings = await Booking.countDocuments({ status: 'pending' });

    // Get revenue stats
    const totalRevenue = await Payment.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const monthlyRevenue = await Payment.aggregate([
      {
        $match: {
          status: 'completed',
          createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.status(200).json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          newThisMonth: newUsersThisMonth,
          pendingKYC,
          totalHosts
        },
        properties: {
          total: totalProperties,
          active: activeProperties,
          pending: pendingProperties
        },
        bookings: {
          total: totalBookings,
          completed: completedBookings,
          pending: pendingBookings
        },
        revenue: {
          total: totalRevenue[0]?.total || 0,
          thisMonth: monthlyRevenue[0]?.total || 0
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching dashboard stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard stats',
      error: error.message
    });
  }
};

// Platform Fee Management
const getCurrentPlatformFeeRate = async (req, res) => {
  try {
    const currentConfig = await PricingConfig.getCurrentPricingConfig();

    res.status(200).json({
      success: true,
      data: {
        platformFeeRate: currentConfig.platformFeeRate,
        platformFeePercentage: (currentConfig.platformFeeRate * 100).toFixed(1),
        gstRate: currentConfig.gstRate,
        gstPercentage: (currentConfig.gstRate * 100).toFixed(1),
        processingFeeRate: currentConfig.processingFeeRate,
        processingFeePercentage: (currentConfig.processingFeeRate * 100).toFixed(2),
        processingFeeFixed: currentConfig.processingFeeFixed,
        lastUpdated: new Date()
      }
    });
  } catch (error) {
    console.error('❌ Error fetching platform fee rate:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch platform fee rate',
      error: error.message
    });
  }
};

const updatePlatformFeeRate = async (req, res) => {
  try {
    const { platformFeeRate, gstRate, processingFeeRate, processingFeeFixed, changeReason } = req.body;

    // Allow zero: only reject when missing or NaN
    if (platformFeeRate === undefined || platformFeeRate === null || Number.isNaN(platformFeeRate) || typeof platformFeeRate !== 'number') {
      return res.status(400).json({
        success: false,
        message: 'Platform fee rate is required and must be a number'
      });
    }

    if (platformFeeRate < 0 || platformFeeRate > 1) {
      return res.status(400).json({
        success: false,
        message: 'Platform fee rate must be between 0 and 1 (0-100%)'
      });
    }
    if (gstRate !== undefined && (gstRate < 0 || gstRate > 1)) {
      return res.status(400).json({ success: false, message: 'GST rate must be between 0 and 1 (0-100%)' });
    }
    if (processingFeeRate !== undefined && (processingFeeRate < 0 || processingFeeRate > 1)) {
      return res.status(400).json({ success: false, message: 'Processing fee rate must be between 0 and 1 (0-100%)' });
    }
    if (processingFeeFixed !== undefined && processingFeeFixed < 0) {
      return res.status(400).json({ success: false, message: 'Processing fee fixed must be >= 0' });
    }

    const currentConfig = await PricingConfig.getCurrentPricingConfig();

    if (Math.abs(currentConfig.platformFeeRate - platformFeeRate) < 0.001 &&
        (gstRate === undefined || Math.abs(currentConfig.gstRate - gstRate) < 0.001) &&
        (processingFeeRate === undefined || Math.abs(currentConfig.processingFeeRate - processingFeeRate) < 0.001) &&
        (processingFeeFixed === undefined || Math.abs(currentConfig.processingFeeFixed - processingFeeFixed) < 0.001)) {
      return res.status(400).json({
        success: false,
        message: 'New rates are the same as current rates'
      });
    }

    const newConfig = await PricingConfig.updatePlatformFeeRate(
      platformFeeRate,
      req.user._id,
      changeReason || 'Platform fee rate updated via admin panel',
      { gstRate, processingFeeRate, processingFeeFixed }
    );

    const adminName = req.user?.name || req.user?.email || 'Unknown Admin';
    console.log(`✅ Platform fee updated by admin ${adminName}: platform ${(platformFeeRate * 100).toFixed(1)}%, GST ${( (gstRate ?? currentConfig.gstRate) * 100).toFixed(1)}%, processing ${( (processingFeeRate ?? currentConfig.processingFeeRate) * 100).toFixed(2)}% + ₹${(processingFeeFixed ?? currentConfig.processingFeeFixed)}`);

    res.status(200).json({
      success: true,
      message: 'Platform fee configuration updated successfully',
      data: {
        previous: currentConfig,
        newConfig: {
          platformFeeRate: platformFeeRate,
          platformFeePercentage: (platformFeeRate * 100).toFixed(1),
          gstRate: gstRate ?? currentConfig.gstRate,
          gstPercentage: ((gstRate ?? currentConfig.gstRate) * 100).toFixed(1),
          processingFeeRate: processingFeeRate ?? currentConfig.processingFeeRate,
          processingFeePercentage: ((processingFeeRate ?? currentConfig.processingFeeRate) * 100).toFixed(2),
          processingFeeFixed: processingFeeFixed ?? currentConfig.processingFeeFixed,
        },
        changeReason: changeReason,
        updatedBy: adminName,
        updatedAt: newConfig.createdAt
      }
    });
  } catch (error) {
    console.error('❌ Error updating platform fee rate:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update platform fee rate',
      error: error.message
    });
  }
};

const getPlatformFeeHistory = async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const history = await PricingConfig.getPricingHistory(parseInt(limit));

    const formattedHistory = history.map(config => ({
      id: config._id,
      platformFeeRate: config.platformFeeRate,
      platformFeePercentage: (config.platformFeeRate * 100).toFixed(1),
      isActive: config.isActive,
      effectiveFrom: config.effectiveFrom,
      effectiveTo: config.effectiveTo,
      changeReason: config.changeReason,
      createdBy: config.createdBy?.name || 'Unknown',
      updatedBy: config.updatedBy?.name || null,
      createdAt: config.createdAt,
      version: config.version
    }));

    res.status(200).json({
      success: true,
      data: {
        history: formattedHistory,
        totalChanges: history.length
      }
    });
  } catch (error) {
    console.error('❌ Error fetching platform fee history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch platform fee history',
      error: error.message
    });
  }
};

// User Management Functions
const getUsers = async (req, res) => {
  try {
    console.log('🔍 getUsers called with query:', req.query);
    console.log('🔍 User model:', User);

    const { page = 1, limit = 20, role, status, search } = req.query;

    // Build filter
    const filter = {};
    if (role) filter.role = role;
    if (status) filter.accountStatus = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    console.log('🔍 Filter:', filter);

    // Get users with pagination
    const users = await User.find(filter)
      .select('-password')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    console.log('🔍 Users found:', users.length);

    const total = await User.countDocuments(filter);

    console.log('🔍 Total users:', total);

    res.status(200).json({
      success: true,
      data: {
        users,
        pagination: {
          current: parseInt(page),
          pages: Math.ceil(total / limit),
          total
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching users:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: error.message
    });
  }
};

const updateUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { accountStatus, reason } = req.body;

    if (!['active', 'suspended', 'banned', 'deactivated'].includes(accountStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid account status. Must be active, suspended, banned, or deactivated'
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const oldStatus = user.accountStatus;
    user.accountStatus = accountStatus;
    user.statusChangeReason = reason;
    user.statusChangedBy = req.user._id;
    user.statusChangedAt = new Date();

    await user.save();

    console.log(`✅ User ${user.email} status changed from ${oldStatus} to ${accountStatus} by admin ${req.user.email}`);

    res.status(200).json({
      success: true,
      message: 'User status updated successfully',
      data: {
        userId: user._id,
        email: user.email,
        oldStatus,
        newStatus: accountStatus,
        reason,
        changedBy: req.user.email,
        changedAt: user.statusChangedAt
      }
    });
  } catch (error) {
    console.error('❌ Error updating user status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user status',
      error: error.message
    });
  }
};

const getUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId).select('-password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Get additional user data
    const userBookings = await Booking.find({ user: userId }).countDocuments();
    const userProperties = await Property.find({ host: userId }).countDocuments();
    const userReviews = await Review.find({ reviewer: userId }).countDocuments();

    res.status(200).json({
      success: true,
      data: {
        user: {
          ...user.toObject(),
          stats: {
            bookings: userBookings,
            properties: userProperties,
            reviews: userReviews
          }
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user',
      error: error.message
    });
  }
};

const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, email, phone, role, isVerified } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update allowed fields
    if (name) user.name = name;
    if (email) user.email = email;
    if (phone) user.phone = phone;
    if (role) user.role = role;
    if (typeof isVerified === 'boolean') user.isVerified = isVerified;

    user.updatedBy = req.user._id;
    user.updatedAt = new Date();

    await user.save();

    console.log(`✅ User ${user.email} updated by admin ${req.user.email}`);

    res.status(200).json({
      success: true,
      message: 'User updated successfully',
      data: {
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          isVerified: user.isVerified,
          updatedAt: user.updatedAt
        }
      }
    });
  } catch (error) {
    console.error('❌ Error updating user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user',
      error: error.message
    });
  }
};

// Host Management Functions
const getHosts = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;

    // Build filter for hosts
    const filter = { role: 'host' };
    if (status) filter.accountStatus = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    // Get hosts with pagination
    const hosts = await User.find(filter)
      .select('-password')
      .populate('kyc', 'status submittedAt verifiedAt')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await User.countDocuments(filter);

    // Get additional host stats
    const hostsWithStats = await Promise.all(hosts.map(async (host) => {
      const propertiesCount = await Property.countDocuments({ host: host._id });
      const bookingsCount = await Booking.countDocuments({ host: host._id });
      const totalEarnings = await Payment.aggregate([
        { $match: { host: host._id, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$hostAmount' } } }
      ]);

      return {
        ...host.toObject(),
        stats: {
          properties: propertiesCount,
          bookings: bookingsCount,
          totalEarnings: totalEarnings[0]?.total || 0
        }
      };
    }));

    res.status(200).json({
      success: true,
      data: {
        hosts: hostsWithStats,
        pagination: {
          current: parseInt(page),
          pages: Math.ceil(total / limit),
          total
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching hosts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch hosts',
      error: error.message
    });
  }
};

const approveHost = async (req, res) => {
  try {
    const { hostId } = req.params;
    const { reason } = req.body;

    const host = await User.findById(hostId);
    if (!host) {
      return res.status(404).json({
        success: false,
        message: 'Host not found'
      });
    }

    if (host.role !== 'host') {
      return res.status(400).json({
        success: false,
        message: 'User is not a host'
      });
    }

    // Update host status
    host.accountStatus = 'active';
    host.isVerified = true;
    host.verificationStatus = 'approved';
    host.verificationReason = reason || 'Host approved by admin';
    host.verifiedBy = req.user._id;
    host.verifiedAt = new Date();

    await host.save();

    console.log(`✅ Host ${host.email} approved by admin ${req.user.email}`);

    res.status(200).json({
      success: true,
      message: 'Host approved successfully',
      data: {
        host: {
          _id: host._id,
          name: host.name,
          email: host.email,
          accountStatus: host.accountStatus,
          isVerified: host.isVerified,
          verificationStatus: host.verificationStatus,
          verifiedBy: req.user.email,
          verifiedAt: host.verifiedAt
        }
      }
    });
  } catch (error) {
    console.error('❌ Error approving host:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve host',
      error: error.message
    });
  }
};

const rejectHost = async (req, res) => {
  try {
    const { hostId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required'
      });
    }

    const host = await User.findById(hostId);
    if (!host) {
      return res.status(404).json({
        success: false,
        message: 'Host not found'
      });
    }

    if (host.role !== 'host') {
      return res.status(400).json({
        success: false,
        message: 'User is not a host'
      });
    }

    // Update host status
    host.accountStatus = 'suspended';
    host.isVerified = false;
    host.verificationStatus = 'rejected';
    host.verificationReason = reason;
    host.verifiedBy = req.user._id;
    host.verifiedAt = new Date();

    await host.save();

    console.log(`✅ Host ${host.email} rejected by admin ${req.user.email}. Reason: ${reason}`);

    res.status(200).json({
      success: true,
      message: 'Host rejected successfully',
      data: {
        host: {
          _id: host._id,
          name: host.name,
          email: host.email,
          accountStatus: host.accountStatus,
          isVerified: host.isVerified,
          verificationStatus: host.verificationStatus,
          verificationReason: reason,
          verifiedBy: req.user.email,
          verifiedAt: host.verifiedAt
        }
      }
    });
  } catch (error) {
    console.error('❌ Error rejecting host:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject host',
      error: error.message
    });
  }
};

// Property Management Functions
const getProperties = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search, hostId } = req.query;

    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (hostId) filter.host = hostId;
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { address: { $regex: search, $options: 'i' } }
      ];
    }

    // Get properties with pagination
    const properties = await Property.find(filter)
      .populate('host', 'name email phone')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Property.countDocuments(filter);

    // Get additional property stats
    const propertiesWithStats = await Promise.all(properties.map(async (property) => {
      const bookingsCount = await Booking.countDocuments({ property: property._id });
      const totalRevenue = await Payment.aggregate([
        { $match: { property: property._id, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      const averageRating = await Review.aggregate([
        { $match: { property: property._id } },
        { $group: { _id: null, average: { $avg: '$rating' } } }
      ]);

      return {
        ...property.toObject(),
        stats: {
          bookings: bookingsCount,
          totalRevenue: totalRevenue[0]?.total || 0,
          averageRating: averageRating[0]?.average || 0
        }
      };
    }));

    res.status(200).json({
      success: true,
      data: {
        properties: propertiesWithStats,
        pagination: {
          current: parseInt(page),
          pages: Math.ceil(total / limit),
          total
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching properties:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch properties',
      error: error.message
    });
  }
};

const approveListing = async (req, res) => {
  try {
    const { listingId } = req.params;
    const { reason } = req.body;

    const property = await Property.findById(listingId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    // Update property status
    property.status = 'published';
    property.approvalStatus = 'approved';
    property.approvalReason = reason || 'Property approved by admin';
    property.approvedBy = req.user._id;
    property.approvedAt = new Date();

    await property.save();

    console.log(`✅ Property ${property.title} approved by admin ${req.user.email}`);

    res.status(200).json({
      success: true,
      message: 'Property approved successfully',
      data: {
        property: {
          _id: property._id,
          title: property.title,
          status: property.status,
          approvalStatus: property.approvalStatus,
          approvedBy: req.user.email,
          approvedAt: property.approvedAt
        }
      }
    });
  } catch (error) {
    console.error('❌ Error approving property:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve property',
      error: error.message
    });
  }
};

const rejectListing = async (req, res) => {
  try {
    const { listingId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required'
      });
    }

    const property = await Property.findById(listingId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    // Update property status
    property.status = 'draft'; // Keep as draft but mark as rejected
    property.approvalStatus = 'rejected';
    property.rejectionReason = reason;
    property.approvedBy = req.user._id;
    property.approvedAt = new Date();

    await property.save();

    console.log(`✅ Property ${property.title} rejected by admin ${req.user.email}. Reason: ${reason}`);

    res.status(200).json({
      success: true,
      message: 'Property rejected successfully',
      data: {
        property: {
          _id: property._id,
          title: property.title,
          status: property.status,
          approvalStatus: property.approvalStatus,
          rejectionReason: reason,
          approvedBy: req.user.email,
          approvedAt: property.approvedAt
        }
      }
    });
  } catch (error) {
    console.error('❌ Error rejecting property:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject property',
      error: error.message
    });
  }
};

// Toggle Featured Status
const toggleFeatured = async (req, res) => {
  try {
    const { id } = req.params;

    const property = await Property.findById(id);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    property.isFeatured = !property.isFeatured;
    await property.save();

    console.log(`✅ Property ${property.title} featured status set to ${property.isFeatured} by admin ${req.user?.email}`);

    res.status(200).json({
      success: true,
      message: `Property ${property.isFeatured ? 'marked as featured' : 'removed from featured'}`,
      data: {
        _id: property._id,
        title: property.title,
        isFeatured: property.isFeatured
      }
    });
  } catch (error) {
    console.error('❌ Error toggling featured status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update featured status',
      error: error.message
    });
  }
};

// Toggle Sponsored Status
const toggleSponsored = async (req, res) => {
  try {
    const { id } = req.params;

    const property = await Property.findById(id);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    property.isSponsored = !property.isSponsored;
    await property.save();

    console.log(`✅ Property ${property.title} sponsored status set to ${property.isSponsored} by admin ${req.user?.email}`);

    res.status(200).json({
      success: true,
      message: `Property ${property.isSponsored ? 'marked as sponsored' : 'removed from sponsored'}`,
      data: {
        _id: property._id,
        title: property.title,
        isSponsored: property.isSponsored
      }
    });
  } catch (error) {
    console.error('❌ Error toggling sponsored status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update sponsored status',
      error: error.message
    });
  }
};

// Booking Management Functions
const getBookings = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search, hostId, userId } = req.query;

    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (hostId) filter.host = hostId;
    if (userId) filter.user = userId;
    if (search) {
      filter.$or = [
        { receiptId: { $regex: search, $options: 'i' } },
        { 'listing.title': { $regex: search, $options: 'i' } },
        { 'service.title': { $regex: search, $options: 'i' } }
      ];
    }

    // Get bookings with pagination
    const bookings = await Booking.find(filter)
      .populate('user', 'name email phone')
      .populate('host', 'name email phone')
      .populate('listing', 'title address images')
      .populate('service', 'title description images')
      .populate('payment', 'amount status paymentMethod')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Booking.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: {
        bookings,
        pagination: {
          current: parseInt(page),
          pages: Math.ceil(total / limit),
          total
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching bookings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings',
      error: error.message
    });
  }
};

// const refundBooking = async (req, res) => {
//   try {
//     const { bookingId } = req.params;
//     const { reason, refundAmount, refundType } = req.body;

//     if (!reason) {
//       return res.status(400).json({
//         success: false,
//         message: 'Refund reason is required'
//       });
//     }

//     const booking = await Booking.findById(bookingId)
//       .populate('payment')
//       .populate('user', 'name email')
//       .populate('host', 'name email');

//     if (!booking) {
//       return res.status(404).json({
//         success: false,
//         message: 'Booking not found'
//       });
//     }

//     // Allow refunding cancelled bookings, but block already refunded ones
//     if (booking.status === 'refunded') {
//       return res.status(400).json({
//         success: false,
//         message: 'Booking is already refunded'
//       });
//     }

//     // Calculate refund amount
//     const totalRefundAmount = refundAmount || booking.totalAmount;
//     const refundTypeValue = refundType || 'full';

//     // Update booking status (keep cancelled status if it was cancelled; otherwise mark refunded)
//     booking.status = booking.status === 'cancelled' ? 'cancelled' : 'refunded';
//     booking.refundReason = reason;
//     booking.refundAmount = totalRefundAmount;
//     booking.refundType = refundTypeValue;
//     booking.refundedBy = req.user._id;
//     booking.refundedAt = new Date();

//     // Update payment status if exists
//     if (booking.payment) {
//       booking.payment.status = 'refunded';
//       booking.payment.refundAmount = totalRefundAmount;
//       booking.payment.refundReason = reason;
//       booking.payment.refundedBy = req.user._id;
//       booking.payment.refundedAt = new Date();
//       await booking.payment.save();
//     }
//     // Also reflect paymentStatus field on booking
//     booking.paymentStatus = 'refunded';

//     await booking.save();

//     console.log(`✅ Booking ${booking.receiptId} refunded by admin ${req.user.email}. Amount: ${totalRefundAmount}, Reason: ${reason}`);

//     res.status(200).json({
//       success: true,
//       message: 'Booking refunded successfully',
//       data: {
//         booking: {
//           _id: booking._id,
//           receiptId: booking.receiptId,
//           status: booking.status,
//           refundAmount: totalRefundAmount,
//           refundType: refundTypeValue,
//           refundReason: reason,
//           refundedBy: req.user.email,
//           refundedAt: booking.refundedAt
//         }
//       }
//     });
//   } catch (error) {
//     console.error('❌ Error refunding booking:', error);
//     res.status(500).json({
//       success: false,
//       message: 'Failed to refund booking',
//       error: error.message
//     });
//   }
// };

// KYC Management Functions


const refundBooking = async (req, res) => {
  try {
    // 🔒 Admin guard
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin can process refunds'
      });
    }

    const { bookingId } = req.params;
    const { reason, refundAmount, refundType = 'full' } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Refund reason is required'
      });
    }

    const booking = await Booking.findById(bookingId)
      .populate('payment')
      .populate('user', 'name email');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // ❗ Only cancelled bookings can be refunded
    if (booking.status !== 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Only cancelled bookings can be refunded'
      });
    }

    // ❌ Already refunded
    if (booking.refundStatus === 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Booking already refunded'
      });
    }

    // ❌ Payment missing
    if (!booking.payment || !booking.payment.razorpayPaymentId) {
      return res.status(400).json({
        success: false,
        message: 'Razorpay payment not found for this booking'
      });
    }

    // 💰 Validate refund amount
    const finalRefundAmount =
      refundAmount !== undefined
        ? Number(refundAmount)
        : booking.totalAmount;

    if (
      !Number.isFinite(finalRefundAmount) ||
      finalRefundAmount <= 0 ||
      finalRefundAmount > booking.totalAmount
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid refund amount'
      });
    }

    // ============================
    // 🔁 RAZORPAY REFUND (SERVICE)
    // ============================
    const refund = await razorpayService.createRefund(
      booking.payment.razorpayPaymentId,
      finalRefundAmount,
      reason,
      {
        bookingId: booking._id.toString(),
        refundType,
        refundedBy: req.user.email
      }
    );

    // ============================
    // ✅ UPDATE PAYMENT
    // ============================
    booking.payment.status =
      finalRefundAmount === booking.totalAmount
        ? 'refunded'
        : 'partially_refunded';

    booking.payment.refundAmount = finalRefundAmount;
    booking.payment.refundReason = reason;
    booking.payment.razorpayRefundId = refund.refundId;
    booking.payment.refundedBy = req.user._id;
    booking.payment.refundedAt = new Date();

    await booking.payment.save();

    // ============================
    // ✅ UPDATE BOOKING
    // ============================
    booking.refundAmount = finalRefundAmount;
    booking.refundType = refundType;
    booking.refundReason = reason;
    booking.refundStatus = 'completed';
    booking.refundedBy = req.user._id;
    booking.refundedAt = new Date();
    booking.paymentStatus = booking.payment.status;

    await booking.save();

    console.log(
      `✅ Refund success | Booking ${booking._id} | Razorpay Refund ${refund.refundId}`
    );

    return res.status(200).json({
      success: true,
      message: 'Refund processed successfully',
      data: {
        bookingId: booking._id,
        refundAmount: finalRefundAmount,
        razorpayRefundId: refund.refundId,
        refundStatus: refund.status
      }
    });

  } catch (error) {
    console.error('❌ Admin refund failed:', error);

    return res.status(500).json({
      success: false,
      message: 'Refund failed',
      error: error.message
    });
  }
};



const getKYC = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;

    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { 'user.name': { $regex: search, $options: 'i' } },
        { 'user.email': { $regex: search, $options: 'i' } }
      ];
    }

    // Get KYC documents with pagination
    const kycDocuments = await KycVerification.find(filter)
      .populate('user', 'name email phone role kyc')
      .populate('verifiedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await KycVerification.countDocuments(filter);

    // Transform the data to match frontend expectations
    const transformedKycDocuments = kycDocuments.map(doc => ({
      _id: doc._id,
      id: doc._id,
      name: doc.user?.name || 'N/A',
      email: doc.user?.email || 'N/A',
      phone: doc.user?.phone || 'N/A',
      role: doc.user?.role || 'guest',
      kyc: {
        status: doc.status,
        documentType: doc.identityDocument?.type,
        documentNumber: doc.identityDocument?.number,
        documentImage: doc.identityDocument?.frontImage,
        rejectionReason: doc.rejectionReason
      },
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      verifiedBy: doc.verifiedBy?.name,
      verifiedAt: doc.verifiedAt
    }));

    res.status(200).json({
      success: true,
      data: {
        kyc: transformedKycDocuments,
        pagination: {
          current: parseInt(page),
          pages: Math.ceil(total / limit),
          total
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching KYC documents:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch KYC documents',
      error: error.message
    });
  }
};

const getKYCById = async (req, res) => {
  try {
    const { userId } = req.params;

    // First try to find by KYC document ID (if userId is actually a KYC document ID)
    let kycDocument = await KycVerification.findById(userId)
      .populate('user', 'name email phone role kyc')
      .populate('verifiedBy', 'name email');

    // If not found by ID, try to find by user ID
    if (!kycDocument) {
      kycDocument = await KycVerification.findOne({ user: userId })
        .populate('user', 'name email phone role kyc')
        .populate('verifiedBy', 'name email');
    }

    if (!kycDocument) {
      return res.status(404).json({
        success: false,
        message: 'KYC document not found for this user'
      });
    }

    // Transform the data to match modal expectations
    const transformedData = {
      user: {
        _id: kycDocument.user._id,
        name: kycDocument.user.name,
        email: kycDocument.user.email,
        phone: kycDocument.user.phone,
        kyc: kycDocument.user.kyc || {},
        createdAt: kycDocument.user.createdAt
      },
      kycVerification: {
        _id: kycDocument._id,
        identityDocument: kycDocument.identityDocument,
        addressProof: kycDocument.addressProof,
        selfie: kycDocument.selfie,
        status: kycDocument.status,
        rejectionReason: kycDocument.rejectionReason,
        verifiedBy: kycDocument.verifiedBy,
        verifiedAt: kycDocument.verifiedAt,
        createdAt: kycDocument.createdAt,
        updatedAt: kycDocument.updatedAt
      }
    };

    res.status(200).json({
      success: true,
      data: transformedData
    });
  } catch (error) {
    console.error('❌ Error fetching KYC document:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch KYC document',
      error: error.message
    });
  }
};

const verifyKYC = async (req, res) => {
  try {
    const { kycId } = req.params;
    const { reason } = req.body;

    const kycDocument = await KycVerification.findById(kycId)
      .populate('user', 'name email');

    if (!kycDocument) {
      return res.status(404).json({
        success: false,
        message: 'KYC document not found'
      });
    }

    if (kycDocument.status === 'verified') {
      return res.status(400).json({
        success: false,
        message: 'KYC document is already verified'
      });
    }

    // Update KYC status
    kycDocument.status = 'verified';
    kycDocument.verifiedBy = req.user._id;
    kycDocument.verifiedAt = new Date();
    kycDocument.rejectionReason = undefined; // Clear any previous rejection reason

    await kycDocument.save();

    // Update user verification status
    const user = await User.findById(kycDocument.user);
    if (user) {
      user.kyc.status = 'verified';
      await user.save();
    }

    console.log(`✅ KYC document for user ${user?.email} verified by admin ${req.user.email}`);

    res.status(200).json({
      success: true,
      message: 'KYC document verified successfully',
      data: {
        kyc: {
          _id: kycDocument._id,
          status: kycDocument.status,
          verifiedBy: req.user.email,
          verifiedAt: kycDocument.verifiedAt
        },
        user: {
          _id: user?._id,
          email: user?.email,
          isVerified: user?.isVerified
        }
      }
    });
  } catch (error) {
    console.error('❌ Error verifying KYC:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify KYC document',
      error: error.message
    });
  }
};

const rejectKYC = async (req, res) => {
  try {
    const { kycId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required'
      });
    }

    const kycDocument = await KycVerification.findById(kycId)
      .populate('user', 'name email');

    if (!kycDocument) {
      return res.status(404).json({
        success: false,
        message: 'KYC document not found'
      });
    }

    if (kycDocument.status === 'rejected') {
      return res.status(400).json({
        success: false,
        message: 'KYC document is already rejected'
      });
    }

    // Update KYC status
    kycDocument.status = 'rejected';
    kycDocument.rejectionReason = reason;
    kycDocument.verifiedBy = req.user._id;
    kycDocument.verifiedAt = new Date();

    await kycDocument.save();

    // Update user verification status
    const user = await User.findById(kycDocument.user);
    if (user) {
      user.isVerified = false;
      user.kyc = {
        status: 'rejected',
        rejectedAt: kycDocument.verifiedAt,
        rejectedBy: req.user._id,
        rejectionReason: reason
      };
      await user.save();
    }

    console.log(`✅ KYC document for user ${user?.email} rejected by admin ${req.user.email}. Reason: ${reason}`);

    res.status(200).json({
      success: true,
      message: 'KYC document rejected successfully',
      data: {
        kyc: {
          _id: kycDocument._id,
          status: kycDocument.status,
          rejectionReason: reason,
          verifiedBy: req.user.email,
          verifiedAt: kycDocument.verifiedAt
        },
        user: {
          _id: user?._id,
          email: user?.email,
          isVerified: user?.isVerified
        }
      }
    });
  } catch (error) {
    console.error('❌ Error rejecting KYC:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject KYC document',
      error: error.message
    });
  }
};

// Payment Management Functions
const getPayments = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search, hostId, userId } = req.query;

    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (hostId) filter.host = hostId;
    if (userId) filter.user = userId;
    if (search) {
      filter.$or = [
        { transactionId: { $regex: search, $options: 'i' } },
        { 'booking.receiptId': { $regex: search, $options: 'i' } }
      ];
    }

    // Get payments with pagination
    const payments = await Payment.find(filter)
      .populate('user', 'name email phone')
      .populate('host', 'name email phone')
      .populate('booking', 'receiptId status checkIn checkOut totalAmount listing service')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Payment.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: {
        payments,
        pagination: {
          current: parseInt(page),
          pages: Math.ceil(total / limit),
          total
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching payments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payments',
      error: error.message
    });
  }
};

const processPayout = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { payoutAmount, payoutMethod, notes } = req.body;

    const payment = await Payment.findById(paymentId)
      .populate('host', 'name email')
      .populate('booking', 'receiptId');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    if (payment.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Payment must be completed before processing payout'
      });
    }

    if (payment.payoutStatus === 'processed') {
      return res.status(400).json({
        success: false,
        message: 'Payout already processed for this payment'
      });
    }

    // Update payment payout status
    payment.payoutStatus = 'processed';
    payment.payoutAmount = payoutAmount || payment.hostAmount;
    payment.payoutMethod = payoutMethod || 'bank_transfer';
    payment.payoutNotes = notes;
    payment.payoutProcessedBy = req.user._id;
    payment.payoutProcessedAt = new Date();

    await payment.save();

    console.log(`✅ Payout processed for payment ${payment.transactionId} by admin ${req.user.email}`);

    res.status(200).json({
      success: true,
      message: 'Payout processed successfully',
      data: {
        payment: {
          _id: payment._id,
          transactionId: payment.transactionId,
          payoutStatus: payment.payoutStatus,
          payoutAmount: payment.payoutAmount,
          payoutMethod: payment.payoutMethod,
          payoutProcessedBy: req.user.email,
          payoutProcessedAt: payment.payoutProcessedAt
        }
      }
    });
  } catch (error) {
    console.error('❌ Error processing payout:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process payout',
      error: error.message
    });
  }
};

// Review Management Functions
const getReviews = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search, propertyId, userId } = req.query;

    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (propertyId) filter.property = propertyId;
    if (userId) filter.reviewer = userId;
    if (search) {
      filter.$or = [
        { comment: { $regex: search, $options: 'i' } },
        { 'reviewer.name': { $regex: search, $options: 'i' } }
      ];
    }

    // Get reviews with pagination (align fields to current Review schema)
    const reviews = await Review.find(filter)
      .populate('reviewer', 'name email')
      .populate('host', 'name email')
      .populate('property', 'title address')
      .populate('booking', 'receiptId')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Review.countDocuments(filter);

    // Map to lightweight shape expected by Admin UI
    const formatted = reviews.map((rev) => ({
      id: rev._id,
      reviewerName: rev.reviewer?.name || 'Unknown',
      reviewerEmail: rev.reviewer?.email || '',
      revieweeName: rev.host?.name || '',
      revieweeEmail: rev.host?.email || '',
      propertyTitle: rev.property?.title || 'N/A',
      rating: rev.rating?.overall || rev.rating || 0,
      content: rev.comment || '',
      status: rev.reports?.length ? 'flagged' : 'active',
      createdAt: rev.createdAt,
      flaggedReason: rev.reports?.[0]?.reason,
    }));

    res.status(200).json({
      success: true,
      data: {
        data: formatted,
        pagination: {
          current: parseInt(page),
          pages: Math.ceil(total / limit),
          total
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching reviews:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reviews',
      error: error.message
    });
  }
};

const flagReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { reason, action } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Flag reason is required'
      });
    }

    const review = await Review.findById(reviewId)
      .populate('reviewer', 'name email');

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    // Update review status
    review.status = action === 'hide' ? 'hidden' : 'flagged';
    review.flagReason = reason;
    review.flaggedBy = req.user._id;
    review.flaggedAt = new Date();

    await review.save();

    console.log(`✅ Review ${review._id} ${action}ed by admin ${req.user.email}. Reason: ${reason}`);

    res.status(200).json({
      success: true,
      message: `Review ${action}ed successfully`,
      data: {
        review: {
          _id: review._id,
          status: review.status,
          flagReason: reason,
          flaggedBy: req.user.email,
          flaggedAt: review.flaggedAt
        }
      }
    });
  } catch (error) {
    console.error('❌ Error flagging review:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to flag review',
      error: error.message
    });
  }
};

const deleteReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Deletion reason is required'
      });
    }

    const review = await Review.findById(reviewId)
      .populate('reviewer', 'name email');

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    // Soft delete - mark as deleted
    review.status = 'deleted';
    review.deletionReason = reason;
    review.deletedBy = req.user._id;
    review.deletedAt = new Date();

    await review.save();

    console.log(`✅ Review ${review._id} deleted by admin ${req.user.email}. Reason: ${reason}`);

    res.status(200).json({
      success: true,
      message: 'Review deleted successfully',
      data: {
        review: {
          _id: review._id,
          status: review.status,
          deletionReason: reason,
          deletedBy: req.user.email,
          deletedAt: review.deletedAt
        }
      }
    });
  } catch (error) {
    console.error('❌ Error deleting review:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete review',
      error: error.message
    });
  }
};

// Settings Management Functions
const getSettings = async (req, res) => {
  try {
    // Get current pricing config
    const feeConfig = await PricingConfig.getCurrentPricingConfig();

    // Get system settings (you can expand this based on your needs)
    const settings = {
      platformFeeRate: feeConfig.platformFeeRate,
      platformFeePercentage: (feeConfig.platformFeeRate * 100).toFixed(1),
      gstRate: feeConfig.gstRate,
      gstPercentage: (feeConfig.gstRate * 100).toFixed(1),
      processingFeeRate: feeConfig.processingFeeRate,
      processingFeePercentage: (feeConfig.processingFeeRate * 100).toFixed(2),
      processingFeeFixed: feeConfig.processingFeeFixed,
      maintenanceMode: false,
      registrationEnabled: true,
      hostRegistrationEnabled: true,
      maxFileSize: '10MB',
      supportedImageFormats: ['jpg', 'jpeg', 'png', 'webp'],
      maxImagesPerProperty: 20,
      currency: 'INR',
      timezone: 'Asia/Kolkata'
    };

    res.status(200).json({
      success: true,
      data: {
        settings
      }
    });
  } catch (error) {
    console.error('❌ Error fetching settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch settings',
      error: error.message
    });
  }
};

const updateSettings = async (req, res) => {
  try {
    const {
      platformFeeRate,
      gstRate,
      processingFeeRate,
      processingFeeFixed,
      maintenanceMode,
      registrationEnabled,
      hostRegistrationEnabled
    } = req.body;

    const updates = {};
    if (typeof maintenanceMode === 'boolean') updates.maintenanceMode = maintenanceMode;
    if (typeof registrationEnabled === 'boolean') updates.registrationEnabled = registrationEnabled;
    if (typeof hostRegistrationEnabled === 'boolean') updates.hostRegistrationEnabled = hostRegistrationEnabled;

    // Update platform/fee rates if provided (allow zero)
    const hasFeeUpdate = [platformFeeRate, gstRate, processingFeeRate, processingFeeFixed].some(v => v !== undefined && v !== null);
    if (hasFeeUpdate) {
      if (platformFeeRate !== undefined && (platformFeeRate < 0 || platformFeeRate > 1)) {
        return res.status(400).json({ success: false, message: 'Platform fee rate must be between 0 and 1 (0-100%)' });
      }
      if (gstRate !== undefined && (gstRate < 0 || gstRate > 1)) {
        return res.status(400).json({ success: false, message: 'GST rate must be between 0 and 1 (0-100%)' });
      }
      if (processingFeeRate !== undefined && (processingFeeRate < 0 || processingFeeRate > 1)) {
        return res.status(400).json({ success: false, message: 'Processing fee rate must be between 0 and 1 (0-100%)' });
      }
      if (processingFeeFixed !== undefined && processingFeeFixed < 0) {
        return res.status(400).json({ success: false, message: 'Processing fee fixed must be >= 0' });
      }

      await PricingConfig.updatePlatformFeeRate(
        platformFeeRate ?? (await PricingConfig.getCurrentPricingConfig()).platformFeeRate,
        req.user._id,
        'Platform fee rate updated via admin settings',
        { gstRate, processingFeeRate, processingFeeFixed }
      );
    }

    console.log(`✅ Settings updated by admin ${req.user.email}`);

    res.status(200).json({
      success: true,
      message: 'Settings updated successfully',
      data: {
        updatedBy: req.user.email,
        updatedAt: new Date(),
        updates
      }
    });
  } catch (error) {
    console.error('❌ Error updating settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update settings',
      error: error.message
    });
  }
};

// Analytics and Reports Functions
const getAnalytics = async (req, res) => {
  try {
    const { period = '30d' } = req.query;

    // Calculate date range
    const now = new Date();
    let startDate;
    switch (period) {
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      case '1y':
        startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }

    // Get analytics data
    const [
      totalUsers,
      newUsers,
      totalHosts,
      totalProperties,
      totalBookings,
      totalRevenue,
      averageBookingValue,
      topProperties,
      recentBookings
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: startDate } }),
      User.countDocuments({ role: 'host' }),
      Property.countDocuments(),
      Booking.countDocuments({ createdAt: { $gte: startDate } }),
      Payment.aggregate([
        { $match: { status: 'completed', createdAt: { $gte: startDate } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Payment.aggregate([
        { $match: { status: 'completed', createdAt: { $gte: startDate } } },
        { $group: { _id: null, average: { $avg: '$amount' } } }
      ]),
      Property.aggregate([
        { $match: { status: 'active' } },
        { $lookup: { from: 'bookings', localField: '_id', foreignField: 'property', as: 'bookings' } },
        { $addFields: { bookingCount: { $size: '$bookings' } } },
        { $sort: { bookingCount: -1 } },
        { $limit: 10 },
        { $project: { title: 1, address: 1, bookingCount: 1, price: 1 } }
      ]),
      Booking.find({ createdAt: { $gte: startDate } })
        .populate('user', 'name email')
        .populate('listing', 'title')
        .populate('service', 'title')
        .sort({ createdAt: -1 })
        .limit(10)
    ]);

    res.status(200).json({
      success: true,
      data: {
        period,
        summary: {
          totalUsers,
          newUsers,
          totalHosts,
          totalProperties,
          totalBookings,
          totalRevenue: totalRevenue[0]?.total || 0,
          averageBookingValue: averageBookingValue[0]?.average || 0
        },
        topProperties,
        recentBookings
      }
    });
  } catch (error) {
    console.error('❌ Error fetching analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch analytics',
      error: error.message
    });
  }
};

const getReports = async (req, res) => {
  try {
    const { type = 'summary', startDate, endDate } = req.query;

    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    let reportData = {};

    switch (type) {
      case 'summary':
        reportData = await generateSummaryReport(start, end);
        break;
      case 'revenue':
        reportData = await generateRevenueReport(start, end);
        break;
      case 'users':
        reportData = await generateUserReport(start, end);
        break;
      default:
        reportData = await generateSummaryReport(start, end);
    }

    res.status(200).json({
      success: true,
      data: {
        type,
        period: { start, end },
        report: reportData
      }
    });
  } catch (error) {
    console.error('❌ Error generating report:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate report',
      error: error.message
    });
  }
};

const getRecentActivities = async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    // Get recent activities from various collections
    const activities = [];

    // Recent users
    const recentUsers = await User.find()
      .select('name email role createdAt')
      .sort({ createdAt: -1 })
      .limit(10);

    recentUsers.forEach(user => {
      activities.push({
        type: 'user_registration',
        description: `New ${user.role} registered: ${user.name}`,
        timestamp: user.createdAt,
        user: user.name,
        email: user.email
      });
    });

    // Recent bookings
    const recentBookings = await Booking.find()
      .populate('user', 'name email')
      .populate('listing', 'title')
      .populate('service', 'title')
      .select('receiptId status totalAmount createdAt')
      .sort({ createdAt: -1 })
      .limit(10);

    recentBookings.forEach(booking => {
      activities.push({
        type: 'booking_created',
        description: `New booking: ${booking.receiptId}`,
        timestamp: booking.createdAt,
        user: booking.user?.name,
        amount: booking.totalAmount,
        status: booking.status
      });
    });

    // Recent properties
    const recentProperties = await Property.find()
      .populate('host', 'name email')
      .select('title status createdAt')
      .sort({ createdAt: -1 })
      .limit(10);

    recentProperties.forEach(property => {
      activities.push({
        type: 'property_created',
        description: `New property listed: ${property.title}`,
        timestamp: property.createdAt,
        host: property.host?.name,
        status: property.status
      });
    });

    // Sort all activities by timestamp and limit
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const limitedActivities = activities.slice(0, parseInt(limit));

    res.status(200).json({
      success: true,
      data: {
        activities: limitedActivities,
        total: activities.length
      }
    });
  } catch (error) {
    console.error('❌ Error fetching recent activities:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch recent activities',
      error: error.message
    });
  }
};

const getSystemHealth = async (req, res) => {
  try {
    // Check database connection
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';

    // Get memory usage
    const memoryUsage = process.memoryUsage();
    const memoryUsageMB = {
      rss: Math.round(memoryUsage.rss / 1024 / 1024),
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      external: Math.round(memoryUsage.external / 1024 / 1024)
    };

    // Get uptime
    const uptime = process.uptime();
    const uptimeFormatted = {
      seconds: Math.floor(uptime),
      minutes: Math.floor(uptime / 60),
      hours: Math.floor(uptime / 3600),
      days: Math.floor(uptime / 86400)
    };

    res.status(200).json({
      success: true,
      data: {
        status: 'healthy',
        database: dbStatus,
        uptime: uptimeFormatted,
        memory: memoryUsageMB,
        timestamp: new Date(),
        version: process.version,
        platform: process.platform
      }
    });
  } catch (error) {
    console.error('❌ Error checking system health:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check system health',
      error: error.message
    });
  }
};

// Helper functions for report generation
const generateSummaryReport = async (startDate, endDate) => {
  const [
    totalUsers,
    newUsers,
    totalHosts,
    totalProperties,
    totalBookings,
    totalRevenue,
    completedBookings,
    cancelledBookings
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ createdAt: { $gte: startDate, $lte: endDate } }),
    User.countDocuments({ role: 'host' }),
    Property.countDocuments(),
    Booking.countDocuments({ createdAt: { $gte: startDate, $lte: endDate } }),
    Payment.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: startDate, $lte: endDate } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]),
    Booking.countDocuments({ status: 'completed', createdAt: { $gte: startDate, $lte: endDate } }),
    Booking.countDocuments({ status: 'cancelled', createdAt: { $gte: startDate, $lte: endDate } })
  ]);

  return {
    period: { start: startDate, end: endDate },
    users: { total: totalUsers, new: newUsers, hosts: totalHosts },
    properties: { total: totalProperties },
    bookings: { total: totalBookings, completed: completedBookings, cancelled: cancelledBookings },
    revenue: { total: totalRevenue[0]?.total || 0 }
  };
};

const generateRevenueReport = async (startDate, endDate) => {
  const revenueData = await Payment.aggregate([
    { $match: { status: 'completed', createdAt: { $gte: startDate, $lte: endDate } } },
    {
      $group: {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day: { $dayOfMonth: '$createdAt' }
        },
        totalRevenue: { $sum: '$amount' },
        totalBookings: { $sum: 1 },
        averageBookingValue: { $avg: '$amount' }
      }
    },
    { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
  ]);

  return {
    period: { start: startDate, end: endDate },
    dailyRevenue: revenueData,
    totalRevenue: revenueData.reduce((sum, day) => sum + day.totalRevenue, 0),
    totalBookings: revenueData.reduce((sum, day) => sum + day.totalBookings, 0)
  };
};

const generateUserReport = async (startDate, endDate) => {
  const userData = await User.aggregate([
    { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
    {
      $group: {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day: { $dayOfMonth: '$createdAt' }
        },
        totalUsers: { $sum: 1 },
        hosts: { $sum: { $cond: [{ $eq: ['$role', 'host'] }, 1, 0] } },
        guests: { $sum: { $cond: [{ $eq: ['$role', 'guest'] }, 1, 0] } }
      }
    },
    { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
  ]);

  return {
    period: { start: startDate, end: endDate },
    dailyUsers: userData,
    totalUsers: userData.reduce((sum, day) => sum + day.totalUsers, 0),
    totalHosts: userData.reduce((sum, day) => sum + day.hosts, 0),
    totalGuests: userData.reduce((sum, day) => sum + day.guests, 0)
  };
};

// Payment Audit Dashboard
const getPaymentAuditDashboard = async (req, res) => {
  try {
    const { page = 1, limit = 50, severity, action } = req.query;

    // Build filter
    const filter = {};
    if (severity) filter['audit.severity'] = severity;
    if (action) filter['audit.action'] = action;

    // Get audit logs
    const auditLogs = await PaymentAuditLog.find(filter)
      .populate('user', 'name email')
      .populate('host', 'name email')
      .populate('payment', 'amount status')
      .populate('booking', 'receiptId status')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Get summary stats
    const totalLogs = await PaymentAuditLog.countDocuments(filter);
    const validationFailures = await PaymentAuditLog.countDocuments({ 'validation.isValid': false });
    const criticalIssues = await PaymentAuditLog.countDocuments({ 'audit.severity': 'critical' });
    const highIssues = await PaymentAuditLog.countDocuments({ 'audit.severity': 'high' });

    res.json({
      success: true,
      data: {
        logs: auditLogs,
        pagination: {
          current: parseInt(page),
          pages: Math.ceil(totalLogs / limit),
          total: totalLogs
        },
        summary: {
          totalLogs,
          validationFailures,
          criticalIssues,
          highIssues
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment audit dashboard',
      error: error.message
    });
  }
};

// Get validation failures
const getValidationFailures = async (req, res) => {
  try {
    const failures = await PaymentAuditLog.getValidationFailures(100);

    res.json({
      success: true,
      data: failures
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch validation failures',
      error: error.message
    });
  }
};

// Get payment audit details
const getPaymentAuditDetails = async (req, res) => {
  try {
    const { paymentId } = req.params;

    const auditLogs = await PaymentAuditLog.getPaymentAuditLogs(paymentId);

    res.json({
      success: true,
      data: auditLogs
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment audit details',
      error: error.message
    });
  }
};

// @desc    Register admin
// @route   POST /api/admin/signup
// @access  Public
const adminSignup = async (req, res) => {
  try {
    const { name, email, phone, password, confirmPassword, secretKey } = req.body;
    // Validate secret key
    if (secretKey !== process.env.ADMIN_SIGNUP_SECRET_KEY) {
      return res.status(401).json({
        success: false,
        message: 'Invalid secret key'
      });
    }

    // Check if admin already exists
    const adminExists = await Admin.findOne({ email });
    if (adminExists) {
      return res.status(400).json({
        success: false,
        message: 'Admin already exists with this email'
      });
    }

    // Create admin
    const admin = await Admin.create({
      name,
      email,
      phone,
      password,
      role: 'admin'
    });

    // Generate JWT token
    const token = jwt.sign(
      {
        id: admin._id,
        email: admin.email,
        role: 'admin',
        name: admin.name
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Create session
    await Session.create({
      user: admin._id,
      token,
      userAgent: req.headers['user-agent'] || 'unknown',
      ipAddress: req.ip || req.connection?.remoteAddress || 'unknown',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
    });

    // Remove password from response
    const adminData = {
      _id: admin._id,
      name: admin.name,
      email: admin.email,
      phone: admin.phone,
      role: admin.role,
      isActive: admin.isActive,
      createdAt: admin.createdAt
    };

    console.log(`✅ Admin signup successful: ${admin.email}`);

    res.status(201).json({
      success: true,
      message: 'Admin account created successfully',
      data: {
        admin: adminData,
        token
      }
    });

  } catch (error) {
    console.error('Admin signup error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating admin account',
      error: error.message
    });
  }
};

// Badge Management - Available badge types for reference (icons handled by frontend)
const AVAILABLE_BADGES = {
  highlight: [
    { type: "guest_favorite", label: "Guest favourite" },
    { type: "top_5_percent", label: "Top 5% of homes" },
    { type: "super_host", label: "Superhost" },
    { type: "rare_find", label: "Rare find" },
    { type: "new_listing", label: "New" },
    { type: "new_host", label: "New host" }
  ],
  details: [
    { type: "checkin", label: "Exceptional check-in" },
    { type: "cleanliness", label: "Sparkling clean" },
    { type: "location", label: "Great location" },
    { type: "value", label: "Great value" },
    { type: "host_exp", label: "Experienced host" }
  ],
  insights: [
    { type: "price_low", label: "Price is lower than average" },
    { type: "high_demand", label: "In high demand" },
    { type: "trending", label: "Trending" }
  ],
  urgency: [
    { type: "only_one_left", label: "Only 1 left" },
    { type: "limited_slots", label: "Limited availability" }
  ]
};

// Get available badge types
const getAvailableBadges = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      data: AVAILABLE_BADGES
    });
  } catch (error) {
    console.error('❌ Error fetching available badges:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch available badges',
      error: error.message
    });
  }
};

// Get property badges (both admin and dynamic)
const getPropertyBadges = async (req, res) => {
  try {
    const { propertyId } = req.params;

    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        propertyId: property._id,
        title: property.title,
        useAdminBadges: property.useAdminBadges || false,
        adminBadges: property.adminBadges || { highlight: [], details: [], insights: [], urgency: [] },
        dynamicBadges: property.badges // This will return dynamic badges if useAdminBadges is false
      }
    });
  } catch (error) {
    console.error('❌ Error fetching property badges:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch property badges',
      error: error.message
    });
  }
};

// Update property badges (admin-assigned)
const updatePropertyBadges = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { badges, useAdminBadges } = req.body;

    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    // Validate badge structure
    if (badges) {
      const validCategories = ['highlight', 'details', 'insights', 'urgency'];
      for (const category of validCategories) {
        if (badges[category] && !Array.isArray(badges[category])) {
          return res.status(400).json({
            success: false,
            message: `Invalid badge format: ${category} must be an array`
          });
        }
      }
    }

    // Update admin badges
    if (badges) {
      property.adminBadges = {
        highlight: badges.highlight || [],
        details: badges.details || [],
        insights: badges.insights || [],
        urgency: badges.urgency || []
      };
    }

    // Update useAdminBadges flag
    if (typeof useAdminBadges === 'boolean') {
      property.useAdminBadges = useAdminBadges;
    }

    await property.save();

    console.log(`✅ Property ${property.title} badges updated by admin ${req.user?.email}`);

    res.status(200).json({
      success: true,
      message: 'Property badges updated successfully',
      data: {
        propertyId: property._id,
        title: property.title,
        useAdminBadges: property.useAdminBadges,
        adminBadges: property.adminBadges,
        currentBadges: property.badges // Will reflect admin badges if useAdminBadges is true
      }
    });
  } catch (error) {
    console.error('❌ Error updating property badges:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update property badges',
      error: error.message
    });
  }
};

// Add a single badge to a property
const addPropertyBadge = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { category, badge } = req.body;

    if (!category || !badge) {
      return res.status(400).json({
        success: false,
        message: 'Category and badge are required'
      });
    }

    const validCategories = ['highlight', 'details', 'insights', 'urgency'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({
        success: false,
        message: `Invalid category. Must be one of: ${validCategories.join(', ')}`
      });
    }

    if (!badge.type || !badge.label) {
      return res.status(400).json({
        success: false,
        message: 'Badge must have type and label'
      });
    }

    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    // Initialize adminBadges if not exists
    if (!property.adminBadges) {
      property.adminBadges = { highlight: [], details: [], insights: [], urgency: [] };
    }

    // Check if badge already exists
    const existingBadge = property.adminBadges[category].find(b => b.type === badge.type);
    if (existingBadge) {
      return res.status(400).json({
        success: false,
        message: 'Badge already exists in this category'
      });
    }

    // Add badge (no icon - frontend handles icons based on badge type)
    property.adminBadges[category].push({
      type: badge.type,
      label: badge.label,
      priority: badge.priority || property.adminBadges[category].length + 1
    });

    // Enable admin badges
    property.useAdminBadges = true;

    await property.save();

    console.log(`✅ Badge "${badge.label}" added to property ${property.title} by admin ${req.user?.email}`);

    res.status(200).json({
      success: true,
      message: 'Badge added successfully',
      data: {
        propertyId: property._id,
        title: property.title,
        adminBadges: property.adminBadges,
        useAdminBadges: property.useAdminBadges
      }
    });
  } catch (error) {
    console.error('❌ Error adding property badge:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add property badge',
      error: error.message
    });
  }
};

// Remove a badge from a property
const removePropertyBadge = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { category, badgeType } = req.body;

    if (!category || !badgeType) {
      return res.status(400).json({
        success: false,
        message: 'Category and badgeType are required'
      });
    }

    const validCategories = ['highlight', 'details', 'insights', 'urgency'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({
        success: false,
        message: `Invalid category. Must be one of: ${validCategories.join(', ')}`
      });
    }

    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    if (!property.adminBadges || !property.adminBadges[category]) {
      return res.status(400).json({
        success: false,
        message: 'No badges found in this category'
      });
    }

    // Remove badge
    const initialLength = property.adminBadges[category].length;
    property.adminBadges[category] = property.adminBadges[category].filter(b => b.type !== badgeType);

    if (property.adminBadges[category].length === initialLength) {
      return res.status(404).json({
        success: false,
        message: 'Badge not found in this category'
      });
    }

    // Check if all admin badges are empty, then disable useAdminBadges
    const allEmpty = ['highlight', 'details', 'insights', 'urgency'].every(
      cat => !property.adminBadges[cat] || property.adminBadges[cat].length === 0
    );
    if (allEmpty) {
      property.useAdminBadges = false;
    }

    await property.save();

    console.log(`✅ Badge "${badgeType}" removed from property ${property.title} by admin ${req.user?.email}`);

    res.status(200).json({
      success: true,
      message: 'Badge removed successfully',
      data: {
        propertyId: property._id,
        title: property.title,
        adminBadges: property.adminBadges,
        useAdminBadges: property.useAdminBadges
      }
    });
  } catch (error) {
    console.error('❌ Error removing property badge:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove property badge',
      error: error.message
    });
  }
};

// Toggle admin badges on/off for a property
const toggleAdminBadges = async (req, res) => {
  try {
    const { propertyId } = req.params;

    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    property.useAdminBadges = !property.useAdminBadges;
    await property.save();

    console.log(`✅ Property ${property.title} admin badges ${property.useAdminBadges ? 'enabled' : 'disabled'} by admin ${req.user?.email}`);

    res.status(200).json({
      success: true,
      message: `Admin badges ${property.useAdminBadges ? 'enabled' : 'disabled'} for property`,
      data: {
        propertyId: property._id,
        title: property.title,
        useAdminBadges: property.useAdminBadges,
        currentBadges: property.badges
      }
    });
  } catch (error) {
    console.error('❌ Error toggling admin badges:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle admin badges',
      error: error.message
    });
  }
};

module.exports = {
  // Authentication
  adminSignup,

  // Dashboard
  getDashboardStats,

  // Platform Fee Management
  getCurrentPlatformFeeRate,
  updatePlatformFeeRate,
  getPlatformFeeHistory,

  // Users
  getUsers,
  updateUserStatus,
  getUser,
  updateUser,

  // Hosts
  getHosts,
  approveHost,
  rejectHost,

  // Properties
  getProperties,
  approveListing,
  rejectListing,

  // Bookings
  getBookings,
  refundBooking,

  // KYC
  getKYC,
  getKYCById,
  verifyKYC,
  rejectKYC,

  // Payments
  getPayments,
  processPayout,

  // Reviews
  getReviews,
  flagReview,
  deleteReview,

  // Settings
  getSettings,
  updateSettings,

  // Analytics & Reports
  getAnalytics,
  getReports,

  // System
  getRecentActivities,
  getSystemHealth,

  // Payment Audit
  getPaymentAuditDashboard,
  getValidationFailures,
  getPaymentAuditDetails,

  // Featured & Sponsored
  toggleFeatured,
  toggleSponsored,

  // Badge Management
  getAvailableBadges,
  getPropertyBadges,
  updatePropertyBadges,
  addPropertyBadge,
  removePropertyBadge,
  toggleAdminBadges
}; 
