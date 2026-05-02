const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Admin = require('../models/Admin');
const { logger } = require('../config/logger');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if it's an admin token
    if (decoded.role === 'admin') {
      const admin = await Admin.findById(decoded.id).select('-password');
      
      if (!admin) {
        return res.status(401).json({
          success: false,
          message: 'Invalid token. Admin not found.'
        });
      }

      if (!admin.isActive) {
        return res.status(401).json({
          success: false,
          message: 'Admin account is not active.'
        });
      }

      req.user = admin;
      req.isAdmin = true;
    } else {
      // Regular user authentication
      const user = await User.findById(decoded.id).select('-password');

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid token. User not found.'
        });
      }

      if (user.accountStatus !== 'active') {
        return res.status(401).json({
          success: false,
          message: 'Account is not active. Please contact support.'
        });
      }



      req.user = user;
      req.isAdmin = false;
    }

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token.'
      });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired.'
      });
    }
    
    logger.error('Auth middleware error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Server error.'
    });
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      if (decoded.role === 'admin') {
        const admin = await Admin.findById(decoded.id).select('-password');
        if (admin && admin.isActive) {
          req.user = admin;
          req.isAdmin = true;
        }
      } else {
        const user = await User.findById(decoded.id).select('-password');
        if (user && user.accountStatus === 'active') {
          req.user = user;
          req.isAdmin = false;
        }
      }
    }
    
    next();
  } catch (error) {
    // Continue without authentication for optional routes
    next();
  }
};

// Role-based middleware
const adminOnly = (req, res, next) => {
  if (!req.isAdmin) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin privileges required.'
    });
  }
  next();
};

const hostOnly = (req, res, next) => {
  if (req.isAdmin) {
    return next(); // Admins can access host routes
  }
  
  if (!req.user || req.user.role !== 'host') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Host privileges required.'
    });
  }
  next();
};

const guestOnly = (req, res, next) => {
  if (req.isAdmin) {
    return next(); // Admins can access guest routes
  }
  
  if (!req.user || req.user.role !== 'guest') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Guest privileges required.'
    });
  }
  next();
};

module.exports = { 
  auth, 
  optionalAuth, 
  protect: auth,
  adminOnly,
  hostOnly,
  guestOnly
};
