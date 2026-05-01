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

const MAX_RECONCILIATION_ATTEMPTS = 5;
const STALE_THRESHOLD_MINUTES = 5; // Only reconcile payments older than 5 minutes

/**
 * Main reconciliation job — called by cron in server.js
 */
async function runReconciliation() {
  const jobStart = Date.now();
  console.log(`\n🔄 [RECONCILIATION] Starting payment reconciliation job at ${new Date().toISOString()}`);

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
      console.log('✅ [RECONCILIATION] No stale payments found. All clear.');
      return;
    }

    console.log(`🔍 [RECONCILIATION] Found ${stalePayments.length} stale payment(s) to reconcile.`);

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
        console.error(`❌ [RECONCILIATION] Error reconciling payment ${payment._id}:`, err.message);
        // Increment attempt counter even on error so we don't keep retrying broken payments
        await Payment.findByIdAndUpdate(payment._id, {
          $inc: { reconciliationAttempts: 1 }
        });
      }
    }

    const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1);
    console.log(`✅ [RECONCILIATION] Job complete in ${elapsed}s — reconciled:${reconciled} failed:${failed} skipped:${skipped}`);
  } catch (err) {
    console.error('❌ [RECONCILIATION] Job error:', err.message);
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
    console.warn(`⚠️ [RECONCILIATION] Could not fetch Razorpay status for ${rzpPaymentId}: ${fetchErr.message}`);
    await Payment.findByIdAndUpdate(payment._id, {
      $inc: { reconciliationAttempts: 1 }
    });
    return 'skipped';
  }

  const rzpStatus = rzpPayment?.status; // 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'
  console.log(`📊 [RECONCILIATION] Payment ${payment._id} → Razorpay status: ${rzpStatus}`);

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
    console.log(`⏳ [RECONCILIATION] Payment ${payment._id} is authorized (UPI/NetBanking pending capture)`);
    return 'skipped';
  }

  if (rzpStatus === 'failed') {
    return await handleFailedPayment(payment, rzpPayment);
  }

  // 'created' status means user hasn't even attempted payment yet — skip
  console.log(`ℹ️ [RECONCILIATION] Payment ${payment._id} has status '${rzpStatus}' — no action needed`);
  return 'skipped';
}

/**
 * Handle a captured payment — create booking if not already created.
 */
async function handleCapturedPayment(payment, rzpPayment) {
  // Check if booking already exists and is confirmed
  const existingBooking = await Booking.findById(payment.booking);
  if (existingBooking && ['confirmed', 'pending'].includes(existingBooking.status) && existingBooking.paymentStatus === 'paid') {
    console.log(`ℹ️ [RECONCILIATION] Booking ${payment.booking} already exists and confirmed. Skipping.`);
    // Just ensure payment status is marked complete
    await Payment.findByIdAndUpdate(payment._id, {
      status: 'completed',
      webhookStatus: 'captured',
      webhookReceivedAt: payment.webhookReceivedAt || new Date(),
    });
    return 'skipped';
  }

  console.log(`💰 [RECONCILIATION] Payment ${payment._id} is captured! Confirming booking ${payment.booking}...`);

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
    console.log(`✅ [RECONCILIATION] Booking ${existingBooking._id} confirmed via reconciliation.`);

    // Send confirmation email
    try {
      const { sendBookingConfirmationEmail } = require('../utils/sendEmail');
      const populatedBooking = await Booking.findById(existingBooking._id)
        .populate('user', 'name email')
        .populate('listing', 'title location images')
        .populate('service', 'title');
      if (populatedBooking?.user?.email) {
        await sendBookingConfirmationEmail(populatedBooking.user.email, populatedBooking);
        console.log(`📧 [RECONCILIATION] Confirmation email sent to ${populatedBooking.user.email}`);
      }
    } catch (emailErr) {
      console.error('⚠️ [RECONCILIATION] Failed to send confirmation email:', emailErr.message);
    }
  }

  return 'reconciled';
}

/**
 * Handle a failed payment — mark everything accordingly.
 */
async function handleFailedPayment(payment, rzpPayment) {
  console.log(`❌ [RECONCILIATION] Payment ${payment._id} has FAILED in Razorpay.`);

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
    console.log(`🚫 [RECONCILIATION] Booking ${payment.booking} cancelled due to payment failure.`);

    // Revert availability
    try {
      const { updateAvailabilityStatus } = require('../controllers/availability.controller');
      await updateAvailabilityStatus(payment.booking, 'available');
    } catch (availErr) {
      console.error('⚠️ [RECONCILIATION] Failed to revert availability:', availErr.message);
    }
  }

  return 'failed';
}

module.exports = { runReconciliation, reconcilePayment };
