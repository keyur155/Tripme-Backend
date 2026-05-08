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
const MAX_RECOVERY_ATTEMPTS = 3;
const STALE_THRESHOLD_MINUTES = 5;
const ABANDONED_THRESHOLD_HOURS = 2;

/**
 * Main reconciliation job — called by cron in server.js
 */
async function runReconciliation() {
  const jobStart = Date.now();
  logger.info('Starting payment reconciliation job');

  const stats = { reconciled: 0, failed: 0, skipped: 0, recovered: 0, abandoned: 0 };

  try {
    // Phase 1: Reconcile stale payments with razorpayPaymentId
    await reconcileStalePayments(stats);

    // Phase 2: Process payments flagged for recovery
    await processRecoveryQueue(stats);

    // Phase 3: Handle abandoned checkouts
    await handleAbandonedCheckouts(stats);

    const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1);
    logger.info(`Reconciliation complete in ${elapsed}s`, stats);
  } catch (err) {
    logger.error('Reconciliation job error', { error: err.message, stack: err.stack });
  }
}

/**
 * Phase 1: Reconcile stale payments that have a razorpayPaymentId
 */
async function reconcileStalePayments(stats) {
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000);

  const stalePayments = await Payment.find({
    status: { $in: ['pending', 'processing', 'authorized'] },
    reconciliationAttempts: { $lt: MAX_RECONCILIATION_ATTEMPTS },
    createdAt: { $lt: staleThreshold },
    razorpayPaymentId: { $exists: true, $ne: null },
  }).limit(50);

  if (stalePayments.length === 0) {
    logger.debug('No stale payments found');
    return;
  }

  logger.info(`Found ${stalePayments.length} stale payment(s) to reconcile`);

  for (const payment of stalePayments) {
    try {
      const result = await reconcilePayment(payment);
      if (result === 'reconciled') stats.reconciled++;
      else if (result === 'failed') stats.failed++;
      else stats.skipped++;
    } catch (err) {
      logger.error('Error reconciling payment', { paymentId: payment._id, error: err.message });
      await Payment.findByIdAndUpdate(payment._id, {
        $inc: { reconciliationAttempts: 1 }
      });
    }
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

  // Add timeline entry for reconciliation check
  await Payment.addTimelineEntry(payment._id, {
    event: 'reconciliation_check',
    message: `Reconciliation fetched Razorpay status: ${rzpStatus}`,
    source: 'reconciliation',
    data: { rzpStatus, attempt: (payment.reconciliationAttempts || 0) + 1 }
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
 * Handle a captured payment — confirm booking or flag for recovery if missing.
 */
async function handleCapturedPayment(payment, rzpPayment) {
  const existingBooking = await Booking.findById(payment.booking);
  
  // Case 1: Booking exists and already confirmed
  if (existingBooking && ['confirmed', 'pending'].includes(existingBooking.status) && existingBooking.paymentStatus === 'paid') {
    logger.debug('Booking already confirmed, skipping', { bookingId: payment.booking });
    await Payment.findByIdAndUpdate(payment._id, {
      status: 'completed',
      webhookStatus: 'captured',
      webhookReceivedAt: payment.webhookReceivedAt || new Date(),
    });
    await Payment.addTimelineEntry(payment._id, {
      event: 'reconciliation_skipped',
      message: 'Booking already confirmed, no action needed',
      source: 'reconciliation',
      data: { bookingId: payment.booking }
    });
    return 'skipped';
  }

  logger.info('Payment captured, confirming booking via reconciliation', { paymentId: payment._id, bookingId: payment.booking });

  // Update payment to completed
  await Payment.findByIdAndUpdate(payment._id, {
    status: 'completed',
    webhookStatus: 'captured',
    webhookReceivedAt: new Date(),
    processedAt: new Date(),
    orderStatus: 'paid',
  });

  // Case 2: Booking exists but not confirmed yet
  if (existingBooking) {
    existingBooking.paymentStatus = 'paid';
    existingBooking.status = 'confirmed';
    await existingBooking.save();
    logger.info('Booking confirmed via reconciliation', { bookingId: existingBooking._id });

    await Payment.addTimelineEntry(payment._id, {
      event: 'booking_confirmed',
      message: 'Booking confirmed via reconciliation',
      source: 'reconciliation',
      data: { bookingId: existingBooking._id }
    });

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
    return 'reconciled';
  }

  // Case 3: Payment captured but NO booking exists — flag for recovery
  logger.error('CRITICAL: Payment captured but booking not found — flagging for recovery', {
    paymentId: payment._id,
    bookingId: payment.booking,
    rzpPaymentId: rzpPayment?.id
  });

  await Payment.findByIdAndUpdate(payment._id, {
    recoveryStatus: 'recovery_required',
  });

  await Payment.addTimelineEntry(payment._id, {
    event: 'recovery_flagged',
    message: 'Payment captured but booking not found. Flagged for manual recovery.',
    source: 'reconciliation',
    data: { bookingId: payment.booking, rzpPaymentId: rzpPayment?.id }
  });

  return 'reconciled';
}

/**
 * Handle a failed payment — mark everything accordingly with safe availability revert.
 */
async function handleFailedPayment(payment, rzpPayment) {
  logger.warn('Payment failed in Razorpay (via reconciliation)', { paymentId: payment._id });

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

  await Payment.addTimelineEntry(payment._id, {
    event: 'payment.failed',
    message: `Payment failed via reconciliation: ${rzpPayment.error_description || rzpPayment.error_code || 'unknown'}`,
    source: 'reconciliation',
    data: { failureDetails }
  });

  // Cancel the booking with safe availability revert
  if (payment.booking) {
    const booking = await Booking.findById(payment.booking);
    
    if (booking && booking.status !== 'cancelled') {
      // SAFETY: Don't cancel if booking is already confirmed+paid
      if (booking.paymentStatus === 'paid' && booking.status === 'confirmed') {
        logger.warn('Reconciliation: payment.failed but booking is confirmed+paid. Skipping cancellation.', {
          bookingId: booking._id,
          paymentId: payment._id
        });
        await Payment.addTimelineEntry(payment._id, {
          event: 'booking_cancel_skipped',
          message: 'Booking is confirmed+paid. Skipping cancellation despite failed payment.',
          source: 'reconciliation',
          data: { bookingId: booking._id }
        });
      } else {
        booking.paymentStatus = 'failed';
        booking.status = 'cancelled';
        await booking.save();
        logger.info('Booking cancelled due to payment failure (reconciliation)', { bookingId: booking._id });

        // SAFE availability revert: only if no other confirmed booking exists
        try {
          const { updateAvailabilityStatus } = require('../controllers/availability.controller');
          const confirmedBooking = await Booking.findOne({
            _id: { $ne: booking._id },
            listing: booking.listing,
            status: 'confirmed',
            paymentStatus: 'paid',
            checkIn: booking.checkIn,
            checkOut: booking.checkOut
          });
          if (!confirmedBooking) {
            await updateAvailabilityStatus(payment.booking, 'available');
            logger.info('Availability reverted via reconciliation', { bookingId: booking._id });
          } else {
            logger.info('Availability NOT reverted — another confirmed booking exists', {
              bookingId: booking._id,
              confirmedBookingId: confirmedBooking._id
            });
          }
        } catch (availErr) {
          logger.warn('Failed to revert availability', { bookingId: payment.booking, error: availErr.message });
        }
      }
    }
  }

  return 'failed';
}

/**
 * Phase 2: Process payments flagged for recovery (captured but booking missing/orphan)
 */
async function processRecoveryQueue(stats) {
  const recoveryPayments = await Payment.find({
    recoveryStatus: 'recovery_required',
    recoveryAttempts: { $lt: MAX_RECOVERY_ATTEMPTS },
    status: 'completed',
  }).limit(20);

  if (recoveryPayments.length === 0) return;

  logger.info(`Processing ${recoveryPayments.length} payment(s) flagged for recovery`);

  for (const payment of recoveryPayments) {
    try {
      await Payment.findByIdAndUpdate(payment._id, {
        $inc: { recoveryAttempts: 1 },
        recoveryStatus: 'recovery_in_progress',
      });

      // For orphan payments (no booking), we can't auto-recover — just log and alert
      if (!payment.booking) {
        logger.error('ORPHAN PAYMENT requires manual recovery', {
          paymentId: payment._id,
          rzpPaymentId: payment.razorpayPaymentId,
          amount: payment.amount
        });
        await Payment.addTimelineEntry(payment._id, {
          event: 'recovery_manual_required',
          message: 'Orphan payment with no booking reference. Manual intervention required.',
          source: 'recovery',
          data: { attempt: (payment.recoveryAttempts || 0) + 1 }
        });
        // Keep as recovery_required for admin attention
        await Payment.findByIdAndUpdate(payment._id, { recoveryStatus: 'recovery_required' });
        continue;
      }

      // Check if booking now exists (might have been created after initial flag)
      const booking = await Booking.findById(payment.booking);
      if (booking) {
        if (booking.paymentStatus !== 'paid') {
          booking.paymentStatus = 'paid';
          booking.status = 'confirmed';
          await booking.save();
        }
        await Payment.findByIdAndUpdate(payment._id, {
          recoveryStatus: 'recovered',
          recoveredAt: new Date(),
        });
        await Payment.addTimelineEntry(payment._id, {
          event: 'recovery_completed',
          message: 'Booking found and confirmed during recovery',
          source: 'recovery',
          data: { bookingId: booking._id }
        });
        stats.recovered++;
        logger.info('Payment recovered successfully', { paymentId: payment._id, bookingId: booking._id });
      } else {
        // Booking still missing — keep flagged
        await Payment.findByIdAndUpdate(payment._id, { recoveryStatus: 'recovery_required' });
        await Payment.addTimelineEntry(payment._id, {
          event: 'recovery_pending',
          message: 'Booking still not found. Requires manual intervention.',
          source: 'recovery',
          data: { attempt: (payment.recoveryAttempts || 0) + 1 }
        });
      }
    } catch (err) {
      logger.error('Error in recovery processing', { paymentId: payment._id, error: err.message });
      await Payment.findByIdAndUpdate(payment._id, { recoveryStatus: 'recovery_required' });
    }
  }
}

/**
 * Phase 3: Handle abandoned checkouts (orders created but never completed)
 */
async function handleAbandonedCheckouts(stats) {
  const abandonedThreshold = new Date(Date.now() - ABANDONED_THRESHOLD_HOURS * 60 * 60 * 1000);

  // Find payments with only razorpayOrderId (no paymentId) that are old
  const abandonedPayments = await Payment.find({
    status: 'pending',
    razorpayOrderId: { $exists: true, $ne: null },
    razorpayPaymentId: { $exists: false },
    createdAt: { $lt: abandonedThreshold },
    reconciliationAttempts: { $lt: MAX_RECONCILIATION_ATTEMPTS },
  }).limit(30);

  if (abandonedPayments.length === 0) return;

  logger.info(`Found ${abandonedPayments.length} abandoned checkout(s)`);

  for (const payment of abandonedPayments) {
    try {
      // Mark as failed/abandoned
      await Payment.findByIdAndUpdate(payment._id, {
        status: 'cancelled',
        $inc: { reconciliationAttempts: 1 },
      });

      await Payment.addTimelineEntry(payment._id, {
        event: 'checkout_abandoned',
        message: 'Order created but no payment attempt after threshold. Marked as abandoned.',
        source: 'reconciliation',
        data: { hoursElapsed: ABANDONED_THRESHOLD_HOURS }
      });

      // Cancel associated booking if exists
      if (payment.booking) {
        const booking = await Booking.findById(payment.booking);
        if (booking && booking.status === 'pending') {
          booking.status = 'cancelled';
          booking.paymentStatus = 'failed';
          await booking.save();

          // Safe availability revert
          try {
            const { updateAvailabilityStatus } = require('../controllers/availability.controller');
            await updateAvailabilityStatus(payment.booking, 'available');
          } catch (availErr) {
            logger.warn('Failed to revert availability for abandoned checkout', { error: availErr.message });
          }
        }
      }

      stats.abandoned++;
    } catch (err) {
      logger.error('Error handling abandoned checkout', { paymentId: payment._id, error: err.message });
    }
  }
}

module.exports = { runReconciliation, reconcilePayment, processRecoveryQueue, handleAbandonedCheckouts };
