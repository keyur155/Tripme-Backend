#!/usr/bin/env node
/**
 * Seed Script: Sample Hosts, Guests, and Properties
 *
 * Populates the database with a handful of users (hosts & guests)
 * and associated properties to support manual testing flows.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const mongoose = require('mongoose');

const User = require('../../models/User');
const Property = require('../../models/Property');

const MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  'mongodb://127.0.0.1:27017/tripme';

const sampleHosts = [
  {
    name: 'Ananya Patel',
    email: 'host.ananya@example.com',
    phone: '+919876543210',
    password: 'HostPass123!',
    role: 'host',
    isVerified: true,
    languages: ['en', 'hi'],
    location: {
      type: 'Point',
      coordinates: [72.8777, 19.076],
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India'
    }
  },
  {
    name: 'Rahul Mehra',
    email: 'host.rahul@example.com',
    phone: '+919123456789',
    password: 'HostPass456!',
    role: 'host',
    isVerified: true,
    languages: ['en'],
    location: {
      type: 'Point',
      coordinates: [77.5946, 12.9716],
      city: 'Bengaluru',
      state: 'Karnataka',
      country: 'India'
    }
  }
];

const sampleGuests = [
  {
    name: 'Meera Shah',
    email: 'guest.meera@example.com',
    phone: '+919000111222',
    password: 'GuestPass123!',
    role: 'guest',
    isVerified: true
  },
  {
    name: 'Vikram Singh',
    email: 'guest.vikram@example.com',
    phone: '+919888777666',
    password: 'GuestPass456!',
    role: 'guest',
    isVerified: true
  }
];

const sampleProperties = [
  {
    title: 'Palm Grove Villa',
    description:
      'A serene premium villa with a lush private garden, infinity pool, and dedicated concierge service.',
    hostEmail: 'host.ananya@example.com',
    type: 'villa',
    propertyType: 'premium',
    style: 'modern',
    placeType: 'entire',
    location: {
      type: 'Point',
      coordinates: [72.7907, 18.922],
      address: 'Palm Grove Road, Juhu',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India',
      postalCode: '400049'
    },
    pricing: {
      basePrice: 18500,
      basePrice24Hour: 21500,
      extraGuestPrice: 1500,
      cleaningFee: 1200,
      serviceFee: 900,
      securityDeposit: 5000,
      currency: 'INR',
      weeklyDiscount: 5,
      monthlyDiscount: 10
    },
    hourlyBooking: {
      enabled: true,
      minStayDays: 1,
      hourlyRates: {
        sixHours: 0.35,
        twelveHours: 0.6,
        eighteenHours: 0.8
      }
    },
    amenities: ['wifi', 'ac', 'pool', 'parking', 'breakfast', 'security'],
    features: ['city-view', 'balcony', 'long-term-stays'],
    services: ['airport-pickup', 'breakfast', 'cleaning'],
    maxGuests: 8,
    minNights: 2,
    bedrooms: 4,
    beds: 5,
    bathrooms: 4,
    checkInTime: '14:00',
    checkOutTime: '11:00',
    enable24HourBooking: true,
    availabilitySettings: {
      minBookingHours: 24,
      maxBookingHours: 168,
      hostBufferTime: 3,
      allowedCheckInTimes: ['08:00', '14:00', '20:00'],
      advanceBookingDays: 120
    },
    houseRules: {
      common: ['No parties', 'No smoking indoors'],
      additional: {}
    },
    images: [
      {
        url: 'https://images.unsplash.com/photo-1568605114967-8130f3a36994',
        category: 'Exterior',
        isPrimary: true
      },
      {
        url: 'https://images.unsplash.com/photo-1505691723518-36a5ac3be353',
        category: 'Living room',
        isPrimary: false
      }
    ],
    rating: {
      average: 4.8,
      cleanliness: 4.9,
      accuracy: 4.8,
      communication: 4.9,
      location: 4.7,
      checkIn: 4.9,
      value: 4.6
    },
    reviewCount: 24,
    isFeatured: true,
    isSponsored: true,
    isTopRated: true,
    status: 'published',
    approvalStatus: 'approved',
    isDraft: false,
    isPublished: true
  },
  {
    title: 'Lakeside Serenity Cottage',
    description:
      'Cozy lakeside cottage perfect for quick getaways with panoramic water views and outdoor fire pit.',
    hostEmail: 'host.rahul@example.com',
    type: 'cottage',
    propertyType: 'luxury',
    style: 'rustic',
    placeType: 'entire',
    location: {
      type: 'Point',
      coordinates: [76.2691, 13.556],
      address: 'Lake View Road, Coorg',
      city: 'Madikeri',
      state: 'Karnataka',
      country: 'India',
      postalCode: '571201'
    },
    pricing: {
      basePrice: 9500,
      basePrice24Hour: 11200,
      extraGuestPrice: 900,
      cleaningFee: 600,
      serviceFee: 450,
      securityDeposit: 2500,
      currency: 'INR',
      weeklyDiscount: 8,
      monthlyDiscount: 15
    },
    hourlyBooking: {
      enabled: true,
      minStayDays: 1,
      hourlyRates: {
        sixHours: 0.32,
        twelveHours: 0.55,
        eighteenHours: 0.75
      }
    },
    amenities: ['wifi', 'kitchen', 'fireplace', 'parking', 'essentials'],
    features: ['mountain-view', 'garden', 'long-term-stays'],
    services: ['guided-tours', 'cleaning'],
    maxGuests: 5,
    minNights: 1,
    bedrooms: 2,
    beds: 3,
    bathrooms: 2,
    checkInTime: '13:00',
    checkOutTime: '10:00',
    enable24HourBooking: false,
    availabilitySettings: {
      minBookingHours: 12,
      maxBookingHours: 120,
      hostBufferTime: 2,
      allowedCheckInTimes: ['07:00', '13:00'],
      advanceBookingDays: 90
    },
    houseRules: {
      common: ['Please respect quiet hours after 10 PM'],
      additional: {}
    },
    images: [
      {
        url: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267',
        category: 'Exterior',
        isPrimary: true
      },
      {
        url: 'https://images.unsplash.com/photo-1449844908441-8829872d2607',
        category: 'Amenities',
        isPrimary: false
      }
    ],
    rating: {
      average: 4.7,
      cleanliness: 4.8,
      accuracy: 4.6,
      communication: 4.8,
      location: 4.9,
      checkIn: 4.7,
      value: 4.7
    },
    reviewCount: 12,
    isFeatured: true,
    isSponsored: false,
    isTopRated: true,
    status: 'published',
    approvalStatus: 'approved',
    isDraft: false,
    isPublished: true
  },
  {
    title: 'Skyline Business Apartment',
    description:
      'Modern city apartment tailored for business travellers with dedicated workspace and concierge assistance.',
    hostEmail: 'host.ananya@example.com',
    type: 'apartment',
    propertyType: 'standard',
    style: 'industrial',
    placeType: 'entire',
    location: {
      type: 'Point',
      coordinates: [77.209, 28.6139],
      address: 'Connaught Place',
      city: 'New Delhi',
      state: 'Delhi',
      country: 'India',
      postalCode: '110001'
    },
    pricing: {
      basePrice: 7200,
      basePrice24Hour: 8600,
      extraGuestPrice: 600,
      cleaningFee: 450,
      serviceFee: 350,
      securityDeposit: 1800,
      currency: 'INR',
      weeklyDiscount: 6,
      monthlyDiscount: 12
    },
    hourlyBooking: {
      enabled: true,
      minStayDays: 1,
      hourlyRates: {
        sixHours: 0.3,
        twelveHours: 0.5,
        eighteenHours: 0.7
      }
    },
    amenities: ['wifi', 'workspace', 'ac', 'washer', 'dryer', 'security'],
    features: ['city-view', 'elevator', 'long-term-stays'],
    services: ['laundry', 'concierge'],
    maxGuests: 3,
    minNights: 1,
    bedrooms: 1,
    beds: 1,
    bathrooms: 1,
    checkInTime: '15:00',
    checkOutTime: '11:00',
    enable24HourBooking: true,
    availabilitySettings: {
      minBookingHours: 6,
      maxBookingHours: 96,
      hostBufferTime: 1,
      allowedCheckInTimes: ['06:00', '12:00', '18:00'],
      advanceBookingDays: 60
    },
    houseRules: {
      common: ['No smoking', 'No pets'],
      additional: {}
    },
    images: [
      {
        url: 'https://images.unsplash.com/photo-1505691938895-1758d7feb511',
        category: 'Living room',
        isPrimary: true
      },
      {
        url: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267',
        category: 'Bedroom',
        isPrimary: false
      }
    ],
    rating: {
      average: 4.6,
      cleanliness: 4.7,
      accuracy: 4.5,
      communication: 4.6,
      location: 4.8,
      checkIn: 4.6,
      value: 4.5
    },
    reviewCount: 9,
    isFeatured: false,
    isSponsored: false,
    isTopRated: false,
    status: 'published',
    approvalStatus: 'approved',
    isDraft: false,
    isPublished: true
  }
];

async function connectToDatabase() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB');
}

async function upsertUser(userData) {
  const existing = await User.findOne({ email: userData.email });
  if (existing) {
    console.log(`ℹ️  User already exists: ${userData.email}`);
    return existing;
  }

  const user = new User({
    ...userData,
    accountStatus: 'active'
  });

  await user.save();
  console.log(`✅ Created user: ${user.email}`);
  return user;
}

async function seedUsers() {
  console.log('\n👥 Seeding hosts...');
  const hostDocuments = await Promise.all(sampleHosts.map(upsertUser));
  const hostsByEmail = new Map(hostDocuments.map((user) => [user.email, user]));

  console.log('\n🙋‍♀️ Seeding guests...');
  await Promise.all(sampleGuests.map(upsertUser));

  return hostsByEmail;
}

async function seedProperties(hostsByEmail) {
  console.log('\n🏡 Seeding properties...');

  for (const property of sampleProperties) {
    const host = hostsByEmail.get(property.hostEmail);
    if (!host) {
      console.warn(`⚠️  Skipping property "${property.title}" — host ${property.hostEmail} not found.`);
      continue;
    }

    const existing = await Property.findOne({ title: property.title });
    if (existing) {
      console.log(`ℹ️  Property already exists: ${property.title}`);
      continue;
    }

    const { hostEmail, ...propertyData } = property;
    const payload = {
      ...propertyData,
      host: host._id,
      approvalStatus: property.approvalStatus || 'approved',
      approvedBy: host._id,
      approvedAt: new Date(),
      status: property.status || 'published',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await Property.create(payload);
    console.log(`✅ Created property: ${property.title}`);
  }
}

async function seedSampleData() {
  try {
    await connectToDatabase();

    const hostsByEmail = await seedUsers();
    await seedProperties(hostsByEmail);

    console.log('\n🎉 Sample data seed complete!');
  } catch (error) {
    console.error('\n❌ Seed failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

seedSampleData();
