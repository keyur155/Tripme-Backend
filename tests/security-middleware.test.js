/**
 * Unit tests for security middleware
 */

process.env.MONGO_URI = 'mongodb://test:27017/test';
process.env.JWT_SECRET = 'test-secret-12345678901234567890';
process.env.PORT = '5000';
process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
process.env.RAZORPAY_KEY_SECRET = 'secret123';
process.env.FRONTEND_URL = 'https://app.tripme.com';
process.env.ALLOWED_ORIGINS = 'https://admin.tripme.com';
process.env.NODE_ENV = 'production';

const { securityMiddleware } = require('../middlewares/security.middleware');

function mockRes() {
  const res = {
    statusCode: 200,
    _json: null,
    status(code) { res.statusCode = code; return res; },
    json(data) { res._json = data; return res; },
  };
  return res;
}

function mockReq(overrides = {}) {
  return {
    method: 'POST',
    get: jest.fn((header) => {
      const headers = overrides.headers || {};
      return headers[header] || null;
    }),
    user: overrides.user || null,
    header: jest.fn(),
    ...overrides,
  };
}

describe('securityMiddleware.validateOrigin', () => {
  test('allows GET requests without origin check', () => {
    const req = mockReq({ method: 'GET' });
    const res = mockRes();
    const next = jest.fn();

    securityMiddleware.validateOrigin(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('allows POST from configured FRONTEND_URL', () => {
    const req = mockReq({
      method: 'POST',
      headers: { Origin: 'https://app.tripme.com' },
    });
    const res = mockRes();
    const next = jest.fn();

    securityMiddleware.validateOrigin(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('allows POST from configured ALLOWED_ORIGINS', () => {
    const req = mockReq({
      method: 'POST',
      headers: { Origin: 'https://admin.tripme.com' },
    });
    const res = mockRes();
    const next = jest.fn();

    securityMiddleware.validateOrigin(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('blocks POST from unknown origin when no user token', () => {
    const req = mockReq({
      method: 'POST',
      headers: { Origin: 'https://evil.com' },
    });
    const res = mockRes();
    const next = jest.fn();

    securityMiddleware.validateOrigin(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res._json.message).toBe('Invalid request origin');
  });

  test('allows POST from unknown origin if user is authenticated', () => {
    const req = mockReq({
      method: 'POST',
      headers: { Origin: 'https://unknown.com' },
      user: { _id: 'user123', role: 'guest' },
    });
    const res = mockRes();
    const next = jest.fn();

    securityMiddleware.validateOrigin(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('does NOT allow localhost in production', () => {
    const req = mockReq({
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
    });
    const res = mockRes();
    const next = jest.fn();

    securityMiddleware.validateOrigin(req, res, next);
    // In production, localhost is not in trustedOrigins
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe('securityMiddleware.browserOnly', () => {
  test('allows normal browser user agents', () => {
    const req = mockReq({
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    const res = mockRes();
    const next = jest.fn();

    securityMiddleware.browserOnly(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('blocks bot user agents', () => {
    const req = mockReq({
      headers: { 'User-Agent': 'Googlebot/2.1' },
    });
    const res = mockRes();
    const next = jest.fn();

    securityMiddleware.browserOnly(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  test('blocks requests without user agent', () => {
    const req = mockReq({ headers: {} });
    const res = mockRes();
    const next = jest.fn();

    securityMiddleware.browserOnly(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
