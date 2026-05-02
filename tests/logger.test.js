/**
 * Unit tests for structured logger
 */

describe('Logger', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      MONGO_URI: 'mongodb://test:27017/test',
      JWT_SECRET: 'test-secret-12345678901234567890',
      PORT: '5000',
      RAZORPAY_KEY_ID: 'rzp_test_abc',
      RAZORPAY_KEY_SECRET: 'secret123',
      FRONTEND_URL: 'http://localhost:3000',
      NODE_ENV: 'test',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('logger exports logger and requestLogger', () => {
    const mod = require('../config/logger');
    expect(mod.logger).toBeDefined();
    expect(mod.requestLogger).toBeDefined();
    expect(typeof mod.logger.info).toBe('function');
    expect(typeof mod.logger.error).toBe('function');
    expect(typeof mod.logger.warn).toBe('function');
    expect(typeof mod.requestLogger).toBe('function');
  });

  test('logger does not throw on info/warn/error calls', () => {
    const { logger } = require('../config/logger');
    expect(() => logger.info('test info')).not.toThrow();
    expect(() => logger.warn('test warn')).not.toThrow();
    expect(() => logger.error('test error')).not.toThrow();
  });

  test('requestLogger calls next()', () => {
    const { requestLogger } = require('../config/logger');
    const mockReq = {
      method: 'GET',
      originalUrl: '/test',
      ip: '127.0.0.1',
    };
    const mockRes = {
      on: jest.fn(),
      statusCode: 200,
    };
    const mockNext = jest.fn();

    requestLogger(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRes.on).toHaveBeenCalledWith('finish', expect.any(Function));
  });
});
