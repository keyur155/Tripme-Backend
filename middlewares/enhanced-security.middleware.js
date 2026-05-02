const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { validatePassword } = require('../config/security.config');
const { logger } = require('../config/logger');

const MAX_SUSPICIOUS_IPS = 5000;
const MAX_BLOCKED_IPS = 5000;
const MAX_REASONS_PER_IP = 20;

// Enhanced security middleware for production
class EnhancedSecurityMiddleware {
  constructor() {
    this.suspiciousIPs = new Map();
    this.failedAttempts = new Map();
    this.blockedIPs = new Set();
  }

  // Advanced rate limiting with IP reputation
  createAdvancedRateLimiter(options = {}) {
    const {
      windowMs = 15 * 60 * 1000,
      max = 100,
      message = 'Too many requests',
      keyGenerator = (req) => req.ip,
      skipSuccessfulRequests = false,
      skipFailedRequests = false
    } = options;

    return rateLimit({
      windowMs,
      max,
      message: {
        success: false,
        message,
        retryAfter: Math.ceil(windowMs / 1000)
      },
      keyGenerator,
      skipSuccessfulRequests,
      skipFailedRequests,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        // Track suspicious IPs
        const clientIP = req.ip;
        this.trackSuspiciousIP(clientIP, 'rate_limit_exceeded');
        
        res.status(429).json({
          success: false,
          message,
          retryAfter: Math.ceil(windowMs / 1000),
          errorCode: 'RATE_LIMIT_EXCEEDED'
        });
      }
    });
  }

  // Track suspicious IP addresses
  trackSuspiciousIP(ip, reason) {
    // Evict oldest entries if map is at capacity
    if (!this.suspiciousIPs.has(ip) && this.suspiciousIPs.size >= MAX_SUSPICIOUS_IPS) {
      const oldestKey = this.suspiciousIPs.keys().next().value;
      this.suspiciousIPs.delete(oldestKey);
    }

    if (!this.suspiciousIPs.has(ip)) {
      this.suspiciousIPs.set(ip, {
        count: 0,
        reasons: [],
        firstSeen: Date.now(),
        lastSeen: Date.now()
      });
    }

    const record = this.suspiciousIPs.get(ip);
    record.count++;
    // Cap reasons array to prevent per-IP memory growth
    if (record.reasons.length < MAX_REASONS_PER_IP) {
      record.reasons.push({ reason, timestamp: Date.now() });
    }
    record.lastSeen = Date.now();

    // Block IP if too many suspicious activities
    if (record.count >= 10) {
      if (this.blockedIPs.size < MAX_BLOCKED_IPS) {
        this.blockedIPs.add(ip);
      }
      logger.warn(`IP blocked due to suspicious activity`, { ip, count: record.count });
    }
  }

  // IP reputation check middleware
  checkIPReputation = (req, res, next) => {
    const clientIP = req.ip;
    
    // Check if IP is blocked
    if (this.blockedIPs.has(clientIP)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied due to suspicious activity',
        errorCode: 'IP_BLOCKED'
      });
    }

    // Check if IP has suspicious reputation
    if (this.suspiciousIPs.has(clientIP)) {
      const record = this.suspiciousIPs.get(clientIP);
      const timeSinceFirstSeen = Date.now() - record.firstSeen;
      
      // If IP has many suspicious activities in a short time, block temporarily
      if (record.count >= 5 && timeSinceFirstSeen < 60 * 60 * 1000) { // 1 hour
        this.blockedIPs.add(clientIP);
        return res.status(403).json({
          success: false,
          message: 'Access temporarily restricted due to suspicious activity',
          errorCode: 'IP_TEMPORARILY_BLOCKED'
        });
      }
    }

    next();
  };

  // Enhanced CORS with security
  createSecureCORS() {
    return cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or Postman)
        if (!origin) return callback(null, true);
        
        const allowedOrigins = process.env.ALLOWED_ORIGINS 
          ? process.env.ALLOWED_ORIGINS.split(',')
          : ['http://localhost:3000'];
        
        if (allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          console.log(`🚨 CORS blocked origin: ${origin}`);
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type', 
        'Authorization', 
        'X-Requested-With',
        'X-API-Key',
        'X-Client-Version'
      ],
      exposedHeaders: ['X-Total-Count', 'X-Page-Count', 'X-RateLimit-Limit'],
      maxAge: 86400 // 24 hours
    });
  }

  // Enhanced Helmet configuration
  createEnhancedHelmet() {
    return helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
          upgradeInsecureRequests: []
        }
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      dnsPrefetchControl: { allow: false },
      frameguard: { action: 'deny' },
      hidePoweredBy: true,
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      },
      ieNoOpen: true,
      noSniff: true,
      permittedCrossDomainPolicies: { permittedPolicies: "none" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      xssFilter: true
    });
  }

  // Request sanitization middleware
  sanitizeRequest = (req, res, next) => {
    // Sanitize request body
    if (req.body) {
      req.body = this.sanitizeObject(req.body);
    }

    // Sanitize query parameters
    if (req.query) {
      req.query = this.sanitizeObject(req.query);
    }

    // Sanitize URL parameters
    if (req.params) {
      req.params = this.sanitizeObject(req.params);
    }

    next();
  };

  // Recursive object sanitization
  sanitizeObject(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    
    const sanitized = Array.isArray(obj) ? [] : {};
    
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        // Remove potentially dangerous characters and scripts
        sanitized[key] = value
          .replace(/[<>]/g, '')
          .replace(/javascript:/gi, '')
          .replace(/on\w+=/gi, '')
          .trim();
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeObject(value);
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }

  // SQL injection prevention middleware
  preventSQLInjection = (req, res, next) => {
    const sqlPatterns = [
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|SCRIPT)\b)/i,
      /(\b(OR|AND)\s+\d+\s*=\s*\d+)/i,
      /(\b(OR|AND)\s+['"]?\w+['"]?\s*=\s*['"]?\w+['"]?)/i,
      /(--|#|\/\*|\*\/)/,
      /(\b(WAITFOR|DELAY)\b)/i
    ];

    const checkValue = (value) => {
      if (typeof value === 'string') {
        return sqlPatterns.some(pattern => pattern.test(value));
      }
      return false;
    };

    const checkObject = (obj) => {
      for (const [key, value] of Object.entries(obj)) {
        if (checkValue(value)) {
          return true;
        }
        if (typeof value === 'object' && value !== null) {
          if (checkObject(value)) return true;
        }
      }
      return false;
    };

    // Check request body, query, and params
    if (checkObject(req.body) || checkObject(req.query) || checkObject(req.params)) {
      this.trackSuspiciousIP(req.ip, 'sql_injection_attempt');
      return res.status(400).json({
        success: false,
        message: 'Invalid input detected',
        errorCode: 'INVALID_INPUT'
      });
    }

    next();
  };

  // XSS prevention middleware
  preventXSS = (req, res, next) => {
    const xssPatterns = [
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      /javascript:/gi,
      /on\w+\s*=/gi,
      /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
      /<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi,
      /<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi
    ];

    const checkValue = (value) => {
      if (typeof value === 'string') {
        return xssPatterns.some(pattern => pattern.test(value));
      }
      return false;
    };

    const checkObject = (obj) => {
      for (const [key, value] of Object.entries(obj)) {
        if (checkValue(value)) {
          return true;
        }
        if (typeof value === 'object' && value !== null) {
          if (checkObject(value)) return true;
        }
      }
      return false;
    };

    // Check request body, query, and params
    if (checkObject(req.body) || checkObject(req.query) || checkObject(req.params)) {
      this.trackSuspiciousIP(req.ip, 'xss_attempt');
      return res.status(400).json({
        success: false,
        message: 'Invalid input detected',
        errorCode: 'INVALID_INPUT'
      });
    }

    next();
  };

  // File upload security middleware
  validateFileUpload = (allowedTypes = [], maxSize = 5 * 1024 * 1024) => {
    return (req, res, next) => {
      if (!req.file && !req.files) {
        return next();
      }

      const files = req.files || [req.file];
      
      for (const file of files) {
        // Check file type
        if (allowedTypes.length > 0 && !allowedTypes.includes(file.mimetype)) {
          this.trackSuspiciousIP(req.ip, 'invalid_file_type');
          return res.status(400).json({
            success: false,
            message: 'Invalid file type',
            errorCode: 'INVALID_FILE_TYPE'
          });
        }

        // Check file size
        if (file.size > maxSize) {
          this.trackSuspiciousIP(req.ip, 'file_too_large');
          return res.status(400).json({
            success: false,
            message: 'File size too large',
            errorCode: 'FILE_TOO_LARGE'
          });
        }

        // Check file extension
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'];
        const fileExtension = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));
        if (!allowedExtensions.includes(fileExtension)) {
          this.trackSuspiciousIP(req.ip, 'invalid_file_extension');
          return res.status(400).json({
            success: false,
            message: 'Invalid file extension',
            errorCode: 'INVALID_FILE_EXTENSION'
          });
        }
      }

      next();
    };
  };

  // Request size limiting middleware
  limitRequestSize = (maxSize = 10 * 1024 * 1024) => {
    return (req, res, next) => {
      const contentLength = parseInt(req.get('Content-Length') || '0');
      
      if (contentLength > maxSize) {
        this.trackSuspiciousIP(req.ip, 'request_too_large');
        return res.status(413).json({
          success: false,
          message: 'Request entity too large',
          errorCode: 'REQUEST_TOO_LARGE'
        });
      }

      next();
    };
  };

  // Security headers middleware
  addSecurityHeaders = (req, res, next) => {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    
    // Remove server information
    res.removeHeader('X-Powered-By');
    
    next();
  };

  // Session security middleware
  validateSession = (req, res, next) => {
    if (!req.user) {
      return next();
    }

    // Check if user account is still active
    if (req.user.accountStatus && req.user.accountStatus !== 'active') {
      return res.status(401).json({
        success: false,
        message: 'Account is not active',
        errorCode: 'ACCOUNT_INACTIVE'
      });
    }

    // Check session timeout for admin users
    if (req.isAdmin && req.user.lastActivity) {
      const sessionTimeout = 24 * 60 * 60 * 1000; // 24 hours
      if ((Date.now() - req.user.lastActivity.getTime()) > sessionTimeout) {
        return res.status(401).json({
          success: false,
          message: 'Session expired',
          errorCode: 'SESSION_EXPIRED'
        });
      }
    }

    next();
  };

  // Audit logging middleware
  auditLog = (action, level = 'info') => {
    return (req, res, next) => {
      const originalSend = res.send;
      
      res.send = function(data) {
        const auditData = {
          timestamp: new Date(),
          action,
          level,
          method: req.method,
          url: req.originalUrl,
          ip: req.ip,
          userAgent: req.get('User-Agent'),
          userId: req.user?._id,
          userRole: req.user?.role,
          statusCode: res.statusCode,
          success: data?.success || false,
          requestBody: req.body,
          requestQuery: req.query,
          requestParams: req.params,
          responseSize: JSON.stringify(data).length,
          processingTime: Date.now() - req.startTime
        };

        logger.info(`AUDIT [${level.toUpperCase()}]`, { audit: auditData });

        // In production, you'd want to store this in a secure audit log
        // await auditService.logAction(auditData);

        originalSend.call(this, data);
      };
      
      // Add start time for processing time calculation
      req.startTime = Date.now();
      next();
    };
  };

  // Get security statistics
  getSecurityStats() {
    return {
      suspiciousIPs: this.suspiciousIPs.size,
      blockedIPs: this.blockedIPs.size,
      totalSuspiciousActivities: Array.from(this.suspiciousIPs.values())
        .reduce((sum, record) => sum + record.count, 0)
    };
  }

  // Clear old security records
  cleanupOldRecords(maxAge = 24 * 60 * 60 * 1000) { // 24 hours
    const cutoffTime = Date.now() - maxAge;
    
    // Clean up old suspicious IP records
    for (const [ip, record] of this.suspiciousIPs.entries()) {
      if (record.lastSeen < cutoffTime) {
        this.suspiciousIPs.delete(ip);
      }
    }

    // Clean up old blocked IPs (allow them to try again)
    this.blockedIPs.clear();
  }
}

// Create singleton instance
const enhancedSecurity = new EnhancedSecurityMiddleware();

// Clean up old records every hour
const _cleanupInterval = setInterval(() => {
  enhancedSecurity.cleanupOldRecords();
}, 60 * 60 * 1000);
_cleanupInterval.unref();

module.exports = enhancedSecurity;
