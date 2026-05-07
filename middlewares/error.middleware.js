const { logger } = require('../config/logger');

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Log error (never log sensitive fields like body/headers)
  logger.error('Request error', {
    message: err.message,
    url: req.url,
    method: req.method,
    ip: req.ip,
    statusCode: error.statusCode || 500,
  });

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    const message = 'Resource not found';
    error = { message, statusCode: 404 };
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    const message = `Duplicate field value: ${field}. Please use another value.`;
    error = { message, statusCode: 400 };
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map(val => val.message).join(', ');
    error = { message, statusCode: 400 };
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    const message = 'Invalid token';
    error = { message, statusCode: 401 };
  }

  if (err.name === 'TokenExpiredError') {
    const message = 'Token expired';
    error = { message, statusCode: 401 };
  }

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    const message = 'File too large';
    error = { message, statusCode: 400 };
  }

  if (err.code === 'LIMIT_FILE_COUNT') {
    const message = 'Too many files';
    error = { message, statusCode: 400 };
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    const message = 'Unexpected file field';
    error = { message, statusCode: 400 };
  }

  // Rate limiting errors
  if (err.status === 429) {
    const message = 'Too many requests. Please try again later.';
    error = { message, statusCode: 429 };
  }

  // Network errors
  if (err.code === 'ECONNREFUSED') {
    const message = 'Service temporarily unavailable';
    error = { message, statusCode: 503 };
  }

  if (err.code === 'ETIMEDOUT') {
    const message = 'Request timeout';
    error = { message, statusCode: 408 };
  }

  // Default error
  const statusCode = error.statusCode || 500;
  const message = error.message || 'Server Error';

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

// 404 handler for undefined routes
const notFound = (req, res, next) => {
  const error = new Error(`Route ${req.originalUrl} not found`);
  error.statusCode = 404;
  next(error);
};

// Async error wrapper
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Validation error handler
const validationErrorHandler = (err, req, res, next) => {
  if (err.isJoi) {
    const message = err.details.map(detail => detail.message).join(', ');
    return res.status(400).json({
      success: false,
      message: `Validation error: ${message}`,
      errors: err.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }))
    });
  }
  next(err);
};

// Database connection error handler
const dbErrorHandler = (err, req, res, next) => {
  if (err.name === 'MongoError' || err.name === 'MongooseError') {
    logger.error('Database error', { error: err.message });
    return res.status(503).json({
      success: false,
      message: 'Database service temporarily unavailable. Please try again later.'
    });
  }
  next(err);
};

// Security error handler
const securityErrorHandler = (err, req, res, next) => {
  // Handle potential security issues
  if (err.message && err.message.includes('SQL injection')) {
    logger.warn('Potential SQL injection attempt', { ip: req.ip, url: req.url });
    return res.status(400).json({
      success: false,
      message: 'Invalid request'
    });
  }
  next(err);
};

// Request timeout handler
const timeoutHandler = (timeout = 30000) => {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      res.status(408).json({
        success: false,
        message: 'Request timeout'
      });
    }, timeout);

    res.on('finish', () => {
      clearTimeout(timer);
    });

    next();
  };
};

// Error logging middleware (never logs sensitive data like headers/body)
const errorLogger = (err, req, res, next) => {
  logger.error('Detailed error', {
    name: err.name,
    message: err.message,
    method: req.method,
    url: req.url,
    ip: req.ip,
    userId: req.user?.id || null,
    userRole: req.user?.role || null,
  });

  next(err);
};

// NOTE: gracefulShutdown is now handled in server.js

module.exports = {
  errorHandler,
  notFound,
  asyncHandler,
  validationErrorHandler,
  dbErrorHandler,
  securityErrorHandler,
  timeoutHandler,
  errorLogger,
};
