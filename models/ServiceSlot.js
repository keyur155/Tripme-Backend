const mongoose = require('mongoose');

const serviceSlotSchema = new mongoose.Schema({
  service: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  startTime: {
    type: String, // "08:00", "10:00", "14:00"
    required: true
  },
  endTime: {
    type: String,
    required: true
  },
  capacity: {
    type: Number,
    default: 1,
    min: 1
  },
  bookedCount: {
    type: Number,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    enum: ['available', 'fully_booked', 'blocked', 'expired'],
    default: 'available'
  },
  // Track which bookings hold this slot
  bookings: [{
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking'
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    quantity: {
      type: Number,
      default: 1
    },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'cancelled', 'expired'],
      default: 'pending'
    },
    reservedAt: {
      type: Date,
      default: Date.now
    },
    expiresAt: {
      type: Date
    }
  }],
  // Price override for specific slots (optional)
  priceOverride: {
    type: Number,
    default: null
  },
  metadata: {
    isRecurring: { type: Boolean, default: false },
    recurringPattern: { type: String }, // 'daily', 'weekly', 'weekdays'
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }
}, {
  timestamps: true
});

// Compound index for fast slot lookups
serviceSlotSchema.index({ service: 1, date: 1, startTime: 1 }, { unique: true });
serviceSlotSchema.index({ service: 1, date: 1, status: 1 });
serviceSlotSchema.index({ 'bookings.expiresAt': 1 }); // For expired booking cleanup

// Virtual: available capacity
serviceSlotSchema.virtual('availableCapacity').get(function() {
  return Math.max(0, this.capacity - this.bookedCount);
});

// Method: Check if slot can accept a booking
serviceSlotSchema.methods.canBook = function(quantity = 1) {
  if (this.status === 'blocked' || this.status === 'expired') return false;
  return (this.capacity - this.bookedCount) >= quantity;
};

// Method: Reserve slot for a booking (with expiry for pending bookings)
serviceSlotSchema.methods.reserveSlot = function(bookingId, userId, quantity = 1, expiryMinutes = 15) {
  if (!this.canBook(quantity)) {
    throw new Error(`Slot not available. Capacity: ${this.capacity}, Booked: ${this.bookedCount}, Requested: ${quantity}`);
  }

  this.bookedCount += quantity;
  this.bookings.push({
    booking: bookingId,
    user: userId,
    quantity,
    status: 'pending',
    reservedAt: new Date(),
    expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000)
  });

  if (this.bookedCount >= this.capacity) {
    this.status = 'fully_booked';
  }

  return this;
};

// Method: Confirm a pending booking
serviceSlotSchema.methods.confirmBooking = function(bookingId) {
  const booking = this.bookings.find(
    b => b.booking.toString() === bookingId.toString() && b.status === 'pending'
  );
  if (booking) {
    booking.status = 'confirmed';
    booking.expiresAt = null; // No longer expires
  }
  return this;
};

// Method: Cancel/release a booking
serviceSlotSchema.methods.releaseBooking = function(bookingId) {
  const booking = this.bookings.find(
    b => b.booking.toString() === bookingId.toString() && ['pending', 'confirmed'].includes(b.status)
  );
  if (booking) {
    this.bookedCount = Math.max(0, this.bookedCount - booking.quantity);
    booking.status = 'cancelled';
    if (this.status === 'fully_booked' && this.bookedCount < this.capacity) {
      this.status = 'available';
    }
  }
  return this;
};

// Static: Clean up expired pending bookings
serviceSlotSchema.statics.cleanupExpiredReservations = async function() {
  const now = new Date();
  const expiredSlots = await this.find({
    'bookings': {
      $elemMatch: {
        status: 'pending',
        expiresAt: { $lte: now }
      }
    }
  });

  let cleaned = 0;
  for (const slot of expiredSlots) {
    for (const booking of slot.bookings) {
      if (booking.status === 'pending' && booking.expiresAt && booking.expiresAt <= now) {
        slot.bookedCount = Math.max(0, slot.bookedCount - booking.quantity);
        booking.status = 'expired';
        cleaned++;
      }
    }
    if (slot.status === 'fully_booked' && slot.bookedCount < slot.capacity) {
      slot.status = 'available';
    }
    await slot.save();
  }
  return cleaned;
};

// Static: Get available slots for a service on a date
serviceSlotSchema.statics.getAvailableSlots = async function(serviceId, date) {
  const dateStart = new Date(date);
  dateStart.setHours(0, 0, 0, 0);
  const dateEnd = new Date(date);
  dateEnd.setHours(23, 59, 59, 999);

  // First cleanup expired reservations
  await this.cleanupExpiredReservations();

  return this.find({
    service: serviceId,
    date: { $gte: dateStart, $lte: dateEnd },
    status: { $in: ['available'] }
  }).sort({ startTime: 1 });
};

module.exports = mongoose.model('ServiceSlot', serviceSlotSchema);
