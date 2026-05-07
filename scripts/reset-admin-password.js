/**
 * Password Reset Script for Admin User
 * 
 * Usage: node scripts/reset-admin-password.js
 * 
 * This script will create or reset the password for an admin user
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Configuration
const ADMIN_EMAIL = 'sathwarakeyur990@gmail.com';
const NEW_PASSWORD = 'Admin@1234567'; // Must be at least 12 characters
const ADMIN_NAME = 'Admin User';
const ADMIN_ROLE = 'super-admin'; // super-admin, admin, moderator, or support

async function resetPassword() {
  try {
    console.log('🔐 Admin Password Reset Script Started');
    console.log('=====================================\n');

    // Connect to MongoDB
    // const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    
    // if (!mongoUri) {
    //   console.error('❌ MongoDB URI not found in environment variables!');
    //   console.log('Please set MONGODB_URI or MONGO_URI in your .env file');
    //   process.exit(1);
    // }

    console.log('📡 Connecting to MongoDB...');
    // Ensure we use the correct database name (case-sensitive)
    const mongoUriFixed = "mongodb://localhost:27017/TripMe"
    await mongoose.connect(mongoUriFixed);
    console.log('✅ Connected to MongoDB\n');

    // Get the Admin model
    const Admin = require('../models/Admin');

    // Find or create the admin
    console.log(`🔍 Looking for admin: ${ADMIN_EMAIL}`);
    let admin = await Admin.findOne({ email: ADMIN_EMAIL });

    if (!admin) {
      console.log(`⚠️  Admin not found. Creating new admin account...`);
      
      // Create new admin (password will be hashed by pre-save hook)
      admin = await Admin.create({
        name: ADMIN_NAME,
        email: ADMIN_EMAIL,
        password: NEW_PASSWORD, // Will be hashed by pre-save hook
        role: ADMIN_ROLE,
        isActive: true
      });

      console.log(`✅ Admin account created successfully!\n`);
    } else {
      console.log(`✅ Admin found: ${admin.name || admin.email}`);
      console.log(`   Current Role: ${admin.role}`);
      console.log(`   ID: ${admin._id}\n`);

      // Update the password and role
      console.log('📝 Updating password and role in database...');
      admin.password = NEW_PASSWORD; // Will be hashed by pre-save hook
      admin.role = ADMIN_ROLE;
      admin.isActive = true;
      await admin.save();

      console.log('✅ Password and role updated successfully!\n');
    }

    console.log('================================');
    console.log('🎉 ADMIN PASSWORD RESET COMPLETE');
    console.log('================================');
    console.log(`📧 Email: ${ADMIN_EMAIL}`);
    console.log(`👤 Name: ${admin.name}`);
    console.log(`👑 Role: ${admin.role}`);
    console.log(`🔑 New Password: ${NEW_PASSWORD}`);
    console.log(`✅ isActive: ${admin.isActive}`);
    console.log('================================\n');
    console.log('🎉 Admin can now login to the admin portal!');

    // Disconnect
    await mongoose.disconnect();
    console.log('\n📡 Disconnected from MongoDB');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
resetPassword();
