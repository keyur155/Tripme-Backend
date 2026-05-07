const User = require('../models/User');
const Property = require('../models/Property');
const Service = require('../models/Service');
const Booking = require('../models/Booking');
const Review = require('../models/Review');
const Wishlist = require('../models/Wishlist');
const Notification = require('../models/Notification');
const Host = require('../models/Host');

// @desc    Get user profile
// @route   GET /api/users/:id
// @access  Public
const getUserProfile = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id)
      .select('-password')
      .populate('savedListings', 'title images pricing');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Get user's listings if they're a host
    let listings = [];
    if (user.role === 'host') {
      listings = await Property.find({ host: id, status: 'published' })
        .select('title images pricing rating reviewCount')
        .limit(6);
    }

    // Get user's services if they're a service provider
    let services = [];
    if (user.role === 'host') {
      services = await Service.find({ provider: id, status: 'published' })
        .select('title media pricing rating reviewCount')
        .limit(6);
    }

    // Get recent reviews received
    const reviews = await Review.find({ host: id, isPublic: true })
      .populate('reviewer', 'name profileImage')
      .populate('property', 'title')
      .sort({ createdAt: -1 })
      .limit(5);

    res.status(200).json({
      success: true,
      data: {
        user,
        listings,
        services,
        reviews
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching user profile',
      error: error.message
    });
  }
};

// @desc    Apply to become host
// @route   POST /api/users/become-host
// @access  Private
const becomeHost = async (req, res) => {
  try {
    // req.user is already the user object from auth middleware
    // Get the full user document to ensure we have all fields
    const userId = req.user._id || req.user.id;
    if (!userId) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if user is already a host
    if (user.role === 'host') {
      // Return success with current user data (already a host)
      return res.status(200).json({
        success: true,
        message: 'User is already a host',
        data: { user }
      });
    }

    // Check if user is an admin (admins shouldn't become hosts)
    if (user.role === 'admin') {
      return res.status(400).json({
        success: false,
        message: 'Admins cannot become hosts'
      });
    }

    // Upgrade to host role immediately
    // KYC is required for publishing listings, not for becoming a host
    user.role = 'host';
    
    // Set KYC deadline if not already set (15 days from now)
    if (!user.kyc) {
      user.kyc = {
        status: 'not_submitted',
        deadline: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000) // 15 days
      };
    } else if (!user.kyc.deadline) {
      user.kyc.deadline = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
    }
    
    await user.save();

    let host = await Host.findOne({ user: user._id });

    if (!host) {
      host = await Host.create({
        user: user._id,
        hostingSince: new Date(),
      });
    }

    // Create notification for user
    await Notification.create({
      user: user._id,
      type: 'system',
      title: 'Welcome to Hosting!',
      message: 'You are now a host! Complete KYC verification within 15 days to publish your listings.',
      metadata: { newRole: 'host', kycDeadline: user.kyc.deadline }
    });

    res.status(200).json({
      success: true,
      message: 'Successfully upgraded to host role. Complete KYC to publish listings.',
      data: { 
        user,
        kycRequired: true,
        kycDeadline: user.kyc.deadline
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error becoming host',
      error: error.message
    });
  }
};


// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
const updateUserProfile = async (req, res) => {
  try {
    const {
      name,
      phone,
      bio,
      languages,
      location,
      profileImage
    } = req.body;

    // Clean up empty strings to null/undefined
    const updateData = {};
    
    if (name !== undefined) updateData.name = name || null;
    if (phone !== undefined) updateData.phone = phone || null;
    if (bio !== undefined) updateData.bio = bio || null;
    if (languages !== undefined) updateData.languages = languages;
    if (location !== undefined) updateData.location = location;
    if (profileImage !== undefined) updateData.profileImage = profileImage || null;

    const user = await User.findByIdAndUpdate(
      req.user.id,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: { user }
    });
  } catch (error) {
    // Handle duplicate key errors (e.g., email uniqueness)
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'A user with this email already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Error updating profile',
      error: error.message
    });
  }
};



// @desc    Get user's wishlist
// @route   GET /api/users/wishlist
// @access  Private
const getWishlist = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    const wishlist = await Wishlist.find({ user: req.user.id })
      .populate('listing', 'title images pricing rating reviewCount')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Wishlist.countDocuments({ user: req.user.id });

    res.status(200).json({
      success: true,
      data: {
        wishlist,
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
      message: 'Error fetching wishlist',
      error: error.message
    });
  }
};

