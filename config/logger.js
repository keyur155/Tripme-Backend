/**
 * Structured Logger (Winston)
 * - JSON format in production, colorized in development
 * - Never logs sensitive data (passwords, tokens, secrets)
 * - Request timing built in
 */
const winston = require('winston');
const { config } = require('./index');

const SENSITIVE_KEYS = new Set([
  'password', 'token', 'secret', 'authorization', 'cookie',
  'creditCard', 'cardNumber', 'cvv', 'ssn', 'apiKey',
  'razorpayKeySecret', 'jwtSecret', 'refreshToken',
  'key_secret', 'api_secret', 'RAZORPAY_KEY_SECRET',
]);

function redactSensitive(obj, depth = 0) {
  if (depth > 5 || !obj || typeof obj !== 'object') return obj;
  const redacted = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitive(value, depth + 1);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

const redactFormat = winston.format((info) => {
  if (info.meta && typeof info.meta === 'object') {
    info.meta = redactSensitive(info.meta);
  }
  return info;
});

const logger = winston.createLogger({
  level: config.logLevel || 'info',
  defaultMeta: { service: 'tripme-api' },
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    config.isProduction
      ? winston.format.json()
      : winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
            return `${timestamp} [${level}] ${message}${metaStr}`;
          })
        )
  ),
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
    }),
  ],
  // Prevent winston from crashing the process
  exitOnError: false,
});

// Add file transport in production
if (config.isProduction) {
  logger.add(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
    })
  );
  logger.add(
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    })
  );
}

/**
 * Express middleware: logs every request with timing.
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  const { method, originalUrl, ip } = req;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](`${method} ${originalUrl} ${res.statusCode} ${duration}ms`, {
      method,
      url: originalUrl,
      status: res.statusCode,
      duration,
      ip,
    });
  });

  next();
}

module.exports = { logger, requestLogger };
