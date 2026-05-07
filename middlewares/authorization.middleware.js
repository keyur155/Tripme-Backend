// Authorization middleware for ensuring users can only access their own data
const { logger } = require('../config/logger');

// Check if user owns a resource
const ownsResource = (resourceType) => {
  return async (req, res, next) => {
    try {
      const resourceId = req.params.id || req.params[`${resourceType}Id`];
      if (!resourceId) {
        return res.status(400).json({
          success: false,
          message: 'Resource ID is required'
        });
      }

      // Dynamically require models to avoid circular dependencies
      let resource;
      let ownerField;

      switch (resourceType) {
        case 'property':
          const Property = require('../models/Property');
          resource = await Property.findById(resourceId);
          ownerField = 'host';
          break;
        case 'service':
          const Service = require('../models/Service');
          resource = await Service.findById(resourceId);
          ownerField = 'provider';
          break;
        case 'booking':
          const Booking = require('../models/Booking');
          resource = await Booking.findById(resourceId);
          // Bookings have both user (guest) and host
          if (resource.user.toString() === req.user._id.toString() || 
              resource.host.toString() === req.user._id.toString() || 
              req.user.role === 'admin') {
            return next();
          }
          return res.status(403).json({
            success: false,
            message: 'Not authorized to access this booking'
          });
        case 'payment':
          const Payment = require('../models/Payment');
          resource = await Payment.findById(resourceId);
          ownerField = 'user';
          break;
        case 'review':
          const Review = require('../models/Review');
          resource = await Review.findById(resourceId);
          ownerField = 'reviewer';
          break;
        case 'wishlist':
          const Wishlist = require('../models/Wishlist');
          resource = await Wishlist.findById(resourceId);
          ownerField = 'user';
          break;
        case 'notification':
          const Notification = require('../models/Notification');
          resource = await Notification.findById(resourceId);
          ownerField = 'recipient';
          break;
        case 'support':
          const SupportTicket = require('../models/SupportTicket');
          resource = await SupportTicket.findById(resourceId);
          ownerField = 'user';
          break;
        default:
          return res.status(400).json({
            success: false,
            message: 'Invalid resource type'
          });
      }

      if (!resource) {
        return res.status(404).json({
          success: false,
          message: 'Resource not found'
        });
      }

      // Check if user owns the resource or is admin
      if (resource[ownerField].toString() !== req.user._id.toString() && req.user.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to access this resource'
        });
      }

      // Add resource to request for use in controllers
      req.resource = resource;
      next();
    } catch (error) {
      logger.error('Authorization error', { error: error.message });
      res.status(500).json({
        success: false,
        message: 'Authorization check failed'
      });
    }
  };
};

// Check if user is the host of a property
const isPropertyHost = async (req, res, next) => {
  try {
    const propertyId = req.params.propertyId || req.params.id;
    if (!propertyId) {
      return res.status(400).json({
        success: false,
        message: 'Property ID is required'
      });
    }

    const Property = require('../models/Property');
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    if (property.host.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to manage this property'
      });
    }

    req.property = property;
    next();
  } catch (error) {
    logger.error('Property host check error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Authorization check failed'
    });
  }
};

// Check if user is the provider of a service
const isServiceProvider = async (req, res, next) => {
  try {
    const serviceId = req.params.serviceId || req.params.id;
    if (!serviceId) {
      return res.status(400).json({
        success: false,
        message: 'Service ID is required'
      });
    }

    const Service = require('../models/Service');
    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    if (service.provider.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to manage this service'
      });
    }

    req.service = service;
    next();
  } catch (error) {
    logger.error('Service provider check error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Authorization check failed'
    });
  }
};

// Check if user can access booking data
const canAccessBooking = async (req, res, next) => {
  try {
    const bookingId = req.params.bookingId || req.params.id;
    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: 'Booking ID is required'
      });
    }

    // Validate booking ID format (MongoDB ObjectId)
    if (!bookingId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking ID format'
      });
    }

    const Booking = require('../models/Booking');
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // User can access if they are the guest, host, or admin
    const isGuest = booking.user.toString() === req.user._id.toString();
    const isHost = booking.host.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin' || req.user.role === 'super-admin';
    
    if (!isGuest && !isHost && !isAdmin) {
      logger.warn('Unauthorized booking access attempt', { userId: req.user._id, bookingId });
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this booking'
      });
    }

    // Additional security: Check if user account is active
    if (req.user.accountStatus && req.user.accountStatus !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'Account is not active. Please contact support.'
      });
    }
    
    // Add booking to request for use in controllers
    req.booking = booking;
    next();
  } catch (error) {
    logger.error('Booking access check error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Authorization check failed'
    });
  }
};

// Check if user can access payment data
const canAccessPayment = async (req, res, next) => {
  try {
    const paymentId = req.params.paymentId || req.params.id;
    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: 'Payment ID is required'
      });
    }

    const Payment = require('../models/Payment');
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    // User can access if they are the payer or admin
    if (payment.user.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this payment'
      });
    }

    req.payment = payment;
    next();
  } catch (error) {
    logger.error('Payment access check error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Authorization check failed'
    });
  }
};

