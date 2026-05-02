/**
 * Unit tests for Razorpay webhook handler logic in payment.controller.js
 * Tests the razorpayWebhook function and its sub-handlers with mocked models.
 */

const crypto = require('crypto');

process.env.MONGO_URI = 'mongodb://test:27017/test';
process.env.JWT_SECRET = 'test-secret-12345678901234567890';
process.env.PORT = '5000';
process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123';
process.env.RAZORPAY_KEY_SECRET = 'test_key_secret_xyz';
process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook_secret_abc';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.NODE_ENV = 'test';

// Mock all DB models
jest.mock('../models/Payment');
jest.mock('../models/Booking');
jest.mock('../models/Payout');
jest.mock('../models/User');
jest.mock('../models/Coupon');
jest.mock('../models/Refund');
jest.mock('../models/Notification');
jest.mock('../models/Service');
jest.mock('../services/payment.service');
jest.mock('../utils/paymentSecurity', () => ({
  verifyPaymentAmount: jest.fn(() => ({ isValid: true })),
  validateBookingParameters: jest.fn(() => ({ isValid: true })),
  paymentRateLimit: { isAllowed: jest.fn(() => true), getRemainingAttempts: jest.fn(() => 5) },
  paymentSessionManager: { createSession: jest.fn(() => 'session_123') },
  generateIdempotencyKey: jest.fn(() => 'idem_123'),
  verifyWebhookSignature: jest.fn(() => true),
}));
jest.mock('../middlewares/pricingSecurity.middleware', () => ({
  verifyPricingToken: jest.fn(() => true),
}));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => ({
  orders: { create: jest.fn() },
  payments: { fetch: jest.fn(), refund: jest.fn() },
})));
jest.mock('../controllers/availability.controller', () => ({
  updateAvailabilityStatus: jest.fn().mockResolvedValue(true),
}));
jest.mock('../utils/sendEmail', () => ({
  sendBookingConfirmationEmail: jest.fn().mockResolvedValue(true),
}));

const Payment = require('../models/Payment');
const Booking = require('../models/Booking');
const Refund = require('../models/Refund');
const razorpayService = require('../services/razorpay.service');

const {
  razorpayWebhook,
  createRazorpayOrder,
  processPayment,
  handlePaymentFailure,
} = require('../controllers/payment.controller');
const { updateAvailabilityStatus } = require('../controllers/availability.controller');

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateWebhookSig(payload) {
  return crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
}

function mockRes() {
  const res = {
    statusCode: 200,
    _json: null,
    status(code) { res.statusCode = code; return res; },
    json(data) { res._json = data; return res; },
  };
  return res;
}

function mockReq(body, headers = {}) {
  const payload = JSON.stringify(body);
  return {
    body,
    rawBody: payload,
    method: 'POST',
    ip: '127.0.0.1',
    get: jest.fn((h) => headers[h] || null),
    user: { _id: 'user123', id: 'user123', role: 'guest' },
  };
}

// ── razorpayWebhook ──────────────────────────────────────────────────────────

