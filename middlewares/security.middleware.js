const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const { logger } = require('../config/logger');
const { config } = require('../config/index');

// Rate limiting for admin endpoints
const adminRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limit for sensitive admin operations
const sensitiveAdminRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per windowMs
  message: {
    success: false,
    message: 'Too many sensitive operations from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit for admin login
const adminLoginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 login attempts per windowMs
  message: {
    success: false,
    message: 'Too many login attempts, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Enhanced admin authentication with additional security checks
const enhancedAdminAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.'
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (decoded.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Admin privileges required.'
      });
    }

    // Get admin with additional security checks
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

    // Check if admin account is locked
    if (admin.isLocked) {
      return res.status(423).json({
        success: false,
        message: 'Admin account is locked. Please contact system administrator.'
      });
    }

    // Check last activity and session timeout
    const sessionTimeout = 24 * 60 * 60 * 1000; // 24 hours
    if (admin.lastActivity && (Date.now() - admin.lastActivity.getTime()) > sessionTimeout) {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please login again.'
      });
    }

    // Update last activity
    admin.lastActivity = new Date();
    await admin.save();

    req.user = admin;
    req.isAdmin = true;
    req.adminId = admin._id;

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
    
    res.status(500).json({
      success: false,
      message: 'Server error.'
    });
  }
};

// Input validation and sanitization middleware
const validateAdminInput = (req, res, next) => {
  // Sanitize and validate common admin inputs
  const sanitizeString = (str) => {
    if (typeof str !== 'string') return '';
    return str.trim().replace(/[<>]/g, '');
  };

  const sanitizeObject = (obj) => {
    if (!obj || typeof obj !== 'object') return {};
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        sanitized[key] = sanitizeString(value);
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizeObject(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  };

  // Sanitize request body
  if (req.body) {
    req.body = sanitizeObject(req.body);
  }

  // Sanitize query parameters
  if (req.query) {
    req.query = sanitizeObject(req.query);
  }

  // Sanitize URL parameters
  if (req.params) {
    req.params = sanitizeObject(req.params);
  }

  next();
};

// Audit logging middleware
const auditLog = (action) => {
  return (req, res, next) => {
    const originalSend = res.send;
    
    res.send = function(data) {
      // Log admin actions for audit trail
      const auditData = {
        adminId: req.adminId,
        action: action,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        timestamp: new Date(),
        statusCode: res.statusCode,
        success: data.success || false
      };

      logger.info('AUDIT LOG', { audit: auditData });
      
      originalSend.call(this, data);
    };
    
    next();
  };
};

// Request size limiting
const requestSizeLimit = (req, res, next) => {
  const contentLength = parseInt(req.get('Content-Length') || '0');
  const maxSize = 10 * 1024 * 1024; // 10MB

  if (contentLength > maxSize) {
    return res.status(413).json({
      success: false,
      message: 'Request entity too large.'
    });
  }

  next();
};

// Security headers middleware
const securityHeaders = (req, res, next) => {
  // Set security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  next();
};

// IP whitelist middleware (optional - for production)
const ipWhitelist = (allowedIPs = []) => {
  return (req, res, next) => {
    if (allowedIPs.length === 0) {
      return next(); // No whitelist configured
    }

    const clientIP = req.ip || req.connection.remoteAddress;
    
    if (!allowedIPs.includes(clientIP)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. IP not in whitelist.'
      });
    }

    next();
  };
};

// Two-factor authentication check (placeholder for future implementation)
const require2FA = (req, res, next) => {
  // This would check if 2FA is enabled and verified
  // For now, we'll just pass through
  next();
};

// Security middleware for additional protection
const securityMiddleware = {
  // Validate JWT token format and expiration
  validateToken: (req, res, next) => {
    try {
      const token = req.header('Authorization')?.replace('Bearer ', '');
      
      if (!token) {
        return res.status(401).json({
          success: false,
          message: 'No token provided'
        });
      }

      // Check token format
      if (!token.match(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/)) {
        return res.status(401).json({
          success: false,
          message: 'Invalid token format'
        });
      }

      // Verify token (this will also check expiration)
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Add additional security checks
      if (!decoded.id || !decoded.role) {
        return res.status(401).json({
          success: false,
          message: 'Invalid token payload'
        });
      }

      // Check if token is not too old (optional additional security)
      const tokenAge = Date.now() - (decoded.iat * 1000);
      const maxTokenAge = 30 * 24 * 60 * 60 * 1000; // 30 days
      
      if (tokenAge > maxTokenAge) {
        return res.status(401).json({
          success: false,
          message: 'Token is too old, please login again'
        });
      }

      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Token expired'
        });
      }
      
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    }
  },

  // Prevent access to sensitive endpoints from non-browser clients
  browserOnly: (req, res, next) => {
    const userAgent = req.get('User-Agent');
    
    if (!userAgent || userAgent.includes('bot') || userAgent.includes('crawler')) {
      return res.status(403).json({
        success: false,
        message: 'Access denied for this client type'
      });
    }
    
    next();
  },

  // Validate request origin (basic CSRF protection)
  validateOrigin: (req, res, next) => {
    const origin = req.get('Origin');
    const referer = req.get('Referer');
    
    // Allow requests from same origin or trusted domains
    if (req.method === 'GET') {
      return next(); // GET requests are generally safe
    }
    
    // Build trusted origins from config (no hardcoded domains)
    const trustedOrigins = [];
    if (config.frontendUrl) {
      config.frontendUrl.split(',').forEach(u => trustedOrigins.push(u.trim()));
    }
    trustedOrigins.push(...config.allowedOrigins);
    if (config.isDevelopment) trustedOrigins.push('localhost');

    const matchesTrusted = (url) => trustedOrigins.some(t => url.includes(t));

    // For POST/PUT/DELETE requests, check origin
    if (origin && matchesTrusted(origin)) {
      return next();
    }
    
    // If no origin but has referer, check referer
    if (!origin && referer && matchesTrusted(referer)) {
      return next();
    }
    
    // For API clients, allow if they have a valid token
    if (req.user) {
      return next();
    }
    
    return res.status(403).json({
      success: false,
      message: 'Invalid request origin'
    });
  },

  // Audit logging for security events
  auditLog: (action) => {
    return (req, res, next) => {
      const logData = {
        timestamp: new Date().toISOString(),
        action: action,
        method: req.method,
        path: req.path,
        userId: req.user?._id || 'anonymous',
        userRole: req.user?.role || 'anonymous',
        ip: req.ip,
        userAgent: req.get('User-Agent')
      };
      
      logger.debug('Security Audit', logData);
      
      // You could also log to a file or external service here
      
      next();
    };
  }
};

module.exports = {
  adminRateLimit,
  sensitiveAdminRateLimit,
  adminLoginRateLimit,
  enhancedAdminAuth,
  validateAdminInput,
  auditLog,
  requestSizeLimit,
  securityHeaders,
  ipWhitelist,
  require2FA,
  securityMiddleware
}; 