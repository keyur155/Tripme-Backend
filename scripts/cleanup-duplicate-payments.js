/**
 * Duplicate Payment Cleanup Script
 * 
 * This script detects and safely cleans up duplicate payment documents
 * that share the same razorpayOrderId or razorpayPaymentId.
 * 
 * IMPORTANT: Run with --dry-run first to see what would be deleted.
 * 
 * Usage:
 *   node scripts/cleanup-duplicate-payments.js --dry-run    # Preview only
 *   node scripts/cleanup-duplicate-payments.js --execute    # Actually delete
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Payment = require('../models/Payment');

const DRY_RUN = process.argv.includes('--dry-run');
const EXECUTE = process.argv.includes('--execute');

if (!DRY_RUN && !EXECUTE) {
  console.log('Usage:');
  console.log('  node scripts/cleanup-duplicate-payments.js --dry-run    # Preview only');
  console.log('  node scripts/cleanup-duplicate-payments.js --execute    # Actually delete');
  process.exit(1);
}

async function connectDB() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI or MONGODB_URI environment variable not set');
  }
  await mongoose.connect(mongoUri);
  console.log('✅ Connected to MongoDB');
}

/**
 * Find duplicate razorpayOrderIds
 */
async function findDuplicateOrderIds() {
  const duplicates = await Payment.aggregate([
    { $match: { razorpayOrderId: { $ne: null, $exists: true } } },
    { $group: { _id: '$razorpayOrderId', count: { $sum: 1 }, docs: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
  ]);
  return duplicates;
}

/**
 * Find duplicate razorpayPaymentIds
 */
async function findDuplicatePaymentIds() {
  const duplicates = await Payment.aggregate([
    { $match: { razorpayPaymentId: { $ne: null, $exists: true } } },
    { $group: { _id: '$razorpayPaymentId', count: { $sum: 1 }, docs: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
  ]);
  return duplicates;
}

/**
 * Score a payment document to determine which one to keep
 * Higher score = more complete/important = KEEP
 */
function scorePayment(payment) {
  let score = 0;
  
  // Prefer completed payments
  if (payment.status === 'completed') score += 100;
  if (payment.status === 'processing') score += 50;
  if (payment.status === 'authorized') score += 30;
  if (payment.status === 'pending') score += 10;
  
  // Prefer payments with webhook data
  if (payment.webhookStatus === 'captured') score += 50;
  if (payment.webhookStatus === 'authorized') score += 30;
  if (payment.webhookReceivedAt) score += 20;
  
  // Prefer payments with timeline entries
  score += (payment.timeline?.length || 0) * 5;
  
  // Prefer payments with processedWebhookEvents
  score += (payment.processedWebhookEvents?.length || 0) * 10;
  
  // Prefer payments linked to bookings
  if (payment.booking) score += 30;
  
  // Prefer payments with user/host
  if (payment.user) score += 10;
  if (payment.host) score += 10;
  
  // Prefer payments with pricing breakdown
  if (payment.pricingBreakdown?.customerBreakdown) score += 15;
  
  // Prefer payments with commission data
  if (payment.commission?.platformFee > 0) score += 10;
  
  // Prefer payments created from create_order (canonical)
  if (payment.metadata?.source === 'create_order') score += 40;
  
  // Penalize orphan payments
  if (payment.metadata?.source === 'webhook_orphan') score -= 20;
  
  // Prefer newer payments (tie-breaker)
  score += payment.updatedAt ? new Date(payment.updatedAt).getTime() / 1e12 : 0;
  
  return score;
}

/**
 * Process duplicates for a given field
 */
async function processDuplicates(duplicates, fieldName) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Processing ${duplicates.length} duplicate ${fieldName} groups`);
  console.log('═'.repeat(60));
  
  let totalDeleted = 0;
  let totalKept = 0;
  
  for (const dup of duplicates) {
    console.log(`\n📋 ${fieldName}: ${dup._id} (${dup.count} duplicates)`);
    
    // Fetch full payment documents
    const payments = await Payment.find({ _id: { $in: dup.docs } }).lean();
    
    // Score each payment
    const scored = payments.map(p => ({
      ...p,
      score: scorePayment(p)
    })).sort((a, b) => b.score - a.score);
    
    // Keep the highest scored, delete the rest
    const toKeep = scored[0];
    const toDelete = scored.slice(1);
    
    console.log(`  ✅ KEEP: ${toKeep._id} (score: ${toKeep.score}, status: ${toKeep.status}, webhookStatus: ${toKeep.webhookStatus})`);
    
    for (const payment of toDelete) {
      console.log(`  ❌ DELETE: ${payment._id} (score: ${payment.score}, status: ${payment.status}, webhookStatus: ${payment.webhookStatus})`);
      
      if (EXECUTE) {
        // Merge timeline from deleted payment into kept payment
        if (payment.timeline?.length > 0) {
          await Payment.findByIdAndUpdate(toKeep._id, {
            $push: {
              timeline: {
                $each: payment.timeline.map(t => ({
                  ...t,
                  message: `[MERGED FROM DELETED ${payment._id}] ${t.message}`
                }))
              }
            }
          });
          console.log(`    📝 Merged ${payment.timeline.length} timeline entries`);
        }
        
        // Merge processedWebhookEvents
        if (payment.processedWebhookEvents?.length > 0) {
          await Payment.findByIdAndUpdate(toKeep._id, {
            $addToSet: {
              processedWebhookEvents: { $each: payment.processedWebhookEvents }
            }
          });
          console.log(`    📝 Merged ${payment.processedWebhookEvents.length} webhook events`);
        }
        
        // Delete the duplicate
        await Payment.findByIdAndDelete(payment._id);
        console.log(`    🗑️  Deleted`);
        totalDeleted++;
      } else {
        console.log(`    [DRY RUN] Would delete`);
        totalDeleted++;
      }
    }
    
    totalKept++;
  }
  
  return { totalDeleted, totalKept };
}

async function main() {
  try {
    await connectDB();
    
    console.log('\n🔍 Scanning for duplicate payments...\n');
    
    // Find duplicates
    const dupOrderIds = await findDuplicateOrderIds();
    const dupPaymentIds = await findDuplicatePaymentIds();
    
    console.log(`Found ${dupOrderIds.length} duplicate razorpayOrderId groups`);
    console.log(`Found ${dupPaymentIds.length} duplicate razorpayPaymentId groups`);
    
    if (dupOrderIds.length === 0 && dupPaymentIds.length === 0) {
      console.log('\n✅ No duplicates found! Database is clean.');
      process.exit(0);
    }
    
    // Process duplicates
    let stats = { totalDeleted: 0, totalKept: 0 };
    
    if (dupOrderIds.length > 0) {
      const result = await processDuplicates(dupOrderIds, 'razorpayOrderId');
      stats.totalDeleted += result.totalDeleted;
      stats.totalKept += result.totalKept;
    }
    
    if (dupPaymentIds.length > 0) {
      const result = await processDuplicates(dupPaymentIds, 'razorpayPaymentId');
      stats.totalDeleted += result.totalDeleted;
      stats.totalKept += result.totalKept;
    }
    
    console.log('\n' + '═'.repeat(60));
    console.log('SUMMARY');
    console.log('═'.repeat(60));
    console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
    console.log(`Payments kept: ${stats.totalKept}`);
    console.log(`Payments ${EXECUTE ? 'deleted' : 'would be deleted'}: ${stats.totalDeleted}`);
    
    if (!EXECUTE && stats.totalDeleted > 0) {
      console.log('\n⚠️  Run with --execute to actually delete duplicates');
    }
    
    if (EXECUTE) {
      console.log('\n🔧 Rebuilding indexes...');
      await Payment.syncIndexes();
      console.log('✅ Indexes rebuilt');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Disconnected from MongoDB');
  }
}

main();
