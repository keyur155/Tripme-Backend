/**
 * Unit tests for payment reconciliation service
 * Tests the stale-payment recovery pipeline with mocked DB and Razorpay.
 */

process.env.MONGO_URI = 'mongodb://test:27017/test';
process.env.JWT_SECRET = 'test-secret-12345678901234567890';
process.env.PORT = '5000';
process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123';
process.env.RAZORPAY_KEY_SECRET = 'test_key_secret_xyz';
process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook_secret_abc';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.NODE_ENV = 'test';

// ── Mock all Mongoose models ─────────────────────────────────────────────────
jest.mock('../models/Payment');
jest.mock('../models/Booking');
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
const razorpayService = require('../services/razorpay.service');
const { runReconciliation, reconcilePayment } = require('../services/paymentReconciliation.service');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStalePayment(overrides = {}) {
  return {
    _id: 'pay_db_001',
    razorpayPaymentId: 'pay_rzp_001',
    booking: 'booking_001',
    status: 'pending',
    reconciliationAttempts: 0,
    createdAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('reconcilePayment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Payment.findByIdAndUpdate = jest.fn().mockResolvedValue(null);
  });

  test('returns "reconciled" when Razorpay status is captured and booking exists', async () => {
    const payment = makeStalePayment();

    // Mock razorpay getPaymentDetails
    razorpayService.getPaymentDetails = jest.fn().mockResolvedValue({
      status: 'captured',
      id: 'pay_rzp_001',
    });

    // Mock Booking.findById for handleCapturedPayment
    const mockBooking = {
      _id: 'booking_001',
      status: 'pending',
      paymentStatus: 'pending',
      save: jest.fn().mockResolvedValue(true),
    };
    Booking.findById = jest.fn().mockResolvedValue(mockBooking);

    const result = await reconcilePayment(payment);

    expect(result).toBe('reconciled');
    expect(Payment.findByIdAndUpdate).toHaveBeenCalled();
    expect(mockBooking.paymentStatus).toBe('paid');
    expect(mockBooking.status).toBe('confirmed');
    expect(mockBooking.save).toHaveBeenCalled();
  });

  test('returns "skipped" when Razorpay status is captured but booking already confirmed', async () => {
    const payment = makeStalePayment();

    razorpayService.getPaymentDetails = jest.fn().mockResolvedValue({
      status: 'captured',
      id: 'pay_rzp_001',
    });

    const mockBooking = {
      _id: 'booking_001',
      status: 'confirmed',
      paymentStatus: 'paid',
    };
    Booking.findById = jest.fn().mockResolvedValue(mockBooking);

    const result = await reconcilePayment(payment);

    expect(result).toBe('skipped');
    // Payment should still be marked completed
    expect(Payment.findByIdAndUpdate).toHaveBeenCalledWith(
      'pay_db_001',
      expect.objectContaining({ status: 'completed' })
    );
  });

  test('returns "skipped" when Razorpay status is authorized', async () => {
    const payment = makeStalePayment();

    razorpayService.getPaymentDetails = jest.fn().mockResolvedValue({
      status: 'authorized',
      id: 'pay_rzp_001',
    });

    const result = await reconcilePayment(payment);

    expect(result).toBe('skipped');
    expect(Payment.findByIdAndUpdate).toHaveBeenCalledWith(
      'pay_db_001',
      expect.objectContaining({ status: 'authorized', webhookStatus: 'authorized' })
    );
  });

  test('returns "failed" when Razorpay status is failed', async () => {
    const payment = makeStalePayment();

    razorpayService.getPaymentDetails = jest.fn().mockResolvedValue({
      status: 'failed',
      id: 'pay_rzp_001',
      error_code: 'BAD_REQUEST_ERROR',
      error_description: 'Payment was unsuccessful',
      error_source: 'customer',
      error_step: 'payment_authentication',
      error_reason: 'payment_failed',
    });

    Booking.findByIdAndUpdate = jest.fn().mockResolvedValue(null);

    const result = await reconcilePayment(payment);

    expect(result).toBe('failed');
    expect(Payment.findByIdAndUpdate).toHaveBeenCalledWith(
      'pay_db_001',
      expect.objectContaining({
        status: 'failed',
        webhookStatus: 'failed',
      })
    );
    expect(Booking.findByIdAndUpdate).toHaveBeenCalledWith(
      'booking_001',
      expect.objectContaining({ paymentStatus: 'failed', status: 'cancelled' })
    );
  });

  test('returns "skipped" when Razorpay status is created (user hasn\'t paid)', async () => {
    const payment = makeStalePayment();

    razorpayService.getPaymentDetails = jest.fn().mockResolvedValue({
      status: 'created',
      id: 'pay_rzp_001',
    });

    const result = await reconcilePayment(payment);
    expect(result).toBe('skipped');
  });

  test('returns "skipped" and increments attempts when Razorpay fetch fails', async () => {
    const payment = makeStalePayment();

    razorpayService.getPaymentDetails = jest.fn().mockRejectedValue(
      new Error('Razorpay API timeout')
    );

    const result = await reconcilePayment(payment);

    expect(result).toBe('skipped');
    expect(Payment.findByIdAndUpdate).toHaveBeenCalledWith(
      'pay_db_001',
      expect.objectContaining({ $inc: { reconciliationAttempts: 1 } })
    );
  });
});

describe('runReconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does nothing when no stale payments exist', async () => {
    Payment.find = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([]),
    });

    await runReconciliation();

    expect(Payment.find).toHaveBeenCalled();
  });

  test('processes stale payments and counts results', async () => {
    const stalePayments = [
      makeStalePayment({ _id: 'p1', razorpayPaymentId: 'rzp_p1' }),
      makeStalePayment({ _id: 'p2', razorpayPaymentId: 'rzp_p2' }),
    ];

    Payment.find = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(stalePayments),
    });
    Payment.findByIdAndUpdate = jest.fn().mockResolvedValue(null);

    // p1 = captured, p2 = failed
    razorpayService.getPaymentDetails = jest.fn()
      .mockResolvedValueOnce({ status: 'captured', id: 'rzp_p1' })
      .mockResolvedValueOnce({ status: 'failed', id: 'rzp_p2', error_code: 'ERR', error_description: 'fail' });

    const mockBookingP1 = {
      _id: 'b1', status: 'pending', paymentStatus: 'pending',
      save: jest.fn().mockResolvedValue(true),
    };
    Booking.findById = jest.fn().mockResolvedValue(mockBookingP1);
    Booking.findByIdAndUpdate = jest.fn().mockResolvedValue(null);

    await runReconciliation();

    // Should have processed both payments
    expect(razorpayService.getPaymentDetails).toHaveBeenCalledTimes(2);
  });

  test('increments attempt counter even when reconciliation throws', async () => {
    const stalePayments = [
      makeStalePayment({ _id: 'p_err', razorpayPaymentId: 'rzp_err' }),
    ];

    Payment.find = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(stalePayments),
    });
    Payment.findByIdAndUpdate = jest.fn().mockResolvedValue(null);

    // Make getPaymentDetails throw an unexpected error
    razorpayService.getPaymentDetails = jest.fn().mockImplementation(() => {
      throw new Error('Unexpected crash');
    });

    // Should not throw — errors are caught internally
    await expect(runReconciliation()).resolves.not.toThrow();

    // Attempt counter should still be incremented
    expect(Payment.findByIdAndUpdate).toHaveBeenCalledWith(
      'p_err',
      expect.objectContaining({ $inc: { reconciliationAttempts: 1 } })
    );
  });
});
