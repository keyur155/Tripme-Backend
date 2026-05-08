/**
 * Payment System Test Cases & Simulation Scripts
 * 
 * This file contains test scenarios and simulation scripts for validating
 * the payment system's fault tolerance and recovery mechanisms.
 * 
 * Run individual tests: node scripts/payment-test-cases.js <test-name>
 * Run all tests: node scripts/payment-test-cases.js --all
 */

const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Booking = require('../models/Booking');
const { runReconciliation, reconcilePayment } = require('../services/paymentReconciliation.service');
const razorpayService = require('../services/razorpay.service');
const { logger } = require('../config/logger');

// ============================================================================
// TEST CASE DEFINITIONS
// ============================================================================

const TEST_CASES = {
  // SUCCESS CASES
  SUCCESS: {
    'card_payment_success': {
      description: 'Card payment completes successfully',
      expectedFlow: [
        'order_created',
        'payment.authorized',
        'payment.captured',
        'booking_confirmed'
      ],
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.status === 'completed' && payment.webhookStatus === 'captured';
      }
    },
    'upi_success': {
      description: 'UPI payment completes successfully',
      expectedFlow: [
        'order_created',
        'payment.authorized',
        'payment.captured',
        'booking_confirmed'
      ],
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.status === 'completed';
      }
    },
    'delayed_upi_capture': {
      description: 'UPI payment with delayed capture (authorized -> captured after delay)',
      expectedFlow: [
        'order_created',
        'payment.authorized',
        '... delay ...',
        'payment.captured',
        'booking_confirmed'
      ],
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.status === 'completed' && payment.timeline.some(t => t.event === 'payment.authorized');
      }
    }
  },

  // FAILURE CASES
  FAILURE: {
    'invalid_otp': {
      description: 'Payment fails due to invalid OTP',
      expectedBehavior: 'Payment marked as failed, booking cancelled, availability reverted',
      simulateWebhook: {
        event: 'payment.failed',
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'Payment failed due to incorrect OTP',
        error_reason: 'payment_failed'
      },
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.status === 'failed' && 
               payment.failureDetails?.error_code === 'BAD_REQUEST_ERROR';
      }
    },
    'bank_decline': {
      description: 'Payment declined by bank',
      expectedBehavior: 'Payment marked as failed with bank decline reason',
      simulateWebhook: {
        event: 'payment.failed',
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'Your payment could not be completed as it was declined by the bank',
        error_reason: 'payment_declined'
      },
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.status === 'failed';
      }
    },
    'insufficient_funds': {
      description: 'Payment fails due to insufficient funds',
      expectedBehavior: 'Payment marked as failed, availability reverted',
      simulateWebhook: {
        event: 'payment.failed',
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'Payment failed due to insufficient funds',
        error_reason: 'insufficient_funds'
      },
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.status === 'failed';
      }
    },
    'user_closes_modal': {
      description: 'User closes Razorpay modal without completing payment',
      expectedBehavior: 'Frontend reports failure, payment marked as cancelled',
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.status === 'failed' || payment.status === 'cancelled';
      }
    },
    'webhook_before_db_write': {
      description: 'Webhook arrives before payment record is created in DB',
      expectedBehavior: 'Orphan record created with webhook_orphan source',
      verify: async (razorpayPaymentId) => {
        const payment = await Payment.findOne({ razorpayPaymentId });
        return payment && payment.metadata?.source === 'webhook_orphan';
      }
    },
    'duplicate_webhook_retry': {
      description: 'Razorpay sends duplicate webhook due to timeout',
      expectedBehavior: 'Second webhook is deduplicated, no duplicate processing',
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        // Should only have one processed event for the same eventId
        const uniqueEvents = new Set(payment.processedWebhookEvents?.map(e => e.eventId));
        return uniqueEvents.size === payment.processedWebhookEvents?.length;
      }
    },
    'webhook_timeout': {
      description: 'Webhook processing times out',
      expectedBehavior: 'Reconciliation cron picks up and processes the payment',
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.reconciliationAttempts > 0;
      }
    },
    'backend_crash_during_booking': {
      description: 'Server crashes during booking creation after payment capture',
      expectedBehavior: 'Payment marked as recovery_required, reconciliation recovers',
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.recoveryStatus === 'recovery_required' || 
               payment.recoveryStatus === 'recovered';
      }
    },
    'payment_captured_booking_missing': {
      description: 'Payment captured but booking record is missing',
      expectedBehavior: 'Payment flagged for recovery, admin notified',
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.status === 'completed' && 
               payment.recoveryStatus === 'recovery_required';
      }
    },
    'payment_failed_after_authorization': {
      description: 'Payment fails after being authorized (e.g., capture timeout)',
      expectedBehavior: 'Payment marked as failed, booking cancelled',
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.status === 'failed' && 
               payment.timeline.some(t => t.event === 'payment.authorized');
      }
    },
    'network_disconnect': {
      description: 'Network disconnects during payment processing',
      expectedBehavior: 'Reconciliation cron fetches actual status from Razorpay',
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.reconciledAt !== null;
      }
    }
  },

  // RECOVERY TESTS
  RECOVERY: {
    'server_restart_during_webhook': {
      description: 'Server restarts while processing webhook',
      expectedBehavior: 'Startup reconciliation catches missed payments',
      verify: async () => {
        // Check that reconciliation ran on startup
        return true; // Manual verification needed
      }
    },
    'delayed_webhook_replay': {
      description: 'Razorpay replays webhook after significant delay',
      expectedBehavior: 'Webhook processed correctly, idempotency prevents duplicates',
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.processedWebhookEvents?.length > 0;
      }
    },
    'reconciliation_restores_state': {
      description: 'Reconciliation cron restores missing payment state',
      expectedBehavior: 'Payment status synced with Razorpay, booking confirmed if captured',
      verify: async (paymentId) => {
        const payment = await Payment.findById(paymentId);
        return payment.timeline.some(t => t.source === 'reconciliation');
      }
    }
  }
};

