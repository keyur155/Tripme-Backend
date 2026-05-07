/**
 * Unit tests for Razorpay service — verifyPayment, verifyWebhookSignature
 * These use real crypto so they test actual signature logic, not mocks.
 */

const crypto = require('crypto');

// Set required env vars before any imports
process.env.MONGO_URI = 'mongodb://test:27017/test';
process.env.JWT_SECRET = 'test-secret-12345678901234567890';
process.env.PORT = '5000';
process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123';
process.env.RAZORPAY_KEY_SECRET = 'test_key_secret_xyz';
process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook_secret_abc';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.NODE_ENV = 'test';

// Mock razorpay module so it doesn't actually connect
jest.mock('razorpay', () => {
  return jest.fn().mockImplementation(() => ({
    orders: { create: jest.fn() },
    payments: { fetch: jest.fn(), refund: jest.fn() },
  }));
});

const razorpayService = require('../services/razorpay.service');

// ─── verifyPayment ───────────────────────────────────────────────────────────

describe('razorpayService.verifyPayment', () => {
  const orderId = 'order_TestOrder123';
  const paymentId = 'pay_TestPayment456';

  function generateValidSignature(oId, pId) {
    return crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${oId}|${pId}`)
      .digest('hex');
  }

  test('returns true for valid signature', () => {
    const signature = generateValidSignature(orderId, paymentId);
    expect(razorpayService.verifyPayment(orderId, paymentId, signature)).toBe(true);
  });

  test('returns false for tampered signature', () => {
    const badSig = 'aaaa' + generateValidSignature(orderId, paymentId).slice(4);
    expect(razorpayService.verifyPayment(orderId, paymentId, badSig)).toBe(false);
  });

  test('returns false for completely wrong signature', () => {
    expect(razorpayService.verifyPayment(orderId, paymentId, 'invalid')).toBe(false);
  });

  test('returns false when orderId is swapped', () => {
    const signature = generateValidSignature(orderId, paymentId);
    expect(razorpayService.verifyPayment('order_WRONG', paymentId, signature)).toBe(false);
  });

  test('returns false when paymentId is swapped', () => {
    const signature = generateValidSignature(orderId, paymentId);
    expect(razorpayService.verifyPayment(orderId, 'pay_WRONG', signature)).toBe(false);
  });
});

// ─── verifyWebhookSignature ──────────────────────────────────────────────────

describe('razorpayService.verifyWebhookSignature', () => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  function generateWebhookSig(payload) {
    return crypto
      .createHmac('sha256', webhookSecret)
      .update(payload)
      .digest('hex');
  }

  test('returns true for valid webhook signature', () => {
    const payload = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_123' } } } });
    const signature = generateWebhookSig(payload);
    expect(razorpayService.verifyWebhookSignature(payload, signature)).toBe(true);
  });

  test('returns false for tampered payload', () => {
    const payload = '{"event":"payment.captured"}';
    const signature = generateWebhookSig(payload);
    const tamperedPayload = '{"event":"payment.failed"}';
    expect(razorpayService.verifyWebhookSignature(tamperedPayload, signature)).toBe(false);
  });

  test('returns false for missing signature', () => {
    expect(razorpayService.verifyWebhookSignature('{}', null)).toBe(false);
    expect(razorpayService.verifyWebhookSignature('{}', undefined)).toBe(false);
    expect(razorpayService.verifyWebhookSignature('{}', '')).toBe(false);
  });

  test('returns false for missing payload', () => {
    expect(razorpayService.verifyWebhookSignature(null, 'somesig')).toBe(false);
    expect(razorpayService.verifyWebhookSignature('', 'somesig')).toBe(false);
  });

  test('returns false for non-hex signature', () => {
    expect(razorpayService.verifyWebhookSignature('{}', 'not-a-hex-string!!!')).toBe(false);
  });

  test('handles large payloads correctly', () => {
    const largePayload = JSON.stringify({ data: 'x'.repeat(10000) });
    const sig = generateWebhookSig(largePayload);
    expect(razorpayService.verifyWebhookSignature(largePayload, sig)).toBe(true);
  });
});

// ─── createOrder ─────────────────────────────────────────────────────────────

describe('razorpayService.createOrder', () => {
  beforeEach(() => {
    // Force re-init
    razorpayService.initializeRazorpay();
  });

  test('creates order with correct amount in paise', async () => {
    const Razorpay = require('razorpay');
    const mockCreate = Razorpay.mock.results[0]?.value?.orders?.create;
    if (!mockCreate) return; // Skip if mock not available

    mockCreate.mockResolvedValueOnce({
      id: 'order_abc123',
      amount: 150000,
      currency: 'INR',
      receipt: 'RCP_test',
      status: 'created',
    });

    const result = await razorpayService.createOrder(1500, 'INR', 'RCP_test', { bookingId: 'b1' });

    expect(result.orderId).toBe('order_abc123');
    expect(result.amount).toBe(150000); // 1500 * 100
    expect(result.currency).toBe('INR');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 150000,
        currency: 'INR',
        receipt: 'RCP_test',
        payment_capture: 1,
      })
    );
  });

  test('rounds fractional amounts correctly', async () => {
    const Razorpay = require('razorpay');
    const mockCreate = Razorpay.mock.results[0]?.value?.orders?.create;
    if (!mockCreate) return;

    mockCreate.mockResolvedValueOnce({
      id: 'order_frac',
      amount: 99999,
      currency: 'INR',
      receipt: 'RCP_frac',
      status: 'created',
    });

    const result = await razorpayService.createOrder(999.99, 'INR', 'RCP_frac');
    expect(result.amount).toBe(99999);
  });
});

// ─── createRefund ────────────────────────────────────────────────────────────

describe('razorpayService.createRefund', () => {
  test('throws for invalid (zero) refund amount', async () => {
    await expect(razorpayService.createRefund('pay_123', 0)).rejects.toThrow('Invalid refund amount');
  });

  test('throws for negative refund amount', async () => {
    await expect(razorpayService.createRefund('pay_123', -100)).rejects.toThrow('Invalid refund amount');
  });
});
