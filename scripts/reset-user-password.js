/**
 * Reset User Password Script
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const EMAIL = 'xyz.keyur@gmail.com';
const NEW_PASSWORD = 'Keyur@123456'; // Must be at least 12 characters with uppercase, lowercase, number, and special character

async function resetPassword() {
  try {
    console.log('🔐 Password Reset Script');
    console.log('========================\n');

    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    const db = mongoose.connection.db;
    const user = await db.collection('users').findOne({ email: EMAIL });

    if (!user) {
      console.log('❌ User not found with email:', EMAIL);
      await mongoose.disconnect();
      return;
    }

    console.log('📋 Found User:');
    console.log(`   Name: ${user.name}`);
    console.log(`   Email: ${user.email}`);
    console.log(`   Role: ${user.role}`);
    console.log(`   isVerified: ${user.isVerified}`);
    console.log(`   accountStatus: ${user.accountStatus || 'NOT SET'}`);
    console.log('');

    // Hash new password
    const hashedPassword = await bcrypt.hash(NEW_PASSWORD, 12);

    // Update user
    await db.collection('users').updateOne(
      { email: EMAIL },
      { 
        $set: { 
          password: hashedPassword, 
          isVerified: true, 
          accountStatus: 'active',
          // Keep existing role
        } 
      }
    );

    console.log('✅ Password Reset Complete!');
    console.log('===========================');
    console.log(`   📧 Email: ${EMAIL}`);
    console.log(`   🔑 New Password: ${NEW_PASSWORD}`);
    console.log(`   ✅ isVerified: true`);
    console.log(`   ✅ accountStatus: active`);
    console.log('');
    console.log('🎉 User can now login!');

    await mongoose.disconnect();
    console.log('\n📡 Disconnected from MongoDB');

  } catch (error) {
    console.error('❌ Error:', error.message);
    await mongoose.disconnect();
  }
}

resetPassword();

