/**
 * Payment Reconciliation Service
 * Runs every 12 minutes to recover stuck payments:
 * - UPI delays (authorized but not yet captured)
 * - Network failures during webhook delivery
 * - "Money deducted but booking not created" scenarios
 */

const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Booking = require('../models/Booking');
const razorpayService = require('./razorpay.service');
const { logger } = require('../config/logger');

const MAX_RECONCILIATION_ATTEMPTS = 5;
const STALE_THRESHOLD_MINUTES = 5; // Only reconcile payments older than 5 minutes

/**
 * Main reconciliation job — called by cron in server.js
 */
async function runReconciliation() {
  const jobStart = Date.now();
  logger.info('Starting payment reconciliation job');

  try {
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000);

    // Find all payments that may need reconciliation:
    // - pending / authorized (not yet captured)
    // - Not exceeding max retry attempts
    // - Created more than STALE_THRESHOLD_MINUTES ago
    const stalePayments = await Payment.find({
      status: { $in: ['pending', 'processing', 'authorized'] },
      reconciliationAttempts: { $lt: MAX_RECONCILIATION_ATTEMPTS },
      createdAt: { $lt: staleThreshold },
      razorpayPaymentId: { $exists: true, $ne: null },
    }).limit(50); // Process at most 50 per run to avoid overloading Razorpay API

    if (stalePayments.length === 0) {
      logger.debug('No stale payments found');
      return;
    }

    logger.info(`Found ${stalePayments.length} stale payment(s) to reconcile`);

    let reconciled = 0;
    let failed = 0;
    let skipped = 0;

    for (const payment of stalePayments) {
      try {
        const result = await reconcilePayment(payment);
        if (result === 'reconciled') reconciled++;
        else if (result === 'failed') failed++;
        else skipped++;
      } catch (err) {
        logger.error('Error reconciling payment', { paymentId: payment._id, error: err.message });
        // Increment attempt counter even on error so we don't keep retrying broken payments
        await Payment.findByIdAndUpdate(payment._id, {
          $inc: { reconciliationAttempts: 1 }
        });
      }
    }

    const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1);
    logger.info(`Reconciliation complete in ${elapsed}s`, { reconciled, failed, skipped });
  } catch (err) {
    logger.error('Reconciliation job error', { error: err.message });
  }
}

/**
 * Reconcile a single payment by fetching its status from Razorpay.
 * @returns {'reconciled' | 'failed' | 'skipped'}
 */
async function reconcilePayment(payment) {
  const rzpPaymentId = payment.razorpayPaymentId;

  // Fetch latest status from Razorpay
  let rzpPayment;
  try {
    rzpPayment = await razorpayService.getPaymentDetails(rzpPaymentId);
  } catch (fetchErr) {
    logger.warn('Could not fetch Razorpay status', { rzpPaymentId, error: fetchErr.message });
    await Payment.findByIdAndUpdate(payment._id, {
      $inc: { reconciliationAttempts: 1 }
    });
    return 'skipped';
  }

  const rzpStatus = rzpPayment?.status; // 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'
  logger.info('Reconciliation payment status', { paymentId: payment._id, rzpStatus });

  await Payment.findByIdAndUpdate(payment._id, {
    $inc: { reconciliationAttempts: 1 },
    reconciledAt: new Date(),
    'paymentDetails.gatewayResponse': rzpPayment,
  });

  if (rzpStatus === 'captured') {
    return await handleCapturedPayment(payment, rzpPayment);
  }

  if (rzpStatus === 'authorized') {
    // Payment authorized but not yet captured — update status and wait
    await Payment.findByIdAndUpdate(payment._id, {
      status: 'authorized',
      webhookStatus: 'authorized',
    });
    logger.info('Payment authorized, pending capture', { paymentId: payment._id });
    return 'skipped';
  }

  if (rzpStatus === 'failed') {
    return await handleFailedPayment(payment, rzpPayment);
  }

  // 'created' status means user hasn't even attempted payment yet — skip
  logger.debug('Payment status no action needed', { paymentId: payment._id, rzpStatus });
  return 'skipped';
}

/**
 * Handle a captured payment — create booking if not already created.
 */
async function handleCapturedPayment(payment, rzpPayment) {
  // Check if booking already exists and is confirmed
  const existingBooking = await Booking.findById(payment.booking);
  if (existingBooking && ['confirmed', 'pending'].includes(existingBooking.status) && existingBooking.paymentStatus === 'paid') {
    logger.debug('Booking already confirmed, skipping', { bookingId: payment.booking });
    // Just ensure payment status is marked complete
    await Payment.findByIdAndUpdate(payment._id, {
      status: 'completed',
      webhookStatus: 'captured',
      webhookReceivedAt: payment.webhookReceivedAt || new Date(),
    });
    return 'skipped';
  }

  logger.info('Payment captured, confirming booking', { paymentId: payment._id, bookingId: payment.booking });

  // Update payment to completed
  await Payment.findByIdAndUpdate(payment._id, {
    status: 'completed',
    webhookStatus: 'captured',
    webhookReceivedAt: new Date(),
    processedAt: new Date(),
    orderStatus: 'paid',
  });

  // Update booking to confirmed
  if (existingBooking) {
    existingBooking.paymentStatus = 'paid';
    existingBooking.status = 'confirmed';
    await existingBooking.save();
    logger.info('Booking confirmed via reconciliation', { bookingId: existingBooking._id });

    // Send confirmation email
    try {
      const { sendBookingConfirmationEmail } = require('../utils/sendEmail');
      const populatedBooking = await Booking.findById(existingBooking._id)
        .populate('user', 'name email')
        .populate('listing', 'title location images')
        .populate('service', 'title');
      if (populatedBooking?.user?.email) {
        await sendBookingConfirmationEmail(populatedBooking.user.email, populatedBooking);
        logger.info('Confirmation email sent via reconciliation');
      }
    } catch (emailErr) {
      logger.warn('Failed to send confirmation email during reconciliation', { error: emailErr.message });
    }
  }

  return 'reconciled';
}

/**
 * Handle a failed payment — mark everything accordingly.
 */
async function handleFailedPayment(payment, rzpPayment) {
  logger.warn('Payment failed in Razorpay', { paymentId: payment._id });

  const failureDetails = {
    error_code: rzpPayment.error_code,
    error_description: rzpPayment.error_description,
    error_source: rzpPayment.error_source,
    error_step: rzpPayment.error_step,
    error_reason: rzpPayment.error_reason,
    timestamp: new Date(),
  };

  await Payment.findByIdAndUpdate(payment._id, {
    status: 'failed',
    webhookStatus: 'failed',
    failureDetails,
  });

  // Cancel the booking
  if (payment.booking) {
    await Booking.findByIdAndUpdate(payment.booking, {
      paymentStatus: 'failed',
      status: 'cancelled',
    });
    logger.info('Booking cancelled due to payment failure', { bookingId: payment.booking });

    // Revert availability
    try {
      const { updateAvailabilityStatus } = require('../controllers/availability.controller');
      await updateAvailabilityStatus(payment.booking, 'available');
    } catch (availErr) {
      logger.warn('Failed to revert availability', { bookingId: payment.booking, error: availErr.message });
    }
  }

  return 'failed';
}

module.exports = { runReconciliation, reconcilePayment };