describe('razorpayWebhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects invalid webhook signature with 400', async () => {
    razorpayService.verifyWebhookSignature = jest.fn().mockReturnValue(false);

    const body = { event: 'payment.captured', payload: {} };
    const req = mockReq(body, { 'X-Razorpay-Signature': 'bad_sig' });
    const res = mockRes();

    await razorpayWebhook(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._json.message).toBe('Invalid webhook signature');
  });

  test('accepts valid payment.captured webhook and confirms booking', async () => {
    razorpayService.verifyWebhookSignature = jest.fn().mockReturnValue(true);

    const mockPayment = {
      _id: 'pay_db_1',
      status: 'pending',
      booking: 'booking_1',
      webhookStatus: null,
      paymentDetails: {},
      save: jest.fn().mockResolvedValue(true),
    };
    Payment.findOne = jest.fn().mockResolvedValue(mockPayment);

    const mockBooking = {
      _id: 'booking_1',
      paymentStatus: 'pending',
      status: 'pending',
      save: jest.fn().mockResolvedValue(true),
    };
    Booking.findById = jest.fn().mockResolvedValue(mockBooking);

    const body = {
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: 'pay_rzp_1' } },
      },
    };
    const req = mockReq(body, { 'X-Razorpay-Signature': 'valid' });
    const res = mockRes();

    await razorpayWebhook(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._json.received).toBe(true);
    expect(mockPayment.status).toBe('completed');
    expect(mockPayment.webhookStatus).toBe('captured');
    expect(mockPayment.save).toHaveBeenCalled();
    expect(mockBooking.paymentStatus).toBe('paid');
    expect(mockBooking.status).toBe('confirmed');
    expect(mockBooking.save).toHaveBeenCalled();
  });

  test('payment.captured is idempotent — already completed payment is skipped', async () => {
    razorpayService.verifyWebhookSignature = jest.fn().mockReturnValue(true);

    const mockPayment = {
      _id: 'pay_db_2',
      status: 'completed', // already done
      booking: 'booking_2',
      paymentDetails: {},
      save: jest.fn(),
    };
    Payment.findOne = jest.fn().mockResolvedValue(mockPayment);

    const body = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_rzp_2' } } },
    };
    const req = mockReq(body, { 'X-Razorpay-Signature': 'valid' });
    const res = mockRes();

    await razorpayWebhook(req, res);

    expect(res.statusCode).toBe(200);
    // save should NOT have been called since payment was already completed
    expect(mockPayment.save).not.toHaveBeenCalled();
  });

  test('payment.failed webhook cancels booking and stores failure details', async () => {
    razorpayService.verifyWebhookSignature = jest.fn().mockReturnValue(true);

    const mockPayment = {
      _id: 'pay_db_3',
      status: 'pending',
      booking: 'booking_3',
      paymentDetails: {},
      save: jest.fn().mockResolvedValue(true),
    };
    Payment.findOne = jest.fn().mockResolvedValue(mockPayment);

    const mockBooking = {
      _id: 'booking_3',
      status: 'pending',
      paymentStatus: 'pending',
      save: jest.fn().mockResolvedValue(true),
    };
    Booking.findById = jest.fn().mockResolvedValue(mockBooking);

    const body = {
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'pay_rzp_3',
            error_code: 'BAD_REQUEST_ERROR',
            error_description: 'Payment failed due to insufficient balance',
            error_source: 'bank',
            error_step: 'payment_authorization',
            error_reason: 'insufficient_balance',
          },
        },
      },
    };
    const req = mockReq(body, { 'X-Razorpay-Signature': 'valid' });
    const res = mockRes();

    await razorpayWebhook(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockPayment.status).toBe('failed');
    expect(mockPayment.webhookStatus).toBe('failed');
    expect(mockPayment.failureDetails.error_code).toBe('BAD_REQUEST_ERROR');
    expect(mockPayment.save).toHaveBeenCalled();
    expect(mockBooking.paymentStatus).toBe('failed');
    expect(mockBooking.status).toBe('cancelled');
  });

  test('payment.authorized webhook sets status to authorized', async () => {
    razorpayService.verifyWebhookSignature = jest.fn().mockReturnValue(true);

    const mockPayment = {
      _id: 'pay_db_4',
      status: 'pending',
      booking: 'booking_4',
      paymentDetails: {},
      save: jest.fn().mockResolvedValue(true),
    };
    Payment.findOne = jest.fn().mockResolvedValue(mockPayment);

    const body = {
      event: 'payment.authorized',
      payload: { payment: { entity: { id: 'pay_rzp_4' } } },
    };
    const req = mockReq(body, { 'X-Razorpay-Signature': 'valid' });
    const res = mockRes();

    await razorpayWebhook(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockPayment.status).toBe('authorized');
    expect(mockPayment.webhookStatus).toBe('authorized');
  });

  test('refund.processed webhook completes refund and updates payment/booking', async () => {
    razorpayService.verifyWebhookSignature = jest.fn().mockReturnValue(true);

    const mockRefund = {
      _id: 'ref_db_1',
      amount: 1000,
      payment: 'pay_db_5',
      booking: 'booking_5',
      save: jest.fn().mockResolvedValue(true),
    };
    Refund.findOne = jest.fn().mockResolvedValue(mockRefund);

    const mockBooking = {
      _id: 'booking_5',
      totalAmount: 1000,
      save: jest.fn().mockResolvedValue(true),
    };
    Booking.findById = jest.fn().mockResolvedValue(mockBooking);

    const mockPayment = {
      _id: 'pay_db_5',
      amount: 1000,
      save: jest.fn().mockResolvedValue(true),
    };
    Payment.findById = jest.fn().mockResolvedValue(mockPayment);

    const body = {
      event: 'refund.processed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_rzp_1',
            payment_id: 'pay_rzp_5',
            amount: 100000, // paise
            currency: 'INR',
            status: 'processed',
          },
        },
      },
    };
    const req = mockReq(body, { 'X-Razorpay-Signature': 'valid' });
    const res = mockRes();

    await razorpayWebhook(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockRefund.status).toBe('completed');
    expect(mockRefund.save).toHaveBeenCalled();
    expect(mockBooking.refunded).toBe(true);
    expect(mockBooking.refundStatus).toBe('completed');
    expect(mockPayment.status).toBe('refunded');
    expect(mockPayment.save).toHaveBeenCalled();
  });

  test('refund.failed webhook marks refund as failed', async () => {
    razorpayService.verifyWebhookSignature = jest.fn().mockReturnValue(true);

    const mockRefund = {
      _id: 'ref_db_2',
      booking: 'booking_6',
      save: jest.fn().mockResolvedValue(true),
    };
    Refund.findOne = jest.fn().mockResolvedValue(mockRefund);

    const mockBooking = {
      _id: 'booking_6',
      save: jest.fn().mockResolvedValue(true),
    };
    Booking.findById = jest.fn().mockResolvedValue(mockBooking);

    const body = {
      event: 'refund.failed',
      payload: { refund: { entity: { id: 'rfnd_rzp_2' } } },
    };
    const req = mockReq(body, { 'X-Razorpay-Signature': 'valid' });
    const res = mockRes();

    await razorpayWebhook(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockRefund.status).toBe('failed');
    expect(mockBooking.refundStatus).toBe('pending');
  });

  test('unhandled event type returns 200 (acknowledge but no action)', async () => {
    razorpayService.verifyWebhookSignature = jest.fn().mockReturnValue(true);

    const body = {
      event: 'some.unknown.event',
      payload: {},
    };
    const req = mockReq(body, { 'X-Razorpay-Signature': 'valid' });
    const res = mockRes();

    await razorpayWebhook(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._json.received).toBe(true);
  });

  test('missing payment entity ID in captured webhook is handled gracefully', async () => {
    razorpayService.verifyWebhookSignature = jest.fn().mockReturnValue(true);

    const body = {
      event: 'payment.captured',
      payload: { payment: { entity: {} } }, // no id
    };
    const req = mockReq(body, { 'X-Razorpay-Signature': 'valid' });
    const res = mockRes();

    await razorpayWebhook(req, res);

    // Should return 200, not crash
    expect(res.statusCode).toBe(200);
  });
});

