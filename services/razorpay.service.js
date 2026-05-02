/**

 * Razorpay Service Wrapper
 */

let razorpayInstance = null;
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { logger } = require('../config/logger');
function initializeRazorpay() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  
  if (!keyId || !keySecret) {
    logger.error('Razorpay ENV missing', {
      keyIdPresent: !!keyId,
      keySecretPresent: !!keySecret,
    });
    return;
  }
  
  // Validate key format
  if (!keyId.startsWith('rzp_')) {
    logger.error('Invalid RAZORPAY_KEY_ID format. Should start with rzp_live_ or rzp_test_');
    return;
  }

  if (!razorpayInstance) {
    
    razorpayInstance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    logger.info('Razorpay initialized successfully');
  }
}

function isInitialized() {
  return !!(
    process.env.RAZORPAY_KEY_ID &&
    process.env.RAZORPAY_KEY_SECRET &&
    razorpayInstance
  );
}

async function createOrder(amount, currency = 'INR', receipt, meta = {}) {
  if (!isInitialized()) {
    initializeRazorpay();
    if (!isInitialized()) {
      throw new Error('Razorpay not initialized: Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
    }
  }

  const amountPaise = Math.round(Number(amount) * 100);

  const orderParams = {
    amount: amountPaise,
    currency,
    receipt,
    payment_capture: 1,
    notes: meta,
  };

  const order = await razorpayInstance.orders.create(orderParams);

  return {
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    receipt: order.receipt,
    status: order.status,
    rawOrder: order,
  };
}

async function fetchPaymentStatus(paymentId) {
  if (!isInitialized()) {
    initializeRazorpay();
   
    if (!isInitialized()) throw new Error('Razorpay not initialized');
  }
  return razorpayInstance.payments.fetch(paymentId);
}

function verifyPayment(orderId, paymentId, signature) {
    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
  
    return generatedSignature === signature;
  }

function verifyWebhookSignature(payload, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature || !payload) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch (error) {
    return false;
  }
}

async function createRefund(paymentId, amount, notes = '', meta = {}) {
  if (!isInitialized()) {
    initializeRazorpay();
    if (!isInitialized()) {
      throw new Error('Razorpay not initialized');
    }
  }

  const amountPaise = Math.round(Number(amount) * 100);
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
    throw new Error('Invalid refund amount');
  }

  const refund = await razorpayInstance.payments.refund(paymentId, {
    amount: amountPaise,
    speed: 'normal',
    notes: {
      reason: notes || 'TripMe refund',
      ...meta
    }
  });

  return {
    refundId: refund.id,
    amount: (refund.amount || 0) / 100,
    currency: refund.currency,
    status: refund.status,
    paymentId: refund.payment_id,
    rawRefund: refund
  };
}


  async function getPaymentDetails(paymentId) {
    if (!isInitialized()) {
      initializeRazorpay();
      if (!isInitialized()) {
        throw new Error('Razorpay not initialized');
      }
    }
  
    try {
      const payment = await razorpayInstance.payments.fetch(paymentId);
      return payment;
    } catch (error) {
      logger.error('Error fetching Razorpay payment details', { paymentId, error: error.message });
      throw error;
    }
  }

module.exports = {
  initializeRazorpay,
  isInitialized,
  createOrder,
  fetchPaymentStatus,
  verifyPayment,
  getPaymentDetails,
  verifyWebhookSignature,
  createRefund
};
