/**
 * Unit tests for config layer and env validation
 */

// Mock dotenv so it doesn't load the real .env file during tests
jest.mock('dotenv', () => ({ config: jest.fn() }));

describe('Config Layer', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    // Start with a clean env — only keep system vars
    process.env = {
      PATH: originalEnv.PATH,
      NODE_ENV: 'test',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('validateEnv exits if required env vars are missing', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { validateEnv } = require('../config/index');

    expect(() => {
      validateEnv();
    }).toThrow('process.exit called');

    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
    mockConsoleError.mockRestore();
    mockConsoleWarn.mockRestore();
  });

  test('config loads correct values from env', () => {
    process.env.MONGO_URI = 'mongodb://test:27017/test';
    process.env.JWT_SECRET = 'test-secret-12345678901234567890';
    process.env.PORT = '4000';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
    process.env.RAZORPAY_KEY_SECRET = 'secret123';
    process.env.FRONTEND_URL = 'http://localhost:3000';
    process.env.NODE_ENV = 'test';

    const { config, validateEnv } = require('../config/index');
    // Should not throw since all required vars are present
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    validateEnv();
    expect(mockExit).not.toHaveBeenCalled();
    mockExit.mockRestore();
    mockConsoleWarn.mockRestore();

    expect(config.port).toBe(4000);
    expect(config.mongoUri).toBe('mongodb://test:27017/test');
    expect(config.jwtSecret).toBe('test-secret-12345678901234567890');
    expect(config.razorpay.keyId).toBe('rzp_test_abc');
    expect(config.frontendUrl).toBe('http://localhost:3000');
    expect(config.isTest).toBe(true);
    expect(config.isProduction).toBe(false);
  });

  test('config parses ALLOWED_ORIGINS correctly', () => {
    process.env.MONGO_URI = 'mongodb://test:27017/test';
    process.env.JWT_SECRET = 'test-secret-12345678901234567890';
    process.env.PORT = '5000';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
    process.env.RAZORPAY_KEY_SECRET = 'secret123';
    process.env.FRONTEND_URL = 'http://localhost:3000';
    process.env.ALLOWED_ORIGINS = 'http://a.com, http://b.com ,http://c.com';

    const { config } = require('../config/index');

    expect(config.allowedOrigins).toEqual(['http://a.com', 'http://b.com', 'http://c.com']);
  });

  test('config defaults port to 5000 when PORT is NaN', () => {
    process.env.MONGO_URI = 'mongodb://test:27017/test';
    process.env.JWT_SECRET = 'test-secret-12345678901234567890';
    process.env.PORT = 'not-a-number';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
    process.env.RAZORPAY_KEY_SECRET = 'secret123';
    process.env.FRONTEND_URL = 'http://localhost:3000';

    const { config } = require('../config/index');

    // parseInt('not-a-number') is NaN, || 5000 gives 5000
    expect(config.port).toBe(5000);
  });
});