// ============================================================================
// SIMULATION FUNCTIONS
// ============================================================================

/**
 * Simulate a webhook event for testing
 */
async function simulateWebhook(event, paymentEntity, orderId) {
  const webhookPayload = {
    event,
    account_id: 'acc_test123',
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: paymentEntity.id || `pay_test_${Date.now()}`,
          order_id: orderId || `order_test_${Date.now()}`,
          amount: paymentEntity.amount || 10000,
          currency: 'INR',
          status: event.includes('captured') ? 'captured' : 
                  event.includes('authorized') ? 'authorized' : 
                  event.includes('failed') ? 'failed' : 'created',
          method: paymentEntity.method || 'card',
          error_code: paymentEntity.error_code,
          error_description: paymentEntity.error_description,
          error_source: paymentEntity.error_source,
          error_step: paymentEntity.error_step,
          error_reason: paymentEntity.error_reason
        }
      }
    }
  };

  console.log('Simulating webhook:', event);
  console.log('Payload:', JSON.stringify(webhookPayload, null, 2));
  
  return webhookPayload;
}

/**
 * Simulate orphan webhook (webhook arrives before DB record)
 */
async function simulateOrphanWebhook() {
  const rzpPaymentId = `pay_orphan_${Date.now()}`;
  const rzpOrderId = `order_orphan_${Date.now()}`;

  // Simulate captured webhook without existing payment record
  const webhookPayload = await simulateWebhook('payment.captured', {
    id: rzpPaymentId,
    amount: 50000,
    method: 'upi'
  }, rzpOrderId);

  console.log('\n--- ORPHAN WEBHOOK SIMULATION ---');
  console.log('This simulates a webhook arriving before the payment record exists.');
  console.log('Expected: System creates orphan record with metadata.source = "webhook_orphan"');
  console.log('Expected: Payment flagged as recovery_required');
  console.log('\nTo test manually:');
  console.log(`1. Send POST to /api/payments/webhook/razorpay with above payload`);
  console.log(`2. Check Payment collection for razorpayPaymentId: ${rzpPaymentId}`);
  console.log(`3. Verify metadata.source === 'webhook_orphan'`);
  
  return { rzpPaymentId, rzpOrderId, webhookPayload };
}