// Check if user can access review data
const canAccessReview = async (req, res, next) => {
  try {
    const reviewId = req.params.reviewId || req.params.id;
    if (!reviewId) {
      return res.status(400).json({
        success: false,
        message: 'Review ID is required'
      });
    }

    const Review = require('../models/Review');
    const review = await Review.findById(reviewId);
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    // User can access if they are the reviewer, reviewed host, or admin
    const isReviewer = review.reviewer.toString() === req.user._id.toString();
    const isReviewedUser = review.host?.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';

    if (!isReviewer && !isReviewedUser && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this review'
      });
    }

    req.review = review;
    next();
  } catch (error) {
    logger.error('Review access check error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Authorization check failed'
    });
  }
};

// Check if user can access wishlist data
const canAccessWishlist = async (req, res, next) => {
  try {
    const wishlistId = req.params.wishlistId || req.params.id;
    if (!wishlistId) {
      return res.status(400).json({
        success: false,
        message: 'Wishlist ID is required'
      });
    }

    const Wishlist = require('../models/Wishlist');
    const wishlist = await Wishlist.findById(wishlistId);
    if (!wishlist) {
      return res.status(404).json({
        success: false,
        message: 'Wishlist not found'
      });
    }

    // User can access if they own the wishlist, are a collaborator, or it's public
    const isOwner = wishlist.user.toString() === req.user._id.toString();
    const isCollaborator = wishlist.collaborators && wishlist.collaborators.includes(req.user._id);
    const isPublic = wishlist.isPublic;
    const isAdmin = req.user.role === 'admin';

    if (!isOwner && !isCollaborator && !isPublic && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this wishlist'
      });
    }

    req.wishlist = wishlist;
    next();
  } catch (error) {
    logger.error('Wishlist access check error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Authorization check failed'
    });
  }
};

// Check if user can access notification data
const canAccessNotification = async (req, res, next) => {
  try {
    const notificationId = req.params.notificationId || req.params.id;
    if (!notificationId) {
      return res.status(400).json({
        success: false,
        message: 'Notification ID is required'
      });
    }

    const Notification = require('../models/Notification');
    const notification = await Notification.findById(notificationId);
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    // User can access if they are the recipient or admin
    if (notification.recipient.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this notification'
      });
    }

    req.notification = notification;
    next();
  } catch (error) {
    logger.error('Notification access check error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Authorization check failed'
    });
  }
};

// Check if user can access support ticket data
const canAccessSupportTicket = async (req, res, next) => {
  try {
    const ticketId = req.params.ticketId || req.params.id;
    if (!ticketId) {
      return res.status(400).json({
        success: false,
        message: 'Ticket ID is required'
      });
    }

    const SupportTicket = require('../models/SupportTicket');
    const ticket = await SupportTicket.findById(ticketId);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // User can access if they are the ticket creator, assigned agent, or admin
    const isCreator = ticket.user.toString() === req.user._id.toString();
    const isAssignedAgent = ticket.assignedTo && ticket.assignedTo.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';

    if (!isCreator && !isAssignedAgent && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this ticket'
      });
    }

    req.supportTicket = ticket;
    next();
  } catch (error) {
    logger.error('Support ticket access check error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Authorization check failed'
    });
  }
};

// Check if user can access user profile data
const canAccessUserProfile = async (req, res, next) => {
  try {
    const userId = req.params.userId || req.params.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // User can access their own profile or admin can access any profile
    if (userId !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this user profile'
      });
    }

    const User = require('../models/User');
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    req.targetUser = user;
    next();
  } catch (error) {
    logger.error('User profile access check error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Authorization check failed'
    });
  }
};

// Check if user is admin
const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin access required'
    });
  }
  next();
};

// Check if user is host
const isHost = (req, res, next) => {
  if (req.user.role !== 'host' && req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Host access required'
    });
  }
  next();
};

// Check if user is guest
const isGuest = (req, res, next) => {
  if (req.user.role !== 'guest' && req.user.role !== 'host' && req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Guest access required'
    });
  }
  next();
};

// Check if user is verified
const isVerified = (req, res, next) => {
  if (!req.user.isVerified && req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Account verification required'
    });
  }
  next();
};

// Check if user has KYC verification
const hasKYCVerification = async (req, res, next) => {
  try {
    if (req.user.role !== 'host' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Host access required'
      });
    }

    // Check if user has KYC verification
    if (!req.user.kyc || req.user.kyc.status !== 'verified') {
      return res.status(403).json({
        success: false,
        message: 'KYC verification required'
      });
    }

    next();
  } catch (error) {
    logger.error('KYC verification check error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'KYC verification check failed'
    });
  }
};

module.exports = {
  ownsResource,
  isPropertyHost,
  isServiceProvider,
  canAccessBooking,
  canAccessPayment,
  canAccessReview,
  canAccessWishlist,
  canAccessNotification,
  canAccessSupportTicket,
  canAccessUserProfile,
  isAdmin,
  isHost,
  isGuest,
  isVerified,
  hasKYCVerification
};
