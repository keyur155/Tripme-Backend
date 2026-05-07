/**
 * Centralized Configuration Module
 * Loads environment-specific config and validates required env vars at startup.
 */
require('dotenv').config();

const path = require('path');

const ENV = process.env.NODE_ENV || 'development';

// ── Required environment variables (fail-fast if missing) ──────────────────
const REQUIRED_ENV_VARS = [
  'MONGO_URI',
  'JWT_SECRET',
  'PORT',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'FRONTEND_URL',
];

const OPTIONAL_ENV_VARS = [
  'RAZORPAY_WEBHOOK_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'REDIS_URL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'FIREBASE_SERVICE_ACCOUNT',
  'ALLOWED_ORIGINS',
  'ADMIN_IP_WHITELIST',
  'JWT_EXPIRES_IN',
  'JWT_REFRESH_EXPIRES_IN',
];

function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    const msg = `Missing required environment variables: ${missing.join(', ')}`;
    console.error(`❌ ${msg}`);
    console.error('Please set them in your .env file or hosting provider.');
    process.exit(1);
  }

  const warnings = OPTIONAL_ENV_VARS.filter((key) => !process.env[key]);
  if (warnings.length > 0) {
    console.warn(`⚠️  Optional env vars not set: ${warnings.join(', ')}`);
  }
}

// ── Environment-specific overrides ─────────────────────────────────────────
const envConfigs = {
  development: {
    logLevel: 'debug',
    rateLimitMultiplier: 5, // more lenient in dev
    corsAllowAll: false,
    trustProxy: 1,
  },
  production: {
    logLevel: 'warn',
    rateLimitMultiplier: 1,
    corsAllowAll: false,
    trustProxy: 1,
  },
  staging: {
    logLevel: 'info',
    rateLimitMultiplier: 2,
    corsAllowAll: false,
    trustProxy: 1,
  },
  test: {
    logLevel: 'error',
    rateLimitMultiplier: 100,
    corsAllowAll: true,
    trustProxy: 0,
  },
};

const envOverrides = envConfigs[ENV] || envConfigs.development;

// ── Shared configuration object ────────────────────────────────────────────
const config = {
  env: ENV,
  isProduction: ENV === 'production',
  isDevelopment: ENV === 'development',
  isTest: ENV === 'test',

  // Server
  port: parseInt(process.env.PORT, 10) || 5000,
  trustProxy: envOverrides.trustProxy,

  // Database
  mongoUri: process.env.MONGO_URI,

  // JWT
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',

  // Razorpay
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  },

  // Stripe
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },

  // PayPal
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  },

  // Cloudinary
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },

  // Redis
  redisUrl: process.env.REDIS_URL,

  // Email (SMTP)
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },

  // Twilio
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER,
  },

  // AWS
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'ap-south-1',
  },

  // Google
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
  },

  // CORS
  frontendUrl: process.env.FRONTEND_URL,
  allowedOrigins: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
    : [],
  adminIpWhitelist: process.env.ADMIN_IP_WHITELIST
    ? process.env.ADMIN_IP_WHITELIST.split(',').map((s) => s.trim())
    : [],

  // Logging
  logLevel: envOverrides.logLevel,

  // Rate limiting
  rateLimitMultiplier: envOverrides.rateLimitMultiplier,

  // Request limits
  maxRequestSize: '10mb',
  maxFileSize: 5 * 1024 * 1024, // 5 MB
  allowedFileTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'],

  // Session / Security
  sessionTimeout: 24 * 60 * 60 * 1000, // 24 hours
  maxFailedLoginAttempts: 5,
  lockoutDuration: 30 * 60 * 1000, // 30 minutes

  // Cleanup intervals (ms)
  cleanupIntervalMs: 3 * 60 * 1000,       // 3 minutes
  reconciliationIntervalMs: 12 * 60 * 1000, // 12 minutes
};

module.exports = { config, validateEnv };