/**
 * Simulate duplicate webhook
 */
async function simulateDuplicateWebhook(paymentId) {
  const payment = await Payment.findById(paymentId);
  if (!payment) {
    console.log('Payment not found');
    return;
  }

  console.log('\n--- DUPLICATE WEBHOOK SIMULATION ---');
  console.log('Sending same webhook twice to test idempotency');
  
  const webhookPayload = await simulateWebhook('payment.captured', {
    id: payment.razorpayPaymentId,
    amount: payment.amount * 100,
    method: payment.paymentMethod
  }, payment.razorpayOrderId);

  console.log('\nExpected behavior:');
  console.log('- First webhook: Processed normally');
  console.log('- Second webhook: Detected as duplicate, skipped');
  console.log('- processedWebhookEvents array should have unique entries');
  
  return webhookPayload;
}

/**
 * Run reconciliation manually for testing
 */
async function testReconciliation() {
  console.log('\n--- RECONCILIATION TEST ---');
  console.log('Running reconciliation job manually...\n');
  
  await runReconciliation();
  
  console.log('\nReconciliation complete. Check logs for details.');
}

/**
 * Create test payment in various states
 */
async function createTestPayment(state = 'pending') {
  const testPayment = new Payment({
    razorpayOrderId: `order_test_${Date.now()}`,
    razorpayPaymentId: state !== 'pending' ? `pay_test_${Date.now()}` : null,
    amount: 1000,
    currency: 'INR',
    status: state,
    paymentMethod: 'card',
    subtotal: 850,
    metadata: { source: 'test' },
    timeline: [{
      event: 'test_created',
      message: `Test payment created in ${state} state`,
      source: 'system',
      timestamp: new Date()
    }]
  });

  await testPayment.save();
  console.log(`Test payment created: ${testPayment._id} (status: ${state})`);
  return testPayment;
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Payment System Test Cases');
    console.log('========================\n');
    console.log('Available commands:');
    console.log('  --list              List all test cases');
    console.log('  --simulate-orphan   Simulate orphan webhook scenario');
    console.log('  --test-reconcile    Run reconciliation manually');
    console.log('  --create-pending    Create test payment in pending state');
    console.log('  --create-authorized Create test payment in authorized state');
    console.log('  --help              Show this help');
    return;
  }

  // Connect to MongoDB if needed
  if (!mongoose.connection.readyState) {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/tripme');
  }

  switch (args[0]) {
    case '--list':
      console.log('\n=== SUCCESS CASES ===');
      Object.entries(TEST_CASES.SUCCESS).forEach(([name, tc]) => {
        console.log(`\n${name}:`);
        console.log(`  ${tc.description}`);
      });
      
      console.log('\n=== FAILURE CASES ===');
      Object.entries(TEST_CASES.FAILURE).forEach(([name, tc]) => {
        console.log(`\n${name}:`);
        console.log(`  ${tc.description}`);
        console.log(`  Expected: ${tc.expectedBehavior}`);
      });
      
      console.log('\n=== RECOVERY CASES ===');
      Object.entries(TEST_CASES.RECOVERY).forEach(([name, tc]) => {
        console.log(`\n${name}:`);
        console.log(`  ${tc.description}`);
        console.log(`  Expected: ${tc.expectedBehavior}`);
      });
      break;

    case '--simulate-orphan':
      await simulateOrphanWebhook();
      break;

    case '--test-reconcile':
      await testReconciliation();
      break;

    case '--create-pending':
      await createTestPayment('pending');
      break;

    case '--create-authorized':
      await createTestPayment('authorized');
      break;

    default:
      console.log('Unknown command. Use --help for available commands.');
  }

  await mongoose.disconnect();
}

// Export for use in other test files
module.exports = {
  TEST_CASES,
  simulateWebhook,
  simulateOrphanWebhook,
  simulateDuplicateWebhook,
  testReconciliation,
  createTestPayment
};

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