// ── handlePaymentFailure (frontend-reported failure) ─────────────────────────

describe('handlePaymentFailure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('marks payment as failed and cancels booking', async () => {
    const mockPayment = {
      _id: 'pay_front_1',
      user: 'user123',
      status: 'pending',
      booking: 'booking_front_1',
      save: jest.fn().mockResolvedValue(true),
    };
    Payment.findById = jest.fn().mockReturnValue({
      catch: jest.fn().mockReturnValue(mockPayment),
    });

    const mockBooking = {
      _id: 'booking_front_1',
      status: 'pending',
      save: jest.fn().mockResolvedValue(true),
    };
    Booking.findById = jest.fn().mockResolvedValue(mockBooking);

    const req = mockReq({
      error_code: 'PAYMENT_CANCELLED',
      error_description: 'User cancelled',
    });
    req.params = { paymentId: 'pay_front_1' };
    const res = mockRes();

    await handlePaymentFailure(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockPayment.status).toBe('failed');
    expect(mockPayment.failureDetails.error_code).toBe('PAYMENT_CANCELLED');
    expect(mockBooking.paymentStatus).toBe('failed');
    expect(mockBooking.status).toBe('cancelled');
  });

  test('is idempotent — already failed payment returns 200', async () => {
    const mockPayment = {
      _id: 'pay_front_2',
      user: 'user123',
      status: 'failed', // already failed
      booking: 'booking_front_2',
    };
    Payment.findById = jest.fn().mockReturnValue({
      catch: jest.fn().mockReturnValue(mockPayment),
    });

    const req = mockReq({});
    req.params = { paymentId: 'pay_front_2' };
    const res = mockRes();

    await handlePaymentFailure(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._json.message).toBe('Payment already marked as failed');
  });

  test('returns 403 when user does not own the payment', async () => {
    const mockPayment = {
      _id: 'pay_front_3',
      user: 'different_user',
      status: 'pending',
    };
    Payment.findById = jest.fn().mockReturnValue({
      catch: jest.fn().mockReturnValue(mockPayment),
    });

    const req = mockReq({});
    req.params = { paymentId: 'pay_front_3' };
    const res = mockRes();

    await handlePaymentFailure(req, res);

    expect(res.statusCode).toBe(403);
  });

  test('returns 404 when payment not found', async () => {
    Payment.findById = jest.fn().mockReturnValue({
      catch: jest.fn().mockReturnValue(null),
    });
    Payment.findOne = jest.fn().mockResolvedValue(null);

    const req = mockReq({ razorpayOrderId: 'order_unknown' });
    req.params = { paymentId: 'nonexistent' };
    const res = mockRes();

    await handlePaymentFailure(req, res);

    expect(res.statusCode).toBe(404);
  });
});
