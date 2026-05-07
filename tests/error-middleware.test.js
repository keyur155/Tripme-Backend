/**
 * Unit tests for error handling middleware
 */

// Set required env vars before importing anything
process.env.MONGO_URI = 'mongodb://test:27017/test';
process.env.JWT_SECRET = 'test-secret-12345678901234567890';
process.env.PORT = '5000';
process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
process.env.RAZORPAY_KEY_SECRET = 'secret123';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.NODE_ENV = 'test';

const {
  errorHandler,
  notFound,
  asyncHandler,
  validationErrorHandler,
  timeoutHandler,
} = require('../middlewares/error.middleware');

function mockRes() {
  const res = {
    statusCode: 200,
    _json: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res._json = data;
      return res;
    },
    on: jest.fn(),
  };
  return res;
}

function mockReq(overrides = {}) {
  return {
    method: 'GET',
    url: '/test',
    originalUrl: '/test',
    ip: '127.0.0.1',
    get: jest.fn(() => 'test-agent'),
    user: null,
    ...overrides,
  };
}

describe('errorHandler', () => {
  test('returns 500 for generic errors', () => {
    const err = new Error('Something broke');
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    errorHandler(err, req, res, next);

    expect(res.statusCode).toBe(500);
    expect(res._json.success).toBe(false);
    expect(res._json.message).toBe('Something broke');
  });

  test('returns 404 for CastError', () => {
    const err = new Error('Cast failed');
    err.name = 'CastError';
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.statusCode).toBe(404);
    expect(res._json.message).toBe('Resource not found');
  });

  test('returns 400 for duplicate key error', () => {
    const err = new Error('Duplicate');
    err.code = 11000;
    err.keyValue = { email: 'test@test.com' };
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res._json.message).toContain('Duplicate field value: email');
  });

  test('returns 400 for ValidationError', () => {
    const err = new Error('Validation failed');
    err.name = 'ValidationError';
    err.errors = {
      name: { message: 'Name is required' },
      email: { message: 'Email is required' },
    };
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res._json.message).toContain('Name is required');
  });

  test('returns 401 for JWT errors', () => {
    const err = new Error('jwt malformed');
    err.name = 'JsonWebTokenError';
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.statusCode).toBe(401);
    expect(res._json.message).toBe('Invalid token');
  });

  test('returns 401 for expired tokens', () => {
    const err = new Error('jwt expired');
    err.name = 'TokenExpiredError';
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.statusCode).toBe(401);
    expect(res._json.message).toBe('Token expired');
  });

  test('returns 429 for rate limit errors', () => {
    const err = new Error('Rate limited');
    err.status = 429;
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.statusCode).toBe(429);
  });

  test('does not expose stack in production', () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const err = new Error('secret error');
    const req = mockReq();
    const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res._json.stack).toBeUndefined();
    process.env.NODE_ENV = origEnv;
  });
});

describe('notFound', () => {
  test('creates 404 error and calls next', () => {
    const req = mockReq({ originalUrl: '/api/nonexistent' });
    const res = mockRes();
    const next = jest.fn();

    notFound(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(404);
    expect(err.message).toContain('/api/nonexistent');
  });
});

describe('asyncHandler', () => {
  test('passes resolved value through', async () => {
    const handler = asyncHandler(async (req, res) => {
      res.json({ ok: true });
    });

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await handler(req, res, next);
    expect(res._json).toEqual({ ok: true });
    expect(next).not.toHaveBeenCalled();
  });

  test('catches rejected promise and calls next with error', async () => {
    const handler = asyncHandler(async () => {
      throw new Error('async fail');
    });

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await handler(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].message).toBe('async fail');
  });
});

describe('validationErrorHandler', () => {
  test('handles Joi errors with structured response', () => {
    const err = {
      isJoi: true,
      details: [
        { path: ['email'], message: '"email" is required' },
        { path: ['password'], message: '"password" must be at least 8 chars' },
      ],
    };
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    validationErrorHandler(err, req, res, next);

    expect(res.statusCode).toBe(400);
    expect(res._json.success).toBe(false);
    expect(res._json.errors).toHaveLength(2);
    expect(next).not.toHaveBeenCalled();
  });

  test('passes non-Joi errors to next', () => {
    const err = new Error('not joi');
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    validationErrorHandler(err, req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('timeoutHandler', () => {
  test('calls next immediately', () => {
    const middleware = timeoutHandler(5000);
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