// @desc    Get user's notifications
// @route   GET /api/users/notifications
// @access  Private
const getNotifications = async (req, res) => {
  try {
    const { page = 1, limit = 20, unreadOnly = false } = req.query;

    const query = { user: req.user.id };
    if (unreadOnly === 'true') {
      query.isRead = false;
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Notification.countDocuments(query);
    const unreadCount = await Notification.countDocuments({
      user: req.user.id,
      isRead: false
    });

    res.status(200).json({
      success: true,
      data: {
        notifications,
        unreadCount,
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
      message: 'Error fetching notifications',
      error: error.message
    });
  }
};

// @desc    Mark notification as read
// @route   PUT /api/users/notifications/:id/read
// @access  Private
const markNotificationRead = async (req, res) => {
  try {
    const { id } = req.params;

    const notification = await Notification.findOneAndUpdate(
      { _id: id, user: req.user.id },
      { isRead: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Notification marked as read',
      data: { notification }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error marking notification as read',
      error: error.message
    });
  }
};

// @desc    Mark all notifications as read
// @route   PUT /api/users/notifications/read-all
// @access  Private
const markAllNotificationsRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { user: req.user.id, isRead: false },
      { isRead: true }
    );

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error marking notifications as read',
      error: error.message
    });
  }
};

// @desc    Delete notification
// @route   DELETE /api/users/notifications/:id
// @access  Private
const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;

    const notification = await Notification.findOneAndDelete({
      _id: id,
      user: req.user.id
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting notification',
      error: error.message
    });
  }
};

// @desc    Get user dashboard stats
// @route   GET /api/users/dashboard
// @access  Private
const getDashboardStats = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    let stats = {};

    if (user.role === 'host') {
      // Host dashboard stats
      const totalListings = await Property.countDocuments({ host: userId });
      const activeListings = await Property.countDocuments({ 
        host: userId, 
        status: 'published' 
      });
      const totalServices = await Service.countDocuments({ provider: userId });
      const activeServices = await Service.countDocuments({ 
        provider: userId, 
        status: 'published' 
      });

      const totalBookings = await Booking.countDocuments({ host: userId });
      const pendingBookings = await Booking.countDocuments({ 
        host: userId, 
        status: 'pending' 
      });
      const completedBookings = await Booking.countDocuments({ 
        host: userId, 
        status: 'completed' 
      });

      const totalEarnings = await Booking.aggregate([
        { $match: { host: userId, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } }
      ]);

      // Calculate occupancy rate based on current bookings
      const currentDate = new Date();
      const currentBookings = await Booking.countDocuments({
        host: userId,
        status: { $in: ['confirmed', 'pending'] },
        $or: [
          // For property bookings
          {
            checkIn: { $lte: currentDate },
            checkOut: { $gte: currentDate }
          },
          // For service bookings (if they have time slots)
          {
            'timeSlot.startTime': { $lte: currentDate },
            'timeSlot.endTime': { $gte: currentDate }
          }
        ]
      });

      // Calculate occupancy rate: (booked properties / total active properties) * 100
      const occupancyRate = activeListings > 0 ? Math.round((currentBookings / activeListings) * 100) : 0;

      const recentBookings = await Booking.find({ host: userId })
        .populate('user', 'name profileImage')
        .populate('listing', 'title images')
        .populate('service', 'title media')
        .sort({ createdAt: -1 })
        .limit(5);

      stats = {
        totalListings,
        activeListings,
        totalServices,
        activeServices,
        totalBookings,
        pendingBookings,
        completedBookings,
        totalEarnings: totalEarnings[0]?.total || 0,
        occupancyRate,
        currentBookings,
        recentBookings
      };
    } else {
      // Guest dashboard stats
      const totalBookings = await Booking.countDocuments({ user: userId });
      const upcomingBookings = await Booking.countDocuments({ 
        user: userId, 
        status: { $in: ['confirmed', 'pending'] } 
      });
      const completedBookings = await Booking.countDocuments({ 
        user: userId, 
        status: 'completed' 
      });

      const wishlistCount = await Wishlist.countDocuments({ user: userId });
      const totalReviews = await Review.countDocuments({ reviewer: userId });

      const recentBookings = await Booking.find({ user: userId })
        .populate('host', 'name profileImage')
        .populate('listing', 'title images')
        .populate('service', 'title media')
        .sort({ createdAt: -1 })
        .limit(5);

      stats = {
        totalBookings,
        upcomingBookings,
        completedBookings,
        wishlistCount,
        totalReviews,
        recentBookings
      };
    }

    res.status(200).json({
      success: true,
      data: { stats }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching dashboard stats',
      error: error.message
    });
  }
};

