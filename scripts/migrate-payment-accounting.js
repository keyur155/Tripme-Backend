/**
 * Payment Accounting Migration Script
 * 
 * Migrates existing payment documents to the new business model:
 * - platformFee = 0 (deprecated)
 * - hostEarning = subtotal (host receives full amount)
 * - payout.amount = subtotal
 * - Platform earns ONLY processingFee
 * 
 * Usage:
 *   node scripts/migrate-payment-accounting.js --dry-run    # Preview only
 *   node scripts/migrate-payment-accounting.js --execute    # Actually update
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Payment = require('../models/Payment');

const DRY_RUN = process.argv.includes('--dry-run');
const EXECUTE = process.argv.includes('--execute');

if (!DRY_RUN && !EXECUTE) {
  console.log('Usage:');
  console.log('  node scripts/migrate-payment-accounting.js --dry-run    # Preview only');
  console.log('  node scripts/migrate-payment-accounting.js --execute    # Actually update');
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

async function main() {
  try {
    await connectDB();
    
    console.log('\n🔍 Scanning for payments with old accounting model...\n');
    
    // Find payments where platformFee > 0 OR hostEarning != subtotal
    const paymentsToMigrate = await Payment.find({
      $or: [
        { 'commission.platformFee': { $gt: 0 } },
        { 
          subtotal: { $gt: 0 },
          $expr: { $ne: ['$commission.hostEarning', '$subtotal'] }
        }
      ]
    }).lean();
    
    console.log(`Found ${paymentsToMigrate.length} payments to migrate\n`);
    
    if (paymentsToMigrate.length === 0) {
      console.log('✅ No payments need migration. All payments use new accounting model.');
      process.exit(0);
    }
    
    let migratedCount = 0;
    let errorCount = 0;
    
    for (const payment of paymentsToMigrate) {
      const oldPlatformFee = payment.commission?.platformFee || 0;
      const oldHostEarning = payment.commission?.hostEarning || 0;
      const oldPayoutAmount = payment.payout?.amount || 0;
      const subtotal = payment.subtotal || 0;
      
      // New values according to business model
      const newPlatformFee = 0;
      const newHostEarning = subtotal;
      const newPayoutAmount = subtotal;
      
      console.log(`\n📋 Payment: ${payment._id}`);
      console.log(`   Subtotal: ₹${subtotal}`);
      console.log(`   OLD: platformFee=₹${oldPlatformFee}, hostEarning=₹${oldHostEarning}, payout=₹${oldPayoutAmount}`);
      console.log(`   NEW: platformFee=₹${newPlatformFee}, hostEarning=₹${newHostEarning}, payout=₹${newPayoutAmount}`);
      
      if (EXECUTE) {
        try {
          await Payment.findByIdAndUpdate(payment._id, {
            $set: {
              'commission.platformFee': newPlatformFee,
              'commission.hostEarning': newHostEarning,
              'payout.amount': newPayoutAmount,
              // Update pricing breakdown if exists
              'pricingBreakdown.hostBreakdown.platformFee': 0,
              'pricingBreakdown.hostBreakdown.hostEarning': subtotal,
              'pricingBreakdown.platformBreakdown.platformFee': 0,
              'pricingBreakdown.platformBreakdown.platformRevenue': payment.processingFee || 0,
              'pricingBreakdown.customerBreakdown.platformFee': 0
            },
            $push: {
              timeline: {
                event: 'accounting_migrated',
                message: `Migrated to new business model: platformFee ${oldPlatformFee}→0, hostEarning ${oldHostEarning}→${newHostEarning}`,
                timestamp: new Date(),
                source: 'migration_script',
                data: {
                  oldPlatformFee,
                  oldHostEarning,
                  oldPayoutAmount,
                  newPlatformFee,
                  newHostEarning,
                  newPayoutAmount
                }
              }
            }
          });
          console.log(`   ✅ Migrated`);
          migratedCount++;
        } catch (error) {
          console.log(`   ❌ Error: ${error.message}`);
          errorCount++;
        }
      } else {
        console.log(`   [DRY RUN] Would migrate`);
        migratedCount++;
      }
    }
    
    console.log('\n' + '═'.repeat(60));
    console.log('SUMMARY');
    console.log('═'.repeat(60));
    console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
    console.log(`Payments ${EXECUTE ? 'migrated' : 'would be migrated'}: ${migratedCount}`);
    if (errorCount > 0) {
      console.log(`Errors: ${errorCount}`);
    }
    
    if (!EXECUTE && migratedCount > 0) {
      console.log('\n⚠️  Run with --execute to actually migrate payments');
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
