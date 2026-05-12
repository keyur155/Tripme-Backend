// ──────────────────────────────────────────────────────────
// TripMe Backend — Production-Ready Server
// ──────────────────────────────────────────────────────────
const { config, validateEnv } = require('./config/index');
const { logger, requestLogger } = require('./config/logger');

// Fail fast if required env vars are missing
validateEnv();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const razorpayService = require('./services/razorpay.service');
const { createHelmet, createRateLimiters, securityConfig } = require('./config/security.config');
const { runReconciliation } = require('./services/paymentReconciliation.service');

const app = express();

// Trust reverse proxy (Railway, Render, etc.)
app.set('trust proxy', config.trustProxy);

// ── Security middleware ────────────────────────────────────
app.use(createHelmet());
app.use(compression());

// ── CORS ───────────────────────────────────────────────────
const normalizeOrigin = (url) => {
  if (!url) return null;
  let normalized = url.trim().replace(/\/+$/, '');
  if (!normalized.match(/^https?:\/\//)) {
    normalized = `https://${normalized}`;
  }
  return normalized;
};

const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [];

    if (config.frontendUrl) {
      const urls = config.frontendUrl.split(',')
        .map(url => normalizeOrigin(url))
        .filter(Boolean);
      allowedOrigins.push(...urls);
    }

    if (config.allowedOrigins.length > 0) {
      const additional = config.allowedOrigins
        .map(url => normalizeOrigin(url))
        .filter(Boolean);
      allowedOrigins.push(...additional);
    }

    // In production, reject requests with no origin except for webhooks/health checks
    // (those are handled by separate routes that don't go through CORS)
    if (!origin) {
      if (config.nodeEnv === 'production') {
        return callback(null, false);
      }
      return callback(null, true);
    }

    const normalizedOrigin = normalizeOrigin(origin);
    const isAllowed = allowedOrigins.some(allowed => {
      const norm = normalizeOrigin(allowed);
      return norm && norm.toLowerCase() === normalizedOrigin.toLowerCase();
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      logger.warn('CORS blocked origin', { origin });
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
};

app.use(cors(corsOptions));

// ── Body parsing ───────────────────────────────────────────
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    // Preserve raw body for webhook signature verification
    if (req.originalUrl && req.originalUrl.startsWith('/api/payments/webhook/')) {
      req.rawBody = buf.toString('utf8');
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── NoSQL Injection Sanitization ──────────────────────────
const { mongoSanitize } = require('./middlewares/sanitize.middleware');
app.use(mongoSanitize);

// ── Pagination Enforcement ────────────────────────────────
const { enforcePagination } = require('./middlewares/pagination.middleware');
app.use(enforcePagination);

// ── Rate limiting ──────────────────────────────────────────
const rateLimiters = createRateLimiters();
app.use('/api/admin', rateLimiters.adminAPI);
app.use('/api/auth', rateLimiters.login);

// ── Request logging ────────────────────────────────────────
app.use(requestLogger);

// ── Health & root endpoints ────────────────────────────────
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'TripMe Backend API'
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// ── Public API endpoints ───────────────────────────────────
app.get('/api/public/platform-fee', async (req, res) => {
  try {
    const PricingConfig = require('./models/PricingConfig');
    const currentRate = await PricingConfig.getCurrentPlatformFeeRate();
    res.status(200).json({
      success: true,
      data: {
        platformFeeRate: currentRate,
        platformFeePercentage: (currentRate * 100).toFixed(1),
        lastUpdated: new Date()
      }
    });
  } catch (error) {
    logger.error('Error fetching platform fee rate', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch platform fee rate' });
  }
});

// ── Test email endpoint (for debugging — remove in production) ──
app.post('/api/test-email', async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) {
      return res.status(400).json({ success: false, message: 'Missing "to" field' });
    }

    logger.info('Test email requested', { to });

    console.log('📧 ═══════════════════════════════════════');
    console.log('📧 TEST EMAIL ENDPOINT HIT');
    console.log('📧 RESEND_API_KEY set:', !!process.env.RESEND_API_KEY);
    console.log('📧 RESEND_FROM:', process.env.RESEND_FROM || '(not set, using default)');
    console.log('📧 SMTP_HOST:', process.env.SMTP_HOST || '(not set)');
    console.log('📧 ═══════════════════════════════════════');

    const { sendEmail } = require('./utils/sendEmail');
    const result = await sendEmail(to, 'welcome', {
      userName: 'Test User',
      link: 'https://tripmeglobal.com/auth/verify-email?token=test-token-12345'
    });

    console.log('📧 sendEmail result:', JSON.stringify(result));

    res.status(200).json({
      success: true,
      message: `Test email sent to ${to}`,
      result,
      config: {
        resendKeySet: !!process.env.RESEND_API_KEY,
        resendFrom: process.env.RESEND_FROM || '(default: onboarding@resend.dev)',
        smtpHost: process.env.SMTP_HOST || '(not set)',
      }
    });
  } catch (error) {
    console.error('📧 ❌ Test email error:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      config: {
        resendKeySet: !!process.env.RESEND_API_KEY,
        resendFrom: process.env.RESEND_FROM || '(default: onboarding@resend.dev)',
        smtpHost: process.env.SMTP_HOST || '(not set)',
      }
    });
  }
});