// @desc    Search users (admin only)
// @route   GET /api/users/search
// @access  Private (Admin only)
const searchUsers = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to search users'
      });
    }

    const {
      page = 1,
      limit = 10,
      search,
      role,
      accountStatus,
      isVerified
    } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    if (role) {
      query.role = role;
    }

    if (accountStatus) {
      query.accountStatus = accountStatus;
    }

    if (isVerified !== undefined) {
      query.isVerified = isVerified === 'true';
    }

    const users = await User.find(query)
      .select('-password')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await User.countDocuments(query);

    res.status(200).json({
      success: true,
      data: {
        users,
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
      message: 'Error searching users',
      error: error.message
    });
  }
};

// @desc    Update user status (admin only)
// @route   PUT /api/users/:id/status
// @access  Private (Admin only)
const updateUserStatus = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update user status'
      });
    }

    const { id } = req.params;
    const { accountStatus, role } = req.body;

    const user = await User.findByIdAndUpdate(
      id,
      { accountStatus, role },
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'User status updated successfully',
      data: { user }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating user status',
      error: error.message
    });
  }
};

// @desc    Verify KYC (admin only)
// @route   PUT /api/users/:id/verify-kyc
// @access  Private (Admin only)
const verifyKYC = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to verify KYC'
      });
    }

    const { id } = req.params;
    const { status, reason } = req.body;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    user.kyc.status = status;

    await user.save();

    // Create notification for user
    await Notification.create({
      user: user._id,
      type: 'kyc_verification',
      title: 'KYC Verification Update',
      message: `Your KYC verification has been ${status}${reason ? `: ${reason}` : ''}`,
      data: { kycStatus: status }
    });

    res.status(200).json({
      success: true,
      message: 'KYC verification updated successfully',
      data: { user }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating KYC verification',
      error: error.message
    });
  }
};

// @desc    Get user analytics
// @route   GET /api/users/analytics
// @access  Private
const getUserAnalytics = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    let analytics = {};

    if (user.role === 'host') {
      // Host analytics
      const monthlyBookings = await Booking.aggregate([
        { $match: { host: userId } },
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' }
            },
            count: { $sum: 1 },
            revenue: { $sum: '$totalAmount' }
          }
        },
        { $sort: { '_id.year': -1, '_id.month': -1 } },
        { $limit: 12 }
      ]);

      const bookingStatusDistribution = await Booking.aggregate([
        { $match: { host: userId } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]);

      const topListings = await Property.aggregate([
        { $match: { host: userId } },
        {
          $lookup: {
            from: 'bookings',
            localField: '_id',
            foreignField: 'listing',
            as: 'bookings'
          }
        },
        {
          $addFields: {
            bookingCount: { $size: '$bookings' },
            totalRevenue: {
              $sum: '$bookings.totalAmount'
            }
          }
        },
        { $sort: { bookingCount: -1 } },
        { $limit: 5 }
      ]);

      analytics = {
        monthlyBookings,
        bookingStatusDistribution,
        topListings
      };
    } else {
      // Guest analytics
      const monthlySpending = await Booking.aggregate([
        { $match: { user: userId } },
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' }
            },
            count: { $sum: 1 },
            spending: { $sum: '$totalAmount' }
          }
        },
        { $sort: { '_id.year': -1, '_id.month': -1 } },
        { $limit: 12 }
      ]);

      const bookingTypeDistribution = await Booking.aggregate([
        { $match: { user: userId } },
        {
          $group: {
            _id: '$bookingType',
            count: { $sum: 1 }
          }
        }
      ]);

      analytics = {
        monthlySpending,
        bookingTypeDistribution
      };
    }

    res.status(200).json({
      success: true,
      data: { analytics }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching user analytics',
      error: error.message
    });
  }
};

module.exports = {
  getUserProfile,
  becomeHost,
  updateUserProfile,
  getWishlist,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  getDashboardStats,
  searchUsers,
  updateUserStatus,
  verifyKYC,
  getUserAnalytics
};
