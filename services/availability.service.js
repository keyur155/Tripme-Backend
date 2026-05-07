/**
 * Availability Service
 * Handles time-based availability management for 24-hour bookings
 */

const Availability = require('../models/Availability');
const Booking = require('../models/Booking');

class AvailabilityService {
  /**
   * Check if time slot is available
   * @param {string} propertyId - Property ID
   * @param {Date} startDateTime - Start date and time
   * @param {Date} endDateTime - End date and time
   * @returns {Promise<boolean>} True if available
   */
  static async isTimeSlotAvailable(propertyId, startDateTime, endDateTime) {
    try {
      const conflicts = await Availability.find({
        property: propertyId,
        $or: [
          {
            startDateTime: { $lt: endDateTime },
            endDateTime: { $gt: startDateTime }
          }
        ],
        status: { $in: ['booked', 'blocked'] }
      });
      
      return conflicts.length === 0;
    } catch (error) {
      console.error('Error checking time slot availability:', error);
      return false;
    }
  }
  
  /**
   * Block time slot for booking
   * @param {string} propertyId - Property ID
   * @param {Date} startDateTime - Start date and time
   * @param {Date} endDateTime - End date and time
   * @param {string} bookingId - Booking ID
   * @returns {Promise<Object>} Created availability record
   */
  static async blockTimeSlot(propertyId, startDateTime, endDateTime, bookingId) {
    try {
      const duration = (endDateTime - startDateTime) / (1000 * 60 * 60); // hours
      const dateOnly = new Date(
        startDateTime.getFullYear(),
        startDateTime.getMonth(),
        startDateTime.getDate(),
        0, 0, 0, 0
      );
      
      const availability = new Availability({
        property: propertyId,
        date: dateOnly, // satisfy unique property+date index for 24h records
        startDateTime,
        endDateTime,
        duration,
        bookingType: '24hour',
        status: 'booked',
        bookedBy: bookingId,
        bookedAt: new Date()
      });
      
      return await availability.save();
    } catch (error) {
      console.error('Error blocking time slot:', error);
      throw error;
    }
  }
  
  /**
   * Get available time slots for a property
   * @param {string} propertyId - Property ID
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {Promise<Array>} Available time slots
   */
  static async getAvailableTimeSlots(propertyId, startDate, endDate) {
    try {
      // Get all booked/blocked slots in the date range
      const bookedSlots = await Availability.find({
        property: propertyId,
        $or: [
          {
            startDateTime: { $lt: endDate },
            endDateTime: { $gt: startDate }
          }
        ],
        status: { $in: ['booked', 'blocked'] }
      }).sort({ startDateTime: 1 });
      
      // Generate available slots
      const availableSlots = [];
      let currentTime = new Date(startDate);
      
      while (currentTime < endDate) {
        const slotEnd = new Date(currentTime.getTime() + 24 * 60 * 60 * 1000); // 24 hours
        
        // Check if this slot is available
        const isAvailable = await this.isTimeSlotAvailable(propertyId, currentTime, slotEnd);
        
        if (isAvailable) {
          availableSlots.push({
            startDateTime: new Date(currentTime),
            endDateTime: new Date(slotEnd),
            duration: 24
          });
        }
        
        // Move to next day
        currentTime.setDate(currentTime.getDate() + 1);
      }
      
      return availableSlots;
    } catch (error) {
      console.error('Error getting available time slots:', error);
      return [];
    }
  }
  
  /**
   * Calculate next available time after a booking
   * @param {string} propertyId - Property ID
   * @param {Date} checkOutDateTime - Checkout date and time
   * @param {number} bufferHours - Buffer hours for preparation
   * @returns {Promise<Date|null>} Next available time or null
   */
  static async calculateNextAvailableTime(propertyId, checkOutDateTime, bufferHours = 2) {
    try {
      const nextAvailable = new Date(checkOutDateTime);
      nextAvailable.setHours(nextAvailable.getHours() + bufferHours);
      
      // Check if this time conflicts with existing bookings
      const conflicts = await this.isTimeSlotAvailable(
        propertyId, 
        nextAvailable, 
        new Date(nextAvailable.getTime() + 24 * 60 * 60 * 1000)
      );
      
      return conflicts ? null : nextAvailable;
    } catch (error) {
      console.error('Error calculating next available time:', error);
      return null;
    }
  }
  
  /**
   * Release time slot (when booking is cancelled)
   * @param {string} bookingId - Booking ID
   * @returns {Promise<boolean>} Success status
   */
  static async releaseTimeSlot(bookingId) {
    try {
      const result = await Availability.updateMany(
        { bookedBy: bookingId },
        { 
          status: 'available',
          bookedBy: null,
          bookedAt: null
        }
      );
      
      return result.modifiedCount > 0;
    } catch (error) {
      console.error('Error releasing time slot:', error);
      return false;
    }
  }
  
  /**
   * Get property availability for a specific date range
   * @param {string} propertyId - Property ID
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {Promise<Array>} Availability records
   */
  static async getPropertyAvailability(propertyId, startDate, endDate) {
    try {
      return await Availability.find({
        property: propertyId,
        $or: [
          {
            startDateTime: { $lt: endDate },
            endDateTime: { $gt: startDate }
          }
        ]
      }).sort({ startDateTime: 1 });
    } catch (error) {
      console.error('Error getting property availability:', error);
      return [];
    }
  }
  
  /**
   * Check for overlapping bookings
   * @param {string} propertyId - Property ID
   * @param {Date} startDateTime - Start date and time
   * @param {Date} endDateTime - End date and time
   * @param {string} excludeBookingId - Booking ID to exclude from check
   * @returns {Promise<Array>} Overlapping bookings
   */
  static async findOverlappingBookings(propertyId, startDateTime, endDateTime, excludeBookingId = null) {
    try {
      const query = {
        property: propertyId,
        $or: [
          {
            startDateTime: { $lt: endDateTime },
            endDateTime: { $gt: startDateTime }
          }
        ],
        status: { $in: ['booked', 'blocked'] }
      };
      
      if (excludeBookingId) {
        query.bookedBy = { $ne: excludeBookingId };
      }
      
      return await Availability.find(query);
    } catch (error) {
      console.error('Error finding overlapping bookings:', error);
      return [];
    }
  }
}

module.exports = AvailabilityService;