// ── Swagger / OpenAPI docs ─────────────────────────────────
const { setupSwagger } = require('./config/swagger');
setupSwagger(app);

// ── API Routes ─────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/kyc', require('./routes/kyc.routes'));
app.use('/api/host', require('./routes/host.routes'));
app.use('/api/listings', require('./routes/listing.routes'));
app.use('/api/bookings', require('./routes/booking.routes'));
app.use('/api/users', require('./routes/user.routes'));
app.use('/api/services', require('./routes/service.routes'));
app.use('/api/stories', require('./routes/story.routes'));
app.use('/api/payments', require('./routes/payment.routes'));
app.use('/api/payouts', require('./routes/payout.routes'));
app.use('/api/reviews', require('./routes/review.routes'));
app.use('/api/wishlist', require('./routes/wishlist.routes'));
app.use('/api/notifications', require('./routes/notification.routes'));
app.use('/api/coupons', require('./routes/coupon.routes'));
app.use('/api/support', require('./routes/support.routes'));
app.use('/api/upload', require('./routes/upload.routes'));
app.use('/api/availability', require('./routes/availability.routes'));
app.use('/api/pricing', require('./routes/pricing.routes'));
app.use('/api/email-subscription', require('./routes/emailSubscription.routes'));
app.use('/api/popular-destinations', require('./routes/popularDestination.routes'));

// ── Error handling ─────────────────────────────────────────
const { errorHandler, notFound } = require('./middlewares/error.middleware');
app.use(notFound);
app.use(errorHandler);

// ── Background jobs (store refs for graceful shutdown) ─────
const _intervals = [];
const _timeouts = [];

async function startBackgroundJobs() {
  const bookingController = require('./controllers/booking.controller');
  const availabilityController = require('./controllers/availability.controller');

  // Cleanup expired blocked bookings every 3 minutes
  _intervals.push(
    setInterval(async () => {
      try {
        await bookingController.cleanupExpiredBlockedBookings();
        await availabilityController.cleanupExpiredBlockedAvailability();
      } catch (error) {
        logger.error('Error in periodic cleanup', { error: error.message });
      }
    }, config.cleanupIntervalMs)
  );

  // Payment reconciliation every 12 minutes
  _intervals.push(
    setInterval(async () => {
      try {
        await runReconciliation();
      } catch (error) {
        logger.error('Error in reconciliation cron', { error: error.message });
      }
    }, config.reconciliationIntervalMs)
  );

  // Startup cleanup (after DB connects)
  _timeouts.push(
    setTimeout(async () => {
      try {
        logger.info('Running startup cleanup...');
        await bookingController.cleanupExpiredBlockedBookings();
        await availabilityController.cleanupExpiredBlockedAvailability();
      } catch (error) {
        logger.error('Error in startup cleanup', { error: error.message });
      }
    }, 5000)
  );

  // Startup reconciliation (after 30s to let DB connect)
  _timeouts.push(
    setTimeout(async () => {
      try {
        logger.info('Running startup payment reconciliation...');
        await runReconciliation();
      } catch (error) {
        logger.error('Error in startup reconciliation', { error: error.message });
      }
    }, 30000)
  );
}

// ── Graceful shutdown ──────────────────────────────────────
let server;

async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  // Clear all intervals and timeouts
  _intervals.forEach(clearInterval);
  _timeouts.forEach(clearTimeout);

  // Close HTTP server (stop accepting new connections)
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
    });
  }

  // Close database connection
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  } catch (err) {
    logger.error('Error closing MongoDB connection', { error: err.message });
  }

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Could not close connections in time, forcing shutdown');
    process.exit(1);
  }, 10000).unref();

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Global error handlers ──────────────────────────────────
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled Promise Rejection', { error: err.message, stack: err.stack });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
  // Uncaught exceptions leave the process in an undefined state — exit
  gracefulShutdown('uncaughtException');
});

// ── Bootstrap ──────────────────────────────────────────────
async function startServer() {
  try {
    // Connect to database
    await connectDB();

    // Initialize Razorpay
    razorpayService.initializeRazorpay();
    logger.info('Razorpay initialized', { ready: razorpayService.isInitialized() });

    // Start background jobs
    startBackgroundJobs();

    // Start HTTP server
    server = app.listen(config.port, '0.0.0.0', () => {
      logger.info(`TripMe Backend running on port ${config.port}`, {
        env: config.env,
        port: config.port,
      });
    });
  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
}

startServer();
