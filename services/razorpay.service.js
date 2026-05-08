/**

 * Razorpay Service Wrapper
 */

let razorpayInstance = null;
const Razorpay = require('razorpay');
const crypto = require('crypto');
const https = require('https');
const { logger } = require('../config/logger');

// Direct HTTP call to Razorpay API (bypasses SDK issues)
async function razorpayHttpRequest(endpoint, method, data) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const postData = JSON.stringify(data);
  
  const options = {
    hostname: 'api.razorpay.com',
    port: 443,
    path: `/v1${endpoint}`,
    method: method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const error = new Error(parsed.error?.description || 'Razorpay API error');
            error.statusCode = res.statusCode;
            error.error = parsed.error;
            reject(error);
          }
        } catch (e) {
          reject(new Error(`Invalid JSON response from Razorpay: ${responseData.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (e) => {
      logger.error('Razorpay HTTP request error', { error: e.message });
      reject(new Error(`Network error connecting to Razorpay: ${e.message}`));
    });

    req.write(postData);
    req.end();
  });
}

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
  // process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  
  if (!keyId || !keySecret) {
    throw new Error('Razorpay not initialized: Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
  }

  const amountPaise = Math.round(Number(amount) * 100);

  // Razorpay requires minimum amount of 100 paise (₹1)
  if (amountPaise < 100) {
    throw new Error(`Amount too low: ${amountPaise} paise. Minimum is 100 paise (₹1)`);
  }

  const orderParams = {
    amount: amountPaise,
    currency,
    receipt,
    payment_capture: 1,
    notes: meta,
  };

  try {
    logger.info('Razorpay createOrder params', { orderParams });
    
    // Use direct HTTP request to bypass SDK normalizeError bug
    const order = await razorpayHttpRequest('/orders', 'POST', orderParams);
    
    if (!order || !order.id) {
      logger.error('Razorpay returned invalid order response', { order });
      throw new Error('Invalid response from Razorpay: No order ID returned');
    }

    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      status: order.status,
      rawOrder: order,
    };
  } catch (error) {
    // Log the full error for debugging
    logger.error('Razorpay createOrder failed', { 
      error: error.message,
      errorCode: error.error?.code,
      errorDescription: error.error?.description,
      errorReason: error.error?.reason,
      statusCode: error.statusCode
    });
    
    // Re-throw with more context
    if (error.error && error.error.description) {
      const razorpayError = new Error(error.error.description);
      razorpayError.error = error.error;
      razorpayError.statusCode = error.statusCode;
      throw razorpayError;
    }
    
    throw error;
  }
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

    try {
      return crypto.timingSafeEqual(
        Buffer.from(generatedSignature, 'hex'),
        Buffer.from(signature, 'hex')
      );
    } catch (error) {
      return false;
    }
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
