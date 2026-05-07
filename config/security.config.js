const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Security configuration
const securityConfig = {
  // Rate limiting configurations
  rateLimits: {
    // General admin API rate limit
    adminAPI: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 200,
      message: {
        success: false,
        message: 'Too many requests from this IP, please try again later.'
      },
      standardHeaders: true,
      legacyHeaders: false,
    },
    
    // Sensitive operations rate limit
    sensitiveOperations: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 20, // limit each IP to 20 requests per windowMs
      message: {
        success: false,
        message: 'Too many sensitive operations from this IP, please try again later.'
      },
      standardHeaders: true,
      legacyHeaders: false,
    },
    
    // Login rate limit
    login: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 10, // limit each IP to 10 auth attempts per window
      message: {
        success: false,
        message: 'Too many login attempts, please try again later.'
      },
      standardHeaders: true,
      legacyHeaders: false,
    }
  },

  // Helmet security headers configuration
  helmet: {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: (() => {
          const sources = ["'self'"];
          
          // Helper to normalize URLs for CSP (remove trailing slashes, ensure valid format)
          const normalizeCSPUrl = (url) => {
            if (!url || typeof url !== 'string') return null;
            let normalized = url.trim().replace(/\/+$/, ''); // Remove trailing slashes
            // CSP needs full URLs with protocol
            if (!normalized.match(/^https?:\/\//)) {
              normalized = `https://${normalized}`;
            }
            // Basic validation - must be a valid URL format
            if (normalized.match(/^https?:\/\/[^\s]+$/)) {
              return normalized;
            }
            return null;
          };
          
          // Add FRONTEND_URL if set (handle comma-separated)
          if (process.env.FRONTEND_URL) {
            const urls = process.env.FRONTEND_URL.split(',')
              .map(normalizeCSPUrl)
              .filter(url => url);
            sources.push(...urls);
          }
          
          // Add ALLOWED_ORIGINS if set
          if (process.env.ALLOWED_ORIGINS) {
            const urls = process.env.ALLOWED_ORIGINS.split(',')
              .map(normalizeCSPUrl)
              .filter(url => url);
            sources.push(...urls);
          }
          
          return sources;
        })(),
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  },

  // CORS configuration
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['X-Total-Count', 'X-Page-Count'],
  },

  // Session configuration
  session: {
    timeout: 24 * 60 * 60 * 1000, // 24 hours
    maxSessions: 5, // Maximum active sessions per admin
    inactivityTimeout: 30 * 60 * 1000, // 30 minutes of inactivity
  },

  // Password policy
  passwordPolicy: {
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
    requireSpecialChars: true,
    maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
  },

  // Account lockout policy
  lockoutPolicy: {
    maxFailedAttempts: 5,
    lockoutDuration: 30 * 60 * 1000, // 30 minutes
    resetAfter: 24 * 60 * 60 * 1000, // 24 hours
  },

  // IP whitelist (for production)
  ipWhitelist: process.env.ADMIN_IP_WHITELIST ? 
    process.env.ADMIN_IP_WHITELIST.split(',') : [],

  // Audit logging configuration
  audit: {
    enabled: true,
    logLevel: 'info',
    sensitiveOperations: [
      'admin_login',
      'verify_kyc',
      'approve_property',
      'approve_host',
      'reject_host',
      'process_manual_payout',
      'update_user_status',
      'update_admin_profile'
    ],
    excludePaths: [
      '/api/admin/dashboard',
      '/api/admin/analytics'
    ]
  },

  // Two-factor authentication
  twoFactor: {
    enabled: true,
    requiredForSensitiveOperations: true,
    backupCodes: 10,
  },

  // Request validation
  validation: {
    maxRequestSize: 10 * 1024 * 1024, // 10MB
    allowedFileTypes: ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'],
    maxFileSize: 5 * 1024 * 1024, // 5MB
  },

  // Security headers
  headers: {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  }
};

// Create rate limiters
const createRateLimiters = () => {
  return {
    adminAPI: rateLimit(securityConfig.rateLimits.adminAPI),
    sensitiveOperations: rateLimit(securityConfig.rateLimits.sensitiveOperations),
    login: rateLimit(securityConfig.rateLimits.login),
  };
};

// Create helmet instance
const createHelmet = () => {
  return helmet(securityConfig.helmet);
};

// Password validation function
const validatePassword = (password) => {
  const { passwordPolicy } = securityConfig;
  
  if (password.length < passwordPolicy.minLength) {
    return { valid: false, message: `Password must be at least ${passwordPolicy.minLength} characters long` };
  }
  
  if (passwordPolicy.requireUppercase && !/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one uppercase letter' };
  }
  
  if (passwordPolicy.requireLowercase && !/[a-z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one lowercase letter' };
  }
  
  if (passwordPolicy.requireNumbers && !/\d/.test(password)) {
    return { valid: false, message: 'Password must contain at least one number' };
  }
  
  if (passwordPolicy.requireSpecialChars && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one special character' };
  }
  
  return { valid: true };
};

// IP validation function
const validateIP = (ip) => {
  if (securityConfig.ipWhitelist.length === 0) {
    return true; // No whitelist configured
  }
  return securityConfig.ipWhitelist.includes(ip);
};

// Check if operation is sensitive
const isSensitiveOperation = (action) => {
  return securityConfig.audit.sensitiveOperations.includes(action);
};

module.exports = {
  securityConfig,
  createRateLimiters,
  createHelmet,
  validatePassword,
  validateIP,
  isSensitiveOperation
}; 