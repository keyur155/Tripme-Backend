const Availability = require('../models/Availability');

const Service = require('../models/Service');
const Property = require('../models/Property');

// ========================================
// NEW: Import AvailabilityEvent Service for hourly availability
// If this causes issues, you can comment out this line and the related functions below
// ========================================
const AvailabilityEventService = require('../services/availabilityEvent.service');

// @desc    Cleanup expired blocked availability (runs automatically)
// @route   Internal function (called by scheduler)
// @access  Private
const cleanupExpiredBlockedAvailability = async () => {
  try {
    const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
    
    // Find all blocked availability records that are older than 3 minutes
    // and haven't been confirmed as booked
    const expiredBlockedRecords = await Availability.find({
      status: 'blocked',
      blockedAt: { $lt: threeMinutesAgo }
    });
    
    if (expiredBlockedRecords.length === 0) {
      return { cleaned: 0, message: 'No expired records to clean' };
    }
    
    // Update all expired blocked records to 'available' status
    const result = await Availability.updateMany(
      {
        status: 'blocked',
        blockedAt: { $lt: threeMinutesAgo }
      },
      {
        $set: {
          status: 'available',
          reason: null
        },
        $unset: {
          blockedBy: 1,
          blockedAt: 1
        }
      }
    );
    
    return {
      cleaned: result.modifiedCount,
      message: `Cleaned up ${result.modifiedCount} expired blocked availability records`
    };
    
  } catch (error) {
    console.error('❌ Error during availability cleanup:', error);
    throw error;
  }
};

// @desc    Get property availability
// @route   GET /api/availability/:propertyId
// @access  Public
const getPropertyAvailability = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { startDate, endDate } = req.query;

    // Validate property exists
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    let query = { property: propertyId };
    const now = new Date();

    // If date range is provided, filter by dates
    let queryStart = now;
    let queryEnd = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days default
    if (startDate && endDate) {
      queryStart = new Date(startDate);
      queryEnd = new Date(endDate);
      query.date = { $gte: queryStart, $lte: queryEnd };
    }

    const availability = await Availability.find(query)
      .sort({ date: 1 })
      .populate({
        path: 'bookedBy',
        select: 'status checkInTime checkOutTime user checkIn checkOut',
        populate: {
          path: 'user',
          select: 'name'
        }
      });

    // ========================================
    // NEW: Fetch ONLY ACTIVE maintenance events (maintenance happening RIGHT NOW)
    // Maintenance should only show if: now >= maintenance_start AND now < maintenance_end
    // ========================================
    const AvailabilityEvent = require('../models/HourlyBasedAvailability');
    
    // Find maintenance that is currently active (started but not ended)
    const activeMaintenanceEvents = await AvailabilityEvent.find({
      property: propertyId,
      eventType: 'maintenance_start',
      time: { $lte: now } // Maintenance has started
    }).sort({ time: -1 });

    // Group ONLY currently active maintenance by date
    const maintenanceByDate = {};
    
    for (const startEvent of activeMaintenanceEvents) {
      // Find the corresponding end event
      const endEvent = await AvailabilityEvent.findOne({
        property: propertyId,
        eventType: 'maintenance_end',
        bookingId: startEvent.bookingId,
        time: { $gt: startEvent.time }
      });
      
      // Only include if maintenance is CURRENTLY ACTIVE (now < end time)
      if (endEvent && now < endEvent.time) {
        const dateStr = startEvent.time.toISOString().split('T')[0];
        maintenanceByDate[dateStr] = {
          start: startEvent.time,
          end: endEvent.time,
          bookingId: startEvent.bookingId
        };
        console.log(`🔧 Active maintenance found: ${dateStr} until ${endEvent.time.toISOString()}`);
      }
    }

    // Collect all checkout dates from bookings to include them even if they don't have Availability records
    const checkoutDatesMap = new Map(); // dateStr -> { booking, checkoutDate, checkoutTime }
    
    // First pass: collect checkout dates from existing availability records
    availability.forEach(slot => {
      const slotObj = slot.toObject();
      if (slotObj.bookedBy && typeof slotObj.bookedBy === 'object' && slotObj.bookedBy.checkOut) {
        const checkoutDate = new Date(slotObj.bookedBy.checkOut);
        const checkoutDateLocal = new Date(checkoutDate.getFullYear(), checkoutDate.getMonth(), checkoutDate.getDate());
        const checkoutDateStr = checkoutDateLocal.toISOString().split('T')[0];
        
        if (!checkoutDatesMap.has(checkoutDateStr)) {
          checkoutDatesMap.set(checkoutDateStr, {
            booking: slotObj.bookedBy,
            checkoutDate: slotObj.bookedBy.checkOut,
            checkoutTime: slotObj.bookedBy.checkOutTime
          });
        }
      }
    });
    
    // Also check for bookings that might not have Availability records for checkout dates
    // Include 'pending' status because bookings wait for host approval but dates should still show as partially-available
    const Booking = require('../models/Booking');
    const futureBookings = await Booking.find({
      property: propertyId,
      status: { $in: ['pending', 'paid', 'confirmed'] },
      checkOut: { $gte: queryStart, $lte: queryEnd }
    }).select('checkOut checkOutTime checkIn checkInTime user').populate('user', 'name');
    
    futureBookings.forEach(booking => {
      if (booking.checkOut) {
        const checkoutDate = new Date(booking.checkOut);
        const checkoutDateLocal = new Date(checkoutDate.getFullYear(), checkoutDate.getMonth(), checkoutDate.getDate());
        const checkoutDateStr = checkoutDateLocal.toISOString().split('T')[0];
        
        // Only add if not already in availability array
        const existsInAvailability = availability.some(slot => {
          const slotDate = new Date(slot.date);
          const slotDateLocal = new Date(slotDate.getFullYear(), slotDate.getMonth(), slotDate.getDate());
          return slotDateLocal.toISOString().split('T')[0] === checkoutDateStr;
        });
        
        if (!existsInAvailability && !checkoutDatesMap.has(checkoutDateStr)) {
          checkoutDatesMap.set(checkoutDateStr, {
            booking: booking,
            checkoutDate: booking.checkOut,
            checkoutTime: booking.checkOutTime
          });
        }
      }
    });

    // Transform to include booking details and maintenance info
    const ensureDate = (val) => {
      if (!val) return null;
      const d = val instanceof Date ? val : new Date(val);
      return isNaN(d.getTime()) ? null : d;
    };

    const availabilityWithDetails = availability.map(slot => {
      const slotObj = slot.toObject();
      const slotDate = ensureDate(slotObj.date);
      if (!slotDate) {
        console.warn('⚠️ Invalid slot date encountered in availability:', slotObj.date);
        slotObj.dateError = 'invalid_date';
        return slotObj;
      }
      const dateStr = slotDate.toISOString().split('T')[0];
      
      // Normalize slot date for comparison (used in multiple places)
      const slotDateLocal = new Date(slotDate.getFullYear(), slotDate.getMonth(), slotDate.getDate());
      const slotDateStr = slotDateLocal.toISOString().split('T')[0];
      
      if (slotObj.bookedBy && typeof slotObj.bookedBy === 'object') {
        slotObj.checkInDate = slotObj.bookedBy.checkIn;
        slotObj.checkOutDate = slotObj.bookedBy.checkOut;
        slotObj.checkInTime = slotObj.bookedBy.checkInTime;
        slotObj.checkOutTime = slotObj.bookedBy.checkOutTime;
        slotObj.guestName = slotObj.bookedBy.user?.name;
        
        // ========================================
        // NEW: Check if this is checkout date and maintenance has ended
        // If checkout date + maintenance ended, mark as available
        // ========================================
        if (!slotObj.checkOutDate) {
          console.log(`⚠️ No checkout date found for slot ${dateStr}`);
        } else {
          const checkoutDate = new Date(slotObj.checkOutDate);
          // Use local date string for comparison to avoid timezone issues
          const checkoutDateLocal = new Date(checkoutDate.getFullYear(), checkoutDate.getMonth(), checkoutDate.getDate());
          const checkoutDateStr = checkoutDateLocal.toISOString().split('T')[0];
          
          console.log(`🔍 Comparing dates: slotDate=${slotDateStr}, checkoutDate=${checkoutDateStr}, status=${slotObj.status}`);
          
          // If this date is the checkout date - process it regardless of current status
          // (it might be 'partially-available', 'booked', or 'blocked')
          // BUT: Skip processing if booking is cancelled - respect host's manual status change
          if (slotDateStr === checkoutDateStr) {
            // Check if booking is cancelled - if so, skip checkout date processing
            const bookingStatus = slotObj.bookedBy?.status;
            const inactiveStatuses = ['cancelled', 'rejected', 'expired'];
            
            if (bookingStatus && inactiveStatuses.includes(bookingStatus)) {
              console.log(`⚠️ Booking is ${bookingStatus} - skipping checkout date processing, respecting current status: ${slotObj.status}`);
              // Don't process as checkout date - respect the current status (likely manually set by host)
              // Continue to next iteration
            } else {
              console.log(`✅ Processing checkout date: ${slotDateStr} (slot status: ${slotObj.status}, checkoutTime: ${slotObj.checkOutTime || 'N/A'})`);
              
              // Get maintenance hours from property
              const maintenanceHours = property?.availabilitySettings?.hostBufferTime || 2;
            
            // Create checkout datetime using the LOCAL date string (not UTC) to avoid timezone shifts
            // Use the normalized checkoutDateStr to build the date in local timezone
            const [year, month, day] = checkoutDateStr.split('-').map(Number);
            const checkoutTime = new Date(year, month - 1, day, 0, 0, 0, 0); // month is 0-indexed
            
            if (slotObj.checkOutTime) {
              const [hours, minutes] = slotObj.checkOutTime.split(':').map(Number);
              // Set local hours to keep it on the same date
              checkoutTime.setHours(hours, minutes, 0, 0);
            } else {
              // Default to 3 PM if no checkout time
              checkoutTime.setHours(15, 0, 0, 0);
            }
            
            const maintenanceEndTime = new Date(checkoutTime.getTime() + maintenanceHours * 60 * 60 * 1000);
            
            console.log(`  🕐 Checkout time calculation:`, {
              checkoutDate: checkoutDate.toISOString(),
              checkOutTime: slotObj.checkOutTime,
              checkoutTimeLocal: checkoutTime.toISOString(),
              maintenanceHours,
              maintenanceEndTimeLocal: maintenanceEndTime.toISOString()
            });
            
            // Check if checkout date is today or in the past
            const checkoutDateOnly = new Date(checkoutDate);
            checkoutDateOnly.setUTCHours(0, 0, 0, 0);
            const todayOnly = new Date(now);
            todayOnly.setUTCHours(0, 0, 0, 0);
            const isCheckoutTodayOrPast = checkoutDateOnly <= todayOnly;
            
            console.log(`  📅 Checkout: ${checkoutTime.toISOString()}, Maintenance ends: ${maintenanceEndTime.toISOString()}, Now: ${now.toISOString()}`);
            console.log(`  📆 Checkout date is today or past? ${isCheckoutTodayOrPast}`);
            console.log(`  ⏰ Maintenance ended? ${now >= maintenanceEndTime}`);
            
            // Make checkout date available if:
            // 1. Maintenance has ended (past or today), OR
            // 2. It's a future date (user can select it with check-in time after maintenance end)
            // But always include maintenance info so frontend can validate check-in time
            if (isCheckoutTodayOrPast && now >= maintenanceEndTime) {
              // Maintenance has ended - fully available
              slotObj.status = 'available';
              slotObj.maintenance = {
                start: checkoutTime,
                end: maintenanceEndTime,
                availableAfter: maintenanceEndTime,
                ended: true
              };
              console.log(`✅ Checkout date ${dateStr} is now available (maintenance ended at ${maintenanceEndTime.toISOString()})`);
            } else if (isCheckoutTodayOrPast && now >= checkoutTime && now < maintenanceEndTime) {
              // Maintenance is currently active (today, between checkout and maintenance end)
              slotObj.status = 'maintenance';
              slotObj.maintenance = {
                start: checkoutTime,
                end: maintenanceEndTime,
                availableAfter: maintenanceEndTime
              };
              console.log(`🔧 Checkout date ${dateStr} is in maintenance until ${maintenanceEndTime.toISOString()}`);
            } else {
              // Future checkout date - partially available (available after maintenance ends)
              // User can select this date, but must choose check-in time AFTER maintenance end
              slotObj.status = 'partially-available';
              slotObj.maintenance = {
                start: checkoutTime,
                end: maintenanceEndTime,
                availableAfter: maintenanceEndTime,
                requiresLaterCheckIn: true // Flag to indicate check-in must be after this time
              };
              console.log(`✅ Checkout date ${dateStr} partially available (check-in must be after ${maintenanceEndTime.toISOString()})`);
            }
            } // Close else block for active booking checkout date processing
          } // Close the nested if for checkout date match
        } // Close the else block for checkOutDate check
      }

      // Check if this date is a checkout date from checkoutDatesMap (even if it doesn't have bookedBy)
      // This handles cases where checkout date was marked as 'partially-available' but bookedBy wasn't populated
      if (!slotObj.bookedBy && checkoutDatesMap.has(dateStr)) {
        const checkoutInfo = checkoutDatesMap.get(dateStr);
        const checkoutDate = ensureDate(checkoutInfo.checkoutDate);
        if (!checkoutDate) {
          console.warn('⚠️ Invalid checkoutDate in checkoutInfo', checkoutInfo.checkoutDate);
          return slotObj; // leave slot unchanged for this entry
        }
        const checkoutDateLocal = new Date(checkoutDate.getFullYear(), checkoutDate.getMonth(), checkoutDate.getDate());
        const checkoutDateStr = checkoutDateLocal.toISOString().split('T')[0];
        
        if (slotDateStr === checkoutDateStr) {
          // Check if booking is cancelled - if so, skip checkout date processing
          const bookingStatus = checkoutInfo.booking?.status;
          const inactiveStatuses = ['cancelled', 'rejected', 'expired'];
          
          if (bookingStatus && inactiveStatuses.includes(bookingStatus)) {
            console.log(`⚠️ Booking is ${bookingStatus} - skipping checkout date processing from checkoutDatesMap, respecting current status: ${slotObj.status}`);
            // Don't process as checkout date - respect the current status (likely manually set by host)
            // Continue to next iteration
          } else {
            console.log(`✅ Found checkout date ${dateStr} in checkoutDatesMap (no bookedBy), processing...`);
            
            // Get maintenance hours from property
            const maintenanceHours = property?.availabilitySettings?.hostBufferTime || 2;
          
          // Create checkout datetime
          const [year, month, day] = checkoutDateStr.split('-').map(Number);
          const checkoutTime = new Date(year, month - 1, day, 0, 0, 0, 0);
          
          if (checkoutInfo.checkoutTime) {
            const [hours, minutes] = checkoutInfo.checkoutTime.split(':').map(Number);
            checkoutTime.setHours(hours, minutes, 0, 0);
          } else {
            checkoutTime.setHours(15, 0, 0, 0); // Default 3 PM
          }
          
          const maintenanceEndTime = new Date(checkoutTime.getTime() + maintenanceHours * 60 * 60 * 1000);
          
          // Check if it's a future date
          const checkoutDateOnly = new Date(checkoutDate);
          checkoutDateOnly.setUTCHours(0, 0, 0, 0);
          const todayOnly = new Date(now);
          todayOnly.setUTCHours(0, 0, 0, 0);
          const isCheckoutTodayOrPast = checkoutDateOnly <= todayOnly;
          
          // Set booking info
          slotObj.checkInDate = checkoutInfo.booking.checkIn;
          slotObj.checkOutDate = checkoutInfo.checkoutDate;
          slotObj.checkInTime = checkoutInfo.booking.checkInTime;
          slotObj.checkOutTime = checkoutInfo.checkoutTime;
          slotObj.guestName = checkoutInfo.booking.user?.name;
          
          if (isCheckoutTodayOrPast && now >= maintenanceEndTime) {
            slotObj.status = 'available';
            slotObj.maintenance = {
              start: checkoutTime,
              end: maintenanceEndTime,
              availableAfter: maintenanceEndTime,
              ended: true
            };
          } else if (isCheckoutTodayOrPast && now >= checkoutTime && now < maintenanceEndTime) {
            slotObj.status = 'maintenance';
            slotObj.maintenance = {
              start: checkoutTime,
              end: maintenanceEndTime,
              availableAfter: maintenanceEndTime
            };
          } else {
            slotObj.status = 'partially-available';
            slotObj.maintenance = {
              start: checkoutTime,
              end: maintenanceEndTime,
              availableAfter: maintenanceEndTime,
              requiresLaterCheckIn: true
            };
          }
          } // Close else block for active booking checkout date processing from checkoutDatesMap
        }
      }

      // Add maintenance info if exists for this date (for non-checkout dates)
      if (!slotObj.maintenance && maintenanceByDate[dateStr]) {
        slotObj.maintenance = {
          start: maintenanceByDate[dateStr].start,
          end: maintenanceByDate[dateStr].end,
          availableAfter: maintenanceByDate[dateStr].end
        };
      }

      return slotObj;
    });

    // Add checkout dates that don't have Availability records (for partially-available status)
    for (const [checkoutDateStr, checkoutInfo] of checkoutDatesMap.entries()) {
      const existsInAvailability = availabilityWithDetails.some(
        slot => {
          const slotDate = ensureDate(slot.date);
          if (!slotDate) return false;
          const slotDateLocal = new Date(slotDate.getFullYear(), slotDate.getMonth(), slotDate.getDate());
          return slotDateLocal.toISOString().split('T')[0] === checkoutDateStr;
        }
      );
      
      if (!existsInAvailability) {
        // Check if booking is cancelled - if so, skip adding checkout date
        const bookingStatus = checkoutInfo.booking?.status;
        const inactiveStatuses = ['cancelled', 'rejected', 'expired'];
        
        if (bookingStatus && inactiveStatuses.includes(bookingStatus)) {
          console.log(`⚠️ Booking is ${bookingStatus} - skipping adding checkout date ${checkoutDateStr} to availability (cancelled booking)`);
          continue; // Skip this checkout date
        }
        
        // This is a checkout date without an Availability record - add it as partially-available
        const checkoutDate = new Date(checkoutInfo.checkoutDate);
        const [year, month, day] = checkoutDateStr.split('-').map(Number);
        const checkoutTime = new Date(year, month - 1, day, 0, 0, 0, 0);
        
        if (checkoutInfo.checkoutTime) {
          const [hours, minutes] = checkoutInfo.checkoutTime.split(':').map(Number);
          checkoutTime.setHours(hours, minutes, 0, 0);
        } else {
          checkoutTime.setHours(15, 0, 0, 0); // Default 3 PM
        }
        
        const maintenanceHours = property?.availabilitySettings?.hostBufferTime || 2;
        const maintenanceEndTime = new Date(checkoutTime.getTime() + maintenanceHours * 60 * 60 * 1000);
        
        // Check if it's a future date
        const checkoutDateOnly = new Date(checkoutDate);
        checkoutDateOnly.setUTCHours(0, 0, 0, 0);
        const todayOnly = new Date(now);
        todayOnly.setUTCHours(0, 0, 0, 0);
        const isCheckoutTodayOrPast = checkoutDateOnly <= todayOnly;
        
        if (!isCheckoutTodayOrPast) {
          // Future checkout date - partially available
          // Create date object properly to avoid timezone issues
          const checkoutDateObj = new Date(year, month - 1, day);
          availabilityWithDetails.push({
            date: checkoutDateObj,
            status: 'partially-available',
            checkInDate: checkoutInfo.booking.checkIn,
            checkOutDate: checkoutInfo.checkoutDate,
            checkInTime: checkoutInfo.booking.checkInTime,
            checkOutTime: checkoutInfo.checkoutTime,
            guestName: checkoutInfo.booking.user?.name,
            maintenance: {
              start: checkoutTime,
              end: maintenanceEndTime,
              availableAfter: maintenanceEndTime,
              requiresLaterCheckIn: true
            }
          });
          console.log(`📅 Added checkout date ${checkoutDateStr} as partially-available (available after ${maintenanceEndTime.toISOString()})`);
          console.log(`   Date object: ${checkoutDateObj.toISOString()}, Status: partially-available`);
        }
      }
    }

    // Also check for maintenance on dates that don't have daily availability records
    // (e.g., checkout day where maintenance runs but no booking exists for that date)
    // Only add if maintenance is CURRENTLY ACTIVE
    const todayStr = now.toISOString().split('T')[0];
    
    for (const dateStr of Object.keys(maintenanceByDate)) {
      // Only show maintenance for TODAY's date (maintenance is time-based, not date-based)
      if (dateStr !== todayStr) continue;
      
      const existsInAvailability = availabilityWithDetails.some(
        slot => new Date(slot.date).toISOString().split('T')[0] === dateStr
      );
      
      if (!existsInAvailability) {
        // Maintenance is confirmed active (already checked in the loop above)
        availabilityWithDetails.push({
          date: new Date(dateStr),
          status: 'maintenance',
          maintenance: {
            start: maintenanceByDate[dateStr].start,
            end: maintenanceByDate[dateStr].end,
            availableAfter: maintenanceByDate[dateStr].end
          }
        });
        console.log(`📅 Added maintenance entry for today: ${dateStr}`);
      }
    }

    // Sort by date after adding maintenance-only entries
    availabilityWithDetails.sort((a, b) => new Date(a.date) - new Date(b.date));
    // console.log('availabilityWithDetails', availabilityWithDetails);
    console.log('property.availabilitySettings?.hostBufferTime', property.availabilitySettings?.hostBufferTime);
    res.status(200).json({
      success: true,
      data: { 
        availability: availabilityWithDetails,
        maintenanceHours: property.availabilitySettings?.hostBufferTime || 2
      }
    });
  } catch (error) {
    console.error('❌ Error fetching availability:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching availability',
      error: error.message
    });
  }
};

// @desc    Get availability for a date range
// @route   GET /api/availability/:propertyId/range
// @access  Public
const getAvailabilityRange = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Start date and end date are required'
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (start >= end) {
      return res.status(400).json({
        success: false,
        message: 'Start date must be before end date'
      });
    }

    // Validate property exists
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const availability = await Availability.find({
      property: propertyId,
      date: { $gte: start, $lte: end }
    }).sort({ date: 1 });

    res.status(200).json({
      success: true,
      data: { availability }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching availability range',
      error: error.message
    });
  }
};

// @desc    Create availability entry
// @route   POST /api/availability/:propertyId
// @access  Private (Host only)
const createAvailability = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { date, status, reason, availableHours, unavailableHours, onHoldHours } = req.body;

    // Check if user is the host of this property
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    // Allow users to update availability for booking purposes (on-hold, booked, available, blocked)
    // but restrict other operations to property hosts only
    if (property.host.toString() !== req.user._id.toString()) {
      // Check if this is a booking-related status update
      if (status && ['on-hold', 'booked', 'available', 'blocked'].includes(status)) {
        // Allow booking-related status updates for any authenticated user
        // This enables the booking flow to work properly
      } else {
        return res.status(403).json({
          success: false,
          message: 'You can only manage availability for your own properties'
        });
      }
    }

    // Validate availableHours if provided
    if (availableHours !== undefined) {
      if (Array.isArray(availableHours)) {
        for (const range of availableHours) {
          if (!range.startTime || !range.endTime) {
            return res.status(400).json({
              success: false,
              message: 'Each hour range must have startTime and endTime'
            });
          }
          // Validate time format
          const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
          if (!timeRegex.test(range.startTime) || !timeRegex.test(range.endTime)) {
            return res.status(400).json({
              success: false,
              message: 'Time must be in HH:MM format (00:00-23:59)'
            });
          }
          // Validate endTime > startTime
          const [startH, startM] = range.startTime.split(':').map(Number);
          const [endH, endM] = range.endTime.split(':').map(Number);
          if (endH * 60 + endM <= startH * 60 + startM) {
            return res.status(400).json({
              success: false,
              message: 'endTime must be after startTime'
            });
          }
        }
      } else if (availableHours !== null) {
        return res.status(400).json({
          success: false,
          message: 'availableHours must be an array or null'
        });
      }
    }

    // Validate unavailableHours if provided
    if (unavailableHours !== undefined) {
      if (Array.isArray(unavailableHours)) {
        for (const range of unavailableHours) {
          if (!range.startTime || !range.endTime) {
            return res.status(400).json({
              success: false,
              message: 'Each unavailable hour range must have startTime and endTime'
            });
          }
          // Validate time format
          const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
          if (!timeRegex.test(range.startTime) || !timeRegex.test(range.endTime)) {
            return res.status(400).json({
              success: false,
              message: 'Time must be in HH:MM format (00:00-23:59)'
            });
          }
          // Validate endTime > startTime
          const [startH, startM] = range.startTime.split(':').map(Number);
          const [endH, endM] = range.endTime.split(':').map(Number);
          if (endH * 60 + endM <= startH * 60 + startM) {
            return res.status(400).json({
              success: false,
              message: 'endTime must be after startTime'
            });
          }
        }
      } else if (unavailableHours !== null) {
        return res.status(400).json({
          success: false,
          message: 'unavailableHours must be an array or null'
        });
      }
    }

    // Validate onHoldHours if provided
    if (onHoldHours !== undefined) {
      if (Array.isArray(onHoldHours)) {
        for (const range of onHoldHours) {
          if (!range.startTime || !range.endTime) {
            return res.status(400).json({
              success: false,
              message: 'Each on-hold hour range must have startTime and endTime'
            });
          }
          // Validate time format
          const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
          if (!timeRegex.test(range.startTime) || !timeRegex.test(range.endTime)) {
            return res.status(400).json({
              success: false,
              message: 'Time must be in HH:MM format (00:00-23:59)'
            });
          }
          // Validate endTime > startTime
          const [startH, startM] = range.startTime.split(':').map(Number);
          const [endH, endM] = range.endTime.split(':').map(Number);
          if (endH * 60 + endM <= startH * 60 + startM) {
            return res.status(400).json({
              success: false,
              message: 'endTime must be after startTime'
            });
          }
        }
      } else if (onHoldHours !== null) {
        return res.status(400).json({
          success: false,
          message: 'onHoldHours must be an array or null'
        });
      }
    }

    // Check if availability already exists for this date
    const existingAvailability = await Availability.findOne({
      property: propertyId,
      date: new Date(date)
    });

    if (existingAvailability) {
      return res.status(400).json({
        success: false,
        message: 'Availability already exists for this date'
      });
    }

    const availability = await Availability.create({
      property: propertyId,
      date: new Date(date),
      status: status || 'unavailable',  // Default to unavailable - host must explicitly set as available
      reason: reason || null,
      availableHours: availableHours || [], // Add availableHours
      unavailableHours: unavailableHours || [] // Add unavailableHours
    });

    res.status(201).json({
      success: true,
      message: 'Availability created successfully',
      data: { availability }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating availability',
      error: error.message
    });
  }
};

// @desc    Update availability entry
// @route   PUT /api/availability/:propertyId/:availabilityId
// @access  Private (Host only)
const updateAvailability = async (req, res) => {
  try {
    const { propertyId, availabilityId } = req.params;
    const { date, status, reason, availableHours, unavailableHours, onHoldHours } = req.body;

    // Check if user is the host of this property
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    // Allow users to update availability for booking purposes (on-hold, booked, available, blocked)
    // but restrict other operations to property hosts only
    if (property.host.toString() !== req.user._id.toString()) {
      // Check if this is a booking-related status update
      if (status && ['on-hold', 'booked', 'available', 'blocked'].includes(status)) {
        // Allow booking-related status updates for any authenticated user
        // This enables the booking flow to work properly
      } else {
        return res.status(403).json({
          success: false,
          message: 'You can only manage availability for your own properties'
        });
      }
    }

    // Validate availableHours if provided
    if (availableHours !== undefined) {
      if (Array.isArray(availableHours)) {
        for (const range of availableHours) {
          if (!range.startTime || !range.endTime) {
            return res.status(400).json({
              success: false,
              message: 'Each hour range must have startTime and endTime'
            });
          }
          const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
          if (!timeRegex.test(range.startTime) || !timeRegex.test(range.endTime)) {
            return res.status(400).json({
              success: false,
              message: 'Time must be in HH:MM format (00:00-23:59)'
            });
          }
          const [startH, startM] = range.startTime.split(':').map(Number);
          const [endH, endM] = range.endTime.split(':').map(Number);
          if (endH * 60 + endM <= startH * 60 + startM) {
            return res.status(400).json({
              success: false,
              message: 'endTime must be after startTime'
            });
          }
        }
      } else if (availableHours !== null) {
        return res.status(400).json({
          success: false,
          message: 'availableHours must be an array or null'
        });
      }
    }

    // Validate unavailableHours if provided
    if (unavailableHours !== undefined) {
      if (Array.isArray(unavailableHours)) {
        for (const range of unavailableHours) {
          if (!range.startTime || !range.endTime) {
            return res.status(400).json({
              success: false,
              message: 'Each unavailable hour range must have startTime and endTime'
            });
          }
          const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
          if (!timeRegex.test(range.startTime) || !timeRegex.test(range.endTime)) {
            return res.status(400).json({
              success: false,
              message: 'Time must be in HH:MM format (00:00-23:59)'
            });
          }
          const [startH, startM] = range.startTime.split(':').map(Number);
          const [endH, endM] = range.endTime.split(':').map(Number);
          if (endH * 60 + endM <= startH * 60 + startM) {
            return res.status(400).json({
              success: false,
              message: 'endTime must be after startTime'
            });
          }
        }
      } else if (unavailableHours !== null) {
        return res.status(400).json({
          success: false,
          message: 'unavailableHours must be an array or null'
        });
      }
    }

    // Validate onHoldHours if provided
    if (onHoldHours !== undefined) {
      if (Array.isArray(onHoldHours)) {
        for (const range of onHoldHours) {
          if (!range.startTime || !range.endTime) {
            return res.status(400).json({
              success: false,
              message: 'Each on-hold hour range must have startTime and endTime'
            });
          }
          const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
          if (!timeRegex.test(range.startTime) || !timeRegex.test(range.endTime)) {
            return res.status(400).json({
              success: false,
              message: 'Time must be in HH:MM format (00:00-23:59)'
            });
          }
          const [startH, startM] = range.startTime.split(':').map(Number);
          const [endH, endM] = range.endTime.split(':').map(Number);
          if (endH * 60 + endM <= startH * 60 + startM) {
            return res.status(400).json({
              success: false,
              message: 'endTime must be after startTime'
            });
          }
        }
      } else if (onHoldHours !== null) {
        return res.status(400).json({
          success: false,
          message: 'onHoldHours must be an array or null'
        });
      }
    }

    // If availabilityId is undefined or invalid, create a new availability record
    if (!availabilityId || availabilityId === 'undefined') {
      if (!date) {
        return res.status(400).json({
          success: false,
          message: 'Date is required when creating new availability'
        });
      }

      // Check if availability already exists for this date
      const existingAvailability = await Availability.findOne({
        property: propertyId,
        date: new Date(date)
      });

      if (existingAvailability) {
        // ========================================
        // VALIDATION: Prevent hosts from overriding booked/partially-available dates
        // Allow changes if booking is cancelled, rejected, or expired
        // ========================================
        const currentStatus = existingAvailability.status;
        const Booking = require('../models/Booking');
        
        // Prevent changing "booked" status - these are confirmed bookings
        if (currentStatus === 'booked' && status && status !== 'booked') {
          // Check if there's a booking associated with this date
          const booking = existingAvailability.bookedBy 
            ? await Booking.findById(existingAvailability.bookedBy)
            : null;
          
          if (booking) {
            // Allow change if booking is cancelled, rejected, or expired
            const inactiveStatuses = ['cancelled', 'rejected', 'expired'];
            if (!inactiveStatuses.includes(booking.status)) {
              return res.status(403).json({
                success: false,
                message: 'Cannot change status of a booked date. This date has an active booking and cannot be modified.'
              });
            }
            // If booking is cancelled/rejected/expired, allow the change
          } else {
            // No booking found but status is booked - allow change (might be data inconsistency)
          }
        }
        
        // Prevent changing "partially-available" to "available" unless maintenance time has passed or booking is cancelled
        if (currentStatus === 'partially-available' && status === 'available') {
          // Check if there's a booking associated with this date
          const booking = existingAvailability.bookedBy 
            ? await Booking.findById(existingAvailability.bookedBy)
            : null;
          
          if (booking) {
            // Allow change if booking is cancelled, rejected, or expired
            const inactiveStatuses = ['cancelled', 'rejected', 'expired'];
            if (inactiveStatuses.includes(booking.status)) {
              // Booking is cancelled - allow the change
              console.log(`✅ Booking is cancelled/rejected/expired - allowing change from partially-available to available`);
            } else {
              console.log('Booking is active - checking if maintenance time has passed' , booking.checkOutTime);
              // Booking is active - check if maintenance time has passed
              const maintenanceHours = property?.availabilitySettings?.hostBufferTime || 2;
              const checkoutTime = booking.checkOutTime || '11:00';
              const [checkoutHour, checkoutMinute] = checkoutTime.split(':').map(Number);
              
              const checkoutDate = new Date(booking.checkOut);
              const checkoutDateTime = new Date(checkoutDate);
              checkoutDateTime.setHours(checkoutHour, checkoutMinute, 0, 0);
              
              const maintenanceEndTime = new Date(checkoutDateTime.getTime() + maintenanceHours * 60 * 60 * 1000);
              const now = new Date();
              
              if (now < maintenanceEndTime) {
                console.log('Maintenance time has not passed' , maintenanceEndTime);
                return res.status(403).json({
                  success: false,
                  message: `Cannot change partially-available date to available. Property is in maintenance until ${maintenanceEndTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.`,
                  maintenanceEndTime: maintenanceEndTime.toISOString()
                });
              }
            }
          } else {
            // No booking found - this could mean:
            // 1. Booking was cancelled and bookedBy was cleared
            // 2. Data inconsistency
            // Since status is partially-available but no booking reference, allow the change
            // (The host should be able to manually fix this)
            console.log(`⚠️ Partially-available date ${dateStr} has no bookedBy reference - allowing change (likely cancelled booking)`);
            // Allow the change - don't return error
          }
        }
        
        // Update existing record
        existingAvailability.status = status !== undefined ? status : existingAvailability.status;
        existingAvailability.reason = reason !== undefined ? reason : existingAvailability.reason;
        if (availableHours !== undefined) {
          existingAvailability.availableHours = availableHours;
        }
        if (unavailableHours !== undefined) {
          existingAvailability.unavailableHours = unavailableHours;
        }
        if (onHoldHours !== undefined) {
          existingAvailability.onHoldHours = onHoldHours;
        }
        await existingAvailability.save();

        return res.status(200).json({
          success: true,
          message: 'Availability updated successfully',
          data: { availability: existingAvailability }
        });
      } else {
        // Create new record
        const newAvailability = await Availability.create({
          property: propertyId,
          date: new Date(date),
          status: status || 'unavailable',  // Default to unavailable - host must explicitly set as available
          reason: reason || null,
          availableHours: availableHours || [],
          unavailableHours: unavailableHours || [],
          onHoldHours: onHoldHours || []
        });

        return res.status(201).json({
          success: true,
          message: 'Availability created successfully',
          data: { availability: newAvailability }
        });
      }
    }

    // Handle case where we have a valid availabilityId
    else {
      const availability = await Availability.findById(availabilityId);
      if (!availability) {
        return res.status(404).json({
          success: false,
          message: 'Availability entry not found'
        });
      }

      if (availability.property.toString() !== propertyId) {
        return res.status(400).json({
          success: false,
          message: 'Availability entry does not belong to this property'
        });
      }

      // ========================================
      // VALIDATION: Prevent hosts from overriding booked/partially-available dates
      // Allow changes if booking is cancelled, rejected, or expired
      // ========================================
      const currentStatus = availability.status;
      const Booking = require('../models/Booking');
      
      // Prevent changing "booked" status - these are confirmed bookings
      if (currentStatus === 'booked' && status && status !== 'booked') {
        // Check if there's a booking associated with this date
        const booking = availability.bookedBy 
          ? await Booking.findById(availability.bookedBy)
          : null;
        
        if (booking) {
          // Allow change if booking is cancelled, rejected, or expired
          const inactiveStatuses = ['cancelled', 'rejected', 'expired'];
          if (!inactiveStatuses.includes(booking.status)) {
            return res.status(403).json({
              success: false,
              message: 'Cannot change status of a booked date. This date has an active booking and cannot be modified.'
            });
          }
          // If booking is cancelled/rejected/expired, allow the change
        } else {
          // No booking found but status is booked - allow change (might be data inconsistency)
        }
      }
      
      // Prevent changing "partially-available" to "available" unless maintenance time has passed or booking is cancelled
      if (currentStatus === 'partially-available' && status === 'available') {
        // Check if there's a booking associated with this date
        const booking = availability.bookedBy 
          ? await Booking.findById(availability.bookedBy)
          : null;
        
        if (booking) {
          // Allow change if booking is cancelled, rejected, or expired
          const inactiveStatuses = ['cancelled', 'rejected', 'expired'];
          if (inactiveStatuses.includes(booking.status)) {
            // Booking is cancelled - allow the change
            console.log(`✅ Booking is cancelled/rejected/expired - allowing change from partially-available to available`);
          } else {
            // Booking is active - check if maintenance time has passed
            console.log('Booking is active - checking if maintenance time has passed' , booking.checkOutTime);
            const maintenanceHours = property?.availabilitySettings?.hostBufferTime || 2;
            const checkoutTime = booking.checkOutTime || '11:00';
            const [checkoutHour, checkoutMinute] = checkoutTime.split(':').map(Number);
            
            const checkoutDate = new Date(booking.checkOut);
            const checkoutDateTime = new Date(checkoutDate);
            checkoutDateTime.setHours(checkoutHour, checkoutMinute, 0, 0);
            
            const maintenanceEndTime = new Date(checkoutDateTime.getTime() + maintenanceHours * 60 * 60 * 1000);
            const now = new Date();
            
            if (now < maintenanceEndTime) {
              console.log('Maintenance time has not passed' , maintenanceEndTime);
              return res.status(403).json({
                success: false,
                message: `Cannot change partially-available date to available. Property is in maintenance until ${maintenanceEndTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.`,
                maintenanceEndTime: maintenanceEndTime.toISOString()
              });
            }
          }
        } else {
          // No booking found - this could mean:
          // 1. Booking was cancelled and bookedBy was cleared
          // 2. Data inconsistency
          // Since status is partially-available but no booking reference, allow the change
          // (The host should be able to manually fix this)
          const dateStr = new Date(availability.date).toISOString().split('T')[0];
          console.log(`⚠️ Partially-available date ${dateStr} has no bookedBy reference - allowing change (likely cancelled booking)`);
          // Allow the change - don't return error
        }
      }

      availability.status = status !== undefined ? status : availability.status;
      availability.reason = reason !== undefined ? reason : availability.reason;
      if (availableHours !== undefined) {
        availability.availableHours = availableHours;
      }
      if (unavailableHours !== undefined) {
        availability.unavailableHours = unavailableHours;
      }
      if (onHoldHours !== undefined) {
        availability.onHoldHours = onHoldHours;
      }
      await availability.save();

      res.status(200).json({
        success: true,
        message: 'Availability updated successfully',
        data: { availability }
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating availability',
      error: error.message
    });
  }
};

// @desc    Delete availability entry
// @route   DELETE /api/availability/:propertyId/:availabilityId
// @access  Private (Host only)
const deleteAvailability = async (req, res) => {
  try {
    const { propertyId, availabilityId } = req.params;

    // Check if user is the host of this property
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    if (property.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only manage availability for your own properties'
      });
    }

    const availability = await Availability.findById(availabilityId);
    if (!availability) {
      return res.status(404).json({
        success: false,
        message: 'Availability entry not found'
      });
    }

    if (availability.property.toString() !== propertyId) {
      return res.status(400).json({
        success: false,
        message: 'Availability entry does not belong to this property'
      });
    }

    await Availability.findByIdAndDelete(availabilityId);

    res.status(200).json({
      success: true,
      message: 'Availability deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting availability',
      error: error.message
    });
  }
};

// @desc    Bulk update availability
// @route   POST /api/availability/:propertyId/bulk
// @access  Private (Host only)
const bulkUpdateAvailability = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { updates } = req.body; // Array of { date, status, reason }

    // Check if user is the host of this property
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    if (property.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only manage availability for your own properties'
      });
    }

    // ========================================
    // VALIDATION: Check each update for booked/partially-available dates
    // Allow changes if booking is cancelled, rejected, or expired
    // ========================================
    const Booking = require('../models/Booking');
    const now = new Date();
    const maintenanceHours = property?.availabilitySettings?.hostBufferTime || 2;
    
    for (const update of updates) {
      const existingAvailability = await Availability.findOne({
        property: propertyId,
        date: new Date(update.date)
      });
      
      if (existingAvailability) {
        const currentStatus = existingAvailability.status;
        
        // Prevent changing "booked" status
        if (currentStatus === 'booked' && update.status && update.status !== 'booked') {
          const booking = existingAvailability.bookedBy 
            ? await Booking.findById(existingAvailability.bookedBy)
            : null;
          
          if (booking) {
            // Allow change if booking is cancelled, rejected, or expired
            const inactiveStatuses = ['cancelled', 'rejected', 'expired'];
            if (!inactiveStatuses.includes(booking.status)) {
              return res.status(403).json({
                success: false,
                message: `Cannot change status of booked date ${update.date}. This date has an active booking and cannot be modified.`,
                date: update.date
              });
            }
            // If booking is cancelled/rejected/expired, allow the change
          } else {
            // No booking found but status is booked - allow change (might be data inconsistency)
          }
        }
        
        // Prevent changing "partially-available" to "available" unless maintenance time has passed or booking is cancelled
        if (currentStatus === 'partially-available' && update.status === 'available') {
          const booking = existingAvailability.bookedBy 
            ? await Booking.findById(existingAvailability.bookedBy)
            : null;
          
          if (booking) {
            // Allow change if booking is cancelled, rejected, or expired
            const inactiveStatuses = ['cancelled', 'rejected', 'expired'];
            if (inactiveStatuses.includes(booking.status)) {
              // Booking is cancelled - allow the change
              console.log(`✅ Booking is cancelled/rejected/expired - allowing change from partially-available to available for date ${update.date}`);
            } else {
              // Booking is active - check if maintenance time has passed
              console.log('Booking is active - checking if maintenance time has passed' , booking.checkOutTime);
              const checkoutTime = booking.checkOutTime || '11:00';
              const [checkoutHour, checkoutMinute] = checkoutTime.split(':').map(Number);
              
              const checkoutDate = new Date(booking.checkOut);
              const checkoutDateTime = new Date(checkoutDate);
              checkoutDateTime.setHours(checkoutHour, checkoutMinute, 0, 0);
              
              const maintenanceEndTime = new Date(checkoutDateTime.getTime() + maintenanceHours * 60 * 60 * 1000);
              
              if (now < maintenanceEndTime) {
                console.log('Maintenance time has not passed' , maintenanceEndTime);
                return res.status(403).json({
                  success: false,
                  message: `Cannot change partially-available date ${update.date} to available. Property is in maintenance until ${maintenanceEndTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.`,
                  date: update.date,
                  maintenanceEndTime: maintenanceEndTime.toISOString()
                });
              }
            }
          } else {
            // No booking found - this could mean:
            // 1. Booking was cancelled and bookedBy was cleared
            // 2. Data inconsistency
            // Since status is partially-available but no booking reference, allow the change
            // (The host should be able to manually fix this)
            console.log(`⚠️ Partially-available date ${update.date} has no bookedBy reference - allowing change (likely cancelled booking)`);
            // Allow the change - don't return error
          }
        }
      }
    }

    const bulkOps = updates.map(update => {
      const updateDoc = {
        status: update.status || 'unavailable',
        reason: update.reason || null
      };
      
      // Include availableHours if provided
      if (update.availableHours !== undefined) {
        updateDoc.availableHours = update.availableHours;
      }
      
      // Include unavailableHours if provided
      if (update.unavailableHours !== undefined) {
        updateDoc.unavailableHours = update.unavailableHours;
      }
      
      // Include onHoldHours if provided
      if (update.onHoldHours !== undefined) {
        updateDoc.onHoldHours = update.onHoldHours;
      }
      
      return {
        updateOne: {
          filter: { property: propertyId, date: new Date(update.date) },
          update: { $set: updateDoc },
          upsert: true
        }
      };
    });

    const result = await Availability.bulkWrite(bulkOps);

    res.status(200).json({
      success: true,
      message: 'Bulk availability update completed',
      data: { result }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating availability in bulk',
      error: error.message
    });
  }
};

// @desc    Block specific dates
// @route   POST /api/availability/:propertyId/block-dates
// @access  Private (Host only)
const blockDates = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { dates, reason } = req.body; // Array of dates
   
    // Check if user is the host of this property
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    if (property.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only manage availability for your own properties'
      });
    }

    const bulkOps = dates.map(date => ({
      updateOne: {
        filter: { property: propertyId, date: new Date(date) },
        update: { $set: { status: 'blocked', reason: reason || 'Host blocked' } },
        upsert: true
      }
    }));

    const result = await Availability.bulkWrite(bulkOps);

    res.status(200).json({
      success: true,
      message: 'Dates blocked successfully',
      data: { result }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error blocking dates',
      error: error.message
    });
  }
};

// @desc    Unblock specific dates
// @route   POST /api/availability/:propertyId/unblock-dates
// @access  Private (Host only)
const unblockDates = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { dates } = req.body; // Array of dates

    // Check if user is the host of this property
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    if (property.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only manage availability for your own properties'
      });
    }

    const result = await Availability.updateMany(
      { property: propertyId, date: { $in: dates.map(d => new Date(d)) } },
      { $set: { status: 'available', reason: null } }
    );

    res.status(200).json({
      success: true,
      message: 'Dates unblocked successfully',
      data: { result }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error unblocking dates',
      error: error.message
    });
  }
};

// @desc    Block dates for booking (temporary reservation)
// @route   PUT /api/availability/:propertyId/block-booking
// @access  Private (Any authenticated user)
const blockDatesForBooking = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { dates } = req.body; // Array of dates
    const userId = req.user._id; // Get user ID from authenticated request
    console.log("block date console log" , req.body);


    // Validate property exists
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    // Validate dates array
    if (!dates || !Array.isArray(dates) || dates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid dates array is required'
      });
    }

    // Any authenticated user can block dates for booking
    const bulkOps = dates.map(date => ({
      updateOne: {
        filter: { property: propertyId, date: new Date(date) },
        update: { 
          $set: { 
            status: 'blocked', 
            reason: 'Temporarily reserved for booking',
            blockedBy: userId,
            blockedAt: new Date()
          } 
        },
        upsert: true
      }
    }));

    const result = await Availability.bulkWrite(bulkOps);



    res.status(200).json({
      success: true,
      message: 'Dates blocked for booking',
      data: { 
        blockedDates: dates.length,
        result 
      }
    });
  } catch (error) {
    console.error('❌ Error blocking dates for booking:', error);
    res.status(500).json({
      success: false,
      message: 'Error blocking dates for booking',
      error: error.message
    });
  }
};

// @desc    Confirm booking (change status to booked)
// @route   PUT /api/availability/:propertyId/confirm-booking
// @access  Private (Any authenticated user)
const confirmBooking = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { dates, bookingId } = req.body; // Array of dates and booking ID
    const userId = req.user._id; // Get user ID from authenticated request
    console.log("confirm booking called", req.body);


    // Validate property exists
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    // Validate dates array
    if (!dates || !Array.isArray(dates) || dates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid dates array is required'
      });
    }

    // Note: bookingId is optional - can be used to link availability to a specific booking

    // Check if all dates are currently blocked by this user
    const blockedDates = await Availability.find({
      property: propertyId,
      date: { $in: dates.map(d => new Date(d)) },
      blockedBy: userId,
      status: 'blocked'
    });

    if (blockedDates.length !== dates.length) {
      return res.status(400).json({
        success: false,
        message: 'Some dates are not blocked by you or are not available for confirmation',
        blockedCount: blockedDates.length,
        requestedCount: dates.length
      });
    }

    // Confirm the booking by updating status to booked and linking to the booking
    const result = await Availability.updateMany(
      { 
        property: propertyId, 
        date: { $in: dates.map(d => new Date(d)) },
        blockedBy: userId,
        status: 'blocked'
      },
      { 
        $set: { 
          status: 'booked', 
          reason: 'Confirmed booking',
          bookedBy: bookingId || null,
          bookedAt: new Date()
        },
        $unset: { blockedBy: 1, blockedAt: 1 }
      }
    );



    res.status(200).json({
      success: true,
      message: 'Booking confirmed successfully',
      data: { 
        confirmedDates: dates.length,
        result 
      }
    });
  } catch (error) {
    console.error('❌ Error confirming booking:', error);
    res.status(500).json({
      success: false,
      message: 'Error confirming booking',
      error: error.message
    });
  }
};

// @desc    Manual cleanup of expired blocked availability (for testing/admin)
// @route   POST /api/availability/cleanup
// @access  Private (Admin only)
const manualCleanup = async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can perform manual cleanup'
      });
    }

    const result = await cleanupExpiredBlockedAvailability();
    
    res.status(200).json({
      success: true,
      message: 'Manual cleanup completed',
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error during manual cleanup',
      error: error.message
    });
  }
};

// @desc    Update availability status (utility function for other controllers)
// @access  Private (Internal use)
const updateAvailabilityStatus = async (bookingId, status) => {
  try {
    // Find the booking to get property and dates
    const booking = await require('../models/Booking').findById(bookingId);
    if (!booking) {
      throw new Error('Booking not found');
    }

    // Update availability status for the booking dates
    const result = await Availability.updateMany(
      { 
        property: booking.property,
        date: { $in: booking.dates },
        status: { $in: ['blocked', 'booked'] }
      },
      { 
        $set: { 
          status: status,
          reason: status === 'booked' ? 'Confirmed booking' : 'Available for booking'
        },
        $unset: status === 'available' ? { blockedBy: 1, blockedAt: 1, bookedBy: 1, bookedAt: 1 } : {}
      }
    );

    return result;
  } catch (error) {
    console.error('❌ Error updating availability status:', error);
    throw error;
  }
};

// @desc    Release blocked dates (payment failed or user cancelled)
// @route   PUT /api/availability/:propertyId/release-dates
// @access  Private (Any authenticated user)
const releaseDates = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { dates } = req.body; // Array of dates
    const userId = req.user._id; // Get user ID from authenticated request



    // Validate property exists
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    // Validate dates array
    if (!dates || !Array.isArray(dates) || dates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid dates array is required'
      });
    }

    // Check if all dates are currently blocked by this user
    const blockedDates = await Availability.find({
      property: propertyId,
      date: { $in: dates.map(d => new Date(d)) },
      blockedBy: userId,
      status: 'blocked'
    });

    if (blockedDates.length !== dates.length) {
      return res.status(400).json({
        success: false,
        message: 'Some dates are not blocked by you or are not available for release',
        blockedCount: blockedDates.length,
        requestedCount: dates.length
      });
    }

    // Release the blocked dates
    const result = await Availability.updateMany(
      { 
        property: propertyId, 
        date: { $in: dates.map(d => new Date(d)) },
        blockedBy: userId,
        status: 'blocked'
      },
      { 
        $set: { 
          status: 'available', 
          reason: null
        },
        $unset: { blockedBy: 1, blockedAt: 1 }
      }
    );



    res.status(200).json({
      success: true,
      message: 'Dates released successfully',
      data: { 
        releasedDates: dates.length,
        result 
      }
    });
  } catch (error) {
    console.error('❌ Error releasing dates:', error);
    res.status(500).json({
      success: false,
      message: 'Error releasing dates',
      error: error.message
    });
  }
};

// ========================================
// NEW: HOURLY AVAILABILITY ENDPOINTS
// These functions use the new AvailabilityEvent model for precise hourly tracking
// If this causes issues, comment out these functions and their routes
// ========================================

// @desc    Get hourly availability for a property
// @route   GET /api/availability/:propertyId/hourly
// @access  Public
const getHourlyAvailability = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { startDate, endDate, durationHours } = req.query;

    // Validate property exists
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days default

    // Get timeline with hourly status
    const timeline = await AvailabilityEventService.getAvailabilityTimeline(propertyId, start, end);

    // If checking for a specific duration
    if (durationHours) {
      const availability = await AvailabilityEventService.checkHourlyAvailability(
        propertyId, 
        start, 
        new Date(start.getTime() + parseInt(durationHours) * 60 * 60 * 1000)
      );
      
      return res.status(200).json({
        success: true,
        data: {
          available: availability.available,
          reason: availability.reason,
          timeline: timeline.slice(0, 48) // First 48 hours
        }
      });
    }

    res.status(200).json({
      success: true,
      data: { 
        timeline,
        maintenanceHours: property.availabilitySettings?.hostBufferTime || 2
      }
    });
  } catch (error) {
    console.error('❌ Error getting hourly availability:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching hourly availability',
      error: error.message
    });
  }
};

// @desc    Get all availability events for a property
// @route   GET /api/availability/:propertyId/events
// @access  Public
const getPropertyEvents = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { startDate, endDate } = req.query;

    // Validate property exists
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : new Date(start.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days default

    const events = await AvailabilityEventService.getPropertyEvents(propertyId, start, end);

    res.status(200).json({
      success: true,
      data: { 
        events,
        count: events.length
      }
    });
  } catch (error) {
    console.error('❌ Error getting property events:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching property events',
      error: error.message
    });
  }
};

// @desc    Update maintenance time for property
// @route   PUT /api/availability/:propertyId/maintenance-time
// @access  Private (Host only)
const updateMaintenanceTime = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { maintenanceHours } = req.body;

    // Validate property exists and user is host
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    if (property.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only update maintenance time for your own properties'
      });
    }

    // Validate maintenance hours (1-12 hours)
    const hours = parseInt(maintenanceHours);
    if (isNaN(hours) || hours < 1 || hours > 12) {
      return res.status(400).json({
        success: false,
        message: 'Maintenance hours must be between 1 and 12'
      });
    }

    // Update property
    property.availabilitySettings = property.availabilitySettings || {};
    property.availabilitySettings.hostBufferTime = hours;
    await property.save();

    res.status(200).json({
      success: true,
      message: `Maintenance time updated to ${hours} hours`,
      data: {
        maintenanceHours: hours
      }
    });
  } catch (error) {
    console.error('❌ Error updating maintenance time:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating maintenance time',
      error: error.message
    });
  }
};

// @desc    Get next available slot
// @route   GET /api/availability/:propertyId/next-slot
// @access  Public
const getNextAvailableSlot = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { fromDate, durationHours } = req.query;

    // Validate property exists
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const from = fromDate ? new Date(fromDate) : new Date();
    const duration = parseInt(durationHours) || 24;

    const slot = await AvailabilityEventService.getNextAvailableSlot(propertyId, from, duration);

    res.status(200).json({
      success: true,
      data: slot
    });
  } catch (error) {
    console.error('❌ Error getting next available slot:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching next available slot',
      error: error.message
    });
  }
};

// @desc    Check if specific time slot is available
// @route   GET /api/availability/:propertyId/check-slot
// @access  Public
// Query params: checkIn (ISO date), checkOut (ISO date), extension (optional hours)

const checkTimeSlotAvailability = async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { checkIn, checkOut, extension } = req.query;

    // Validate required params
    if (!checkIn || !checkOut) {
      return res.status(400).json({
        success: false,
        message: 'checkIn and checkOut are required query parameters'
      });
    }

    // Validate property exists
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const checkInDate = new Date(checkIn);
    
    let checkOutDate = new Date(checkOut);

    // If extension hours provided, add them to checkout
    const extensionHours = parseInt(extension) || 0;
    if (extensionHours > 0) {
      checkOutDate = new Date(checkOutDate.getTime() + extensionHours * 60 * 60 * 1000);
    }

    // Get maintenance hours from property settings
    const maintenanceHours = property.availabilitySettings?.hostBufferTime || 2;
    const maintenanceEndDate = new Date(checkOutDate.getTime() + maintenanceHours * 60 * 60 * 1000);

    console.log('🔍 Checking time slot availability:', {
      propertyId,
      checkIn: checkInDate.toISOString(),
      checkOut: checkOutDate.toISOString(),
      extensionHours,
      maintenanceEnd: maintenanceEndDate.toISOString()
    });

    // Check for conflicts using AvailabilityEventService
    const conflicts = await AvailabilityEventService.checkHourlyAvailability(
      propertyId,
      checkInDate,
      checkOutDate
    );

    console.log('🔍 Hourly availability check result:', conflicts);

    // Hard block if maintenance overlaps the requested window
    if (conflicts?.events && Array.isArray(conflicts.events)) {
      const maintenanceStart = conflicts.events.find(e => e.eventType === 'maintenance_start');
      const maintenanceEnd = conflicts.events.find(e => e.eventType === 'maintenance_end');
      if (maintenanceStart && maintenanceEnd) {
        const maintStartTime = new Date(maintenanceStart.time);
        const maintEndTime = new Date(maintenanceEnd.time);
        const overlapsMaintenance =
          checkInDate < maintEndTime && checkOutDate > maintStartTime;
        if (overlapsMaintenance) {
          return res.status(200).json({
            success: true,
            data: {
              available: false,
              checkIn: checkInDate.toISOString(),
              checkOut: checkOutDate.toISOString(),
              extensionHours,
              maintenanceEnd: maintEndTime.toISOString(),
              conflicts: {
                hourlyConflicts: [
                  {
                    type: 'maintenance',
                    start: maintStartTime.toISOString(),
                    end: maintEndTime.toISOString(),
                    message: 'Slot overlaps maintenance window'
                  }
                ]
              },
              message: 'Selected time overlaps maintenance window'
            }
          });
        }
      }
    }

    // Also check daily availability for the date range (use LOCAL date to avoid UTC shift)
    const formatLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const startDateStr = formatLocalDate(checkInDate);
    const endDateStr = formatLocalDate(checkOutDate);
    
    // Generate all dates in the range to check
    const allDatesInRange = [];
    const start = new Date(startDateStr);
    const end = new Date(endDateStr);
    let currentDate = new Date(start);
    while (currentDate <= end) {
      allDatesInRange.push(formatLocalDate(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    const dailyAvailability = await Availability.find({
      property: propertyId,
      date: {
        $gte: new Date(startDateStr),
        $lte: new Date(endDateStr)
      },
      status: { $in: ['booked', 'blocked', 'maintenance', 'unavailable', 'available', 'partially-available','on-hold'] }
    }).populate('bookedBy', 'checkOut checkOutTime');

    // ── DIRECT BOOKING OVERLAP CHECK ─────────────────────────────────────────
    // The Availability table only records the BLOCKED dates (check-in date and
    // intermediate dates). The checkout date often has a pre-existing 'available'
    // record with no bookedBy link. So we MUST query the Booking collection
    // directly to enforce the maintenance-buffer rule on checkout day.
    //
    // KEY: checkOut in Booking is stored as midnight UTC of the local checkout DATE
    //      (e.g., Mar 9 5PM IST stored as 2026-03-09T00:00:00.000Z).
    //      We must query by the calendar date of the new check-in, not exact datetime.
    const Booking = require('../models/Booking');

    // Get the calendar date of the new check-in in UTC
    const checkInDayStart = new Date(Date.UTC(
      checkInDate.getUTCFullYear(), checkInDate.getUTCMonth(), checkInDate.getUTCDate(),
      0, 0, 0, 0
    ));
    const checkInDayEnd = new Date(Date.UTC(
      checkInDate.getUTCFullYear(), checkInDate.getUTCMonth(), checkInDate.getUTCDate(),
      23, 59, 59, 999
    ));

    const overlappingBookings = await Booking.find({
      property: propertyId,
      status: { $in: ['pending', 'paid', 'confirmed'] },
      // Match bookings whose checkout DATE (stored as midnight UTC) falls on the same calendar day
      // as the new check-in date — these are the bookings that could still be occupying the property.
      checkOut: { $gte: checkInDayStart, $lte: checkInDayEnd }
    }).select('checkOut checkOutTime checkIn status');

    for (const existingBooking of overlappingBookings) {
      // checkOut is stored as midnight UTC of the local date.
      // checkOutTime (e.g. "17:00") is in IST (UTC+5:30).
      // To get the correct UTC timestamp: parse the UTC date, add the IST hours, subtract 5:30 offset.
      const coDate = new Date(existingBooking.checkOut); // midnight UTC of checkout calendar day
      const [coH, coM] = (existingBooking.checkOutTime || '17:00').split(':').map(Number);
      const safeCoH = isNaN(coH) ? 15 : coH;
      const safeCoM = isNaN(coM) ? 0 : coM;

      // Compute UTC checkout time: midnight UTC of the day + IST hours - 5:30h offset
      const checkoutUTC = new Date(
        coDate.getTime()
        + safeCoH * 60 * 60 * 1000
        + safeCoM * 60 * 1000
        - (5 * 60 + 30) * 60 * 1000   // subtract IST offset to get UTC
      );
      const maintEndUTC = new Date(checkoutUTC.getTime() + maintenanceHours * 60 * 60 * 1000);

      console.log(`🔍 Booking overlap check (direct Booking query):`, {
        existingBookingId: existingBooking._id,
        checkOutStored: coDate.toISOString(),
        checkOutTime: existingBooking.checkOutTime,
        checkoutUTC: checkoutUTC.toISOString(),
        maintenanceEnd: maintEndUTC.toISOString(),
        newCheckIn: checkInDate.toISOString(),
        blocked: checkInDate < maintEndUTC
      });

      if (checkInDate < maintEndUTC) {
        // Format as IST time for the message (matches MobileBookingBar regex: /after\s+([\d:]+\s*[AP]M)/i)
        const maintEndIST = new Date(maintEndUTC.getTime() + (5 * 60 + 30) * 60 * 1000);
        const h = maintEndIST.getUTCHours();
        const period = h >= 12 ? 'PM' : 'AM';
        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        const maintEndStr = `${h12}:00 ${period}`;

        return res.status(200).json({
          success: true,
          data: {
            available: false,
            checkIn: checkInDate.toISOString(),
            checkOut: checkOutDate.toISOString(),
            extensionHours,
            maintenanceEnd: maintEndUTC.toISOString(),
            conflicts: {
              hourlyConflicts: [],
              dailyConflicts: [{
                date: checkoutUTC,
                reason: `Property not available. Check-in not available until after ${maintEndStr}`
              }]
            },
            // IMPORTANT: message must contain "after X:XX AM/PM" to match MobileBookingBar regex
            message: `Check-in not available. Available after ${maintEndStr} (previous guest + ${maintenanceHours}h buffer)`
          }
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────


    
    // Create a map of dates that have explicit availability records
    const availabilityMap = new Map();
    dailyAvailability.forEach(slot => {
      const slotDateStr = formatLocalDate(new Date(slot.date));
      availabilityMap.set(slotDateStr, slot);
    });
    
    // Check if all dates in range have explicit 'available' status
    // If any date is missing or has blocking status, it's unavailable
    const missingDates = [];
    const datesWithBlockingStatus = [];
    for (const dateStr of allDatesInRange) {
      if (!availabilityMap.has(dateStr)) {
        // Date has no explicit record - default to unavailable
         missingDates.push(dateStr);
        // continue;
      } else {
        const slot = availabilityMap.get(dateStr);
        // Check if the date has a blocking status (not 'available')
        if (!['available', 'partially-available'].includes(slot.status))  {
          datesWithBlockingStatus.push({ dateStr, status: slot.status });
        }
      }
    }
    
    console.log('🔍 Availability check:', {
      dateRange: `${startDateStr} to ${endDateStr}`,
      totalDatesInRange: allDatesInRange.length,
      datesWithRecords: availabilityMap.size,
      missingDates: missingDates.length,
      datesWithBlockingStatus: datesWithBlockingStatus.length,
      missingDatesList: missingDates,
      blockingStatusList: datesWithBlockingStatus
    });

    // NEW: Check hour-based availability restrictions
    for (const slot of dailyAvailability) {
      const slotDateStr = formatLocalDate(new Date(slot.date));
      const checkInDateStr = formatLocalDate(checkInDate);
      
      // Check on-hold status (takes highest precedence)
      if (slotDateStr === checkInDateStr && slot.status === 'on-hold') {
        const checkInHours = checkInDate.getHours();
        const checkInMinutes = checkInDate.getMinutes();
        const checkInTimeStr = `${checkInHours.toString().padStart(2, '0')}:${checkInMinutes.toString().padStart(2, '0')}`;
        const checkInMinutesTotal = checkInHours * 60 + checkInMinutes;
        
        // If no onHoldHours specified, entire day is on hold
        if (!slot.onHoldHours || slot.onHoldHours.length === 0) {
          return res.status(200).json({
            success: true,
            data: {
              available: false,
              checkIn: checkInDate.toISOString(),
              checkOut: checkOutDate.toISOString(),
              extensionHours,
              maintenanceEnd: maintenanceEndDate.toISOString(),
              conflicts: {
                hourlyConflicts: [],
                dailyConflicts: [{
                  date: slot.date,
                  reason: 'This date is on hold'
                }]
              },
              message: 'This date is on hold'
            }
          });
        }
        
        // Check if check-in time falls within on-hold hours
        for (const range of slot.onHoldHours) {
          const [rangeStartH, rangeStartM] = range.startTime.split(':').map(Number);
          const [rangeEndH, rangeEndM] = range.endTime.split(':').map(Number);
          const rangeStartMinutes = rangeStartH * 60 + rangeStartM;
          const rangeEndMinutes = rangeEndH * 60 + rangeEndM;
          
          if (checkInMinutesTotal >= rangeStartMinutes && checkInMinutesTotal < rangeEndMinutes) {
            const onHoldHoursStr = slot.onHoldHours.map(r => `${r.startTime}-${r.endTime}`).join(', ');
            return res.status(200).json({
              success: true,
              data: {
                available: false,
                checkIn: checkInDate.toISOString(),
                checkOut: checkOutDate.toISOString(),
                extensionHours,
                maintenanceEnd: maintenanceEndDate.toISOString(),
                conflicts: {
                  hourlyConflicts: [],
                  dailyConflicts: [{
                    date: slot.date,
                    reason: `Check-in time ${checkInTimeStr} falls within on-hold hours. On-hold hours: ${onHoldHoursStr}`
                  }]
                },
                message: `Check-in time ${checkInTimeStr} falls within on-hold hours. On-hold hours: ${onHoldHoursStr}`
              }
            });
          }
        }
      }
      
      // Only check hour restrictions for the check-in date
      if (slotDateStr === checkInDateStr && ['available', 'partially-available'].includes(slot.status)) {
        const checkInHours = checkInDate.getHours();
        const checkInMinutes = checkInDate.getMinutes();
        const checkInTimeStr = `${checkInHours.toString().padStart(2, '0')}:${checkInMinutes.toString().padStart(2, '0')}`;
        const checkInMinutesTotal = checkInHours * 60 + checkInMinutes;
        
        // Check if check-in time falls within unavailable hours (takes precedence)
        if (slot.unavailableHours && slot.unavailableHours.length > 0) {
          for (const range of slot.unavailableHours) {
            const [rangeStartH, rangeStartM] = range.startTime.split(':').map(Number);
            const [rangeEndH, rangeEndM] = range.endTime.split(':').map(Number);
            const rangeStartMinutes = rangeStartH * 60 + rangeStartM;
            const rangeEndMinutes = rangeEndH * 60 + rangeEndM;
            
            if (checkInMinutesTotal >= rangeStartMinutes && checkInMinutesTotal < rangeEndMinutes) {
              const unavailableHoursStr = slot.unavailableHours.map(r => `${r.startTime}-${r.endTime}`).join(', ');
              return res.status(200).json({
                success: true,
                data: {
                  available: false,
                  checkIn: checkInDate.toISOString(),
                  checkOut: checkOutDate.toISOString(),
                  extensionHours,
                  maintenanceEnd: maintenanceEndDate.toISOString(),
                  conflicts: {
                    hourlyConflicts: [],
                    dailyConflicts: [{
                      date: slot.date,
                      reason: `Check-in time ${checkInTimeStr} falls within unavailable hours. Unavailable hours: ${unavailableHoursStr}`
                    }]
                  },
                  message: `Check-in time ${checkInTimeStr} falls within unavailable hours. Unavailable hours: ${unavailableHoursStr}`
                }
              });
            }
          }
        }
        
        // Check if check-in time is within available hours (if availableHours is set)
        if (slot.availableHours && slot.availableHours.length > 0) {
          let isWithinAllowedHours = false;
          for (const range of slot.availableHours) {
            const [rangeStartH, rangeStartM] = range.startTime.split(':').map(Number);
            const [rangeEndH, rangeEndM] = range.endTime.split(':').map(Number);
            const rangeStartMinutes = rangeStartH * 60 + rangeStartM;
            const rangeEndMinutes = rangeEndH * 60 + rangeEndM;
            
            if (checkInMinutesTotal >= rangeStartMinutes && checkInMinutesTotal < rangeEndMinutes) {
              isWithinAllowedHours = true;
              break;
            }
          }
          
          if (!isWithinAllowedHours) {
            const availableHoursStr = slot.availableHours.map(r => `${r.startTime}-${r.endTime}`).join(', ');
            return res.status(200).json({
              success: true,
              data: {
                available: false,
                checkIn: checkInDate.toISOString(),
                checkOut: checkOutDate.toISOString(),
                extensionHours,
                maintenanceEnd: maintenanceEndDate.toISOString(),
                conflicts: {
                  hourlyConflicts: [],
                  dailyConflicts: [{
                    date: slot.date,
                    reason: `Check-in time ${checkInTimeStr} is outside available hours. Available hours: ${availableHoursStr}`
                  }]
                },
                message: `Check-in time ${checkInTimeStr} is outside available hours. Available hours: ${availableHoursStr}`
              }
            });
          }
        }
      }
    }

    // Filter out checkout dates where check-in is AFTER maintenance end.
    // There are two kinds of checkout-day slots:
    //   a) DB slots with slot.bookedBy.checkOut populated  (old path)
    //   b) Synthetic 'partially-available' slots added from checkoutDatesMap (no bookedBy)
    //      → these carry slot.maintenance.availableAfter which is checkoutTime + bufferHours
    const now = new Date();
    const filteredDailyAvailability = dailyAvailability.filter(slot => {
      // ── Path (a): DB slot with bookedBy populated ──────────────────────────
      if (slot.bookedBy && slot.bookedBy.checkOut) {
        const checkoutDate = new Date(slot.bookedBy.checkOut);
        const checkoutDateStr = checkoutDate.toISOString().split('T')[0];
        const slotDateStr = new Date(slot.date).toISOString().split('T')[0];
        
        // If this slot is the checkout date
        if (slotDateStr === checkoutDateStr) {
          // Calculate maintenance end time using LOCAL time (not UTC)
          const checkoutTime = new Date(checkoutDate);
          checkoutTime.setHours(0, 0, 0, 0); // Reset to start of day
          
          if (slot.bookedBy.checkOutTime) {
            const [hours, minutes] = slot.bookedBy.checkOutTime.split(':').map(Number);
            checkoutTime.setHours(hours, minutes, 0, 0); // Use local time
          } else {
            checkoutTime.setHours(15, 0, 0, 0); // Default 3 PM
          }
          
          const maintenanceEndTime = new Date(checkoutTime.getTime() + maintenanceHours * 60 * 60 * 1000);
          
          console.log(`🔍 Checking checkout date conflict (bookedBy):`, {
            slotDate: slotDateStr,
            checkoutTime: checkoutTime.toISOString(),
            maintenanceEnd: maintenanceEndTime.toISOString(),
            checkInTime: checkInDate.toISOString(),
            checkInAfterMaintenance: checkInDate >= maintenanceEndTime
          });

          console.log("checkindate and end maintaince time", checkInDate, maintenanceEndTime);
          
          // If check-in is after maintenance end, this slot is available (ignore the conflict)
          if (checkInDate >= maintenanceEndTime) {
            console.log(`✅ Ignoring checkout date conflict: check-in ${checkInDate.toISOString()} is after maintenance end ${maintenanceEndTime.toISOString()}`);
            return false; // Don't count as conflict
          } else {
            console.log(`❌ Checkout date conflict: check-in ${checkInDate.toISOString()} is before maintenance end ${maintenanceEndTime.toISOString()}`);
          }
        }
      }

      // ── Path (b): Synthetic partially-available slot (no bookedBy) ─────────
      // These slots are built from checkoutDatesMap and carry a .maintenance object
      // with availableAfter = checkoutTime + bufferHours.
      // If check-in is BEFORE availableAfter the slot is still blocked.
      if (slot.status === 'partially-available' && slot.maintenance?.availableAfter) {
        const availableAfter = new Date(slot.maintenance.availableAfter);
        const slotDateStr = new Date(slot.date).toISOString().split('T')[0];
        const checkInDateStr = formatLocalDate(checkInDate);

        if (slotDateStr === checkInDateStr) {
          if (checkInDate >= availableAfter) {
            console.log(`✅ Partially-available date ${slotDateStr}: check-in ${checkInDate.toISOString()} is after availableAfter ${availableAfter.toISOString()} — OK`);
            return false; // Don't count as conflict — new guest checks in after current guest + buffer
          } else {
            console.log(`❌ Partially-available date ${slotDateStr}: check-in ${checkInDate.toISOString()} is BEFORE availableAfter ${availableAfter.toISOString()} — BLOCKED`);
            // Keep as conflict — falls through to return true below
          }
        }
      }

      return true; // Count as conflict
    });

    console.log("filtered daily availability:", filteredDailyAvailability);

    // Only count dates with blocking statuses as conflicts (exclude 'available' status)
    // const blockingDates = filteredDailyAvailability.filter(slot => 
    //   ['booked', 'blocked', 'maintenance', 'unavailable', 'on-hold','partially-available'].includes(slot.status)
    // );

    const blockingDates = filteredDailyAvailability.filter(slot => {
        // Fully blocking statuses
        if (['booked', 'blocked', 'maintenance', 'unavailable', 'on-hold'].includes(slot.status)) {
          return true;
        }
        
        // A partially-available slot that survived filteredDailyAvailability means
        // check-in is BEFORE availableAfter — treat it as blocking.
        // (If check-in was after availableAfter, the slot was already removed above.)
        // if (slot.status === 'partially-available') {
        //   return true;
        // }

        if (slot.status === 'partially-available') {
            const slotDateStr = new Date(slot.date).toISOString().split('T')[0];
            const checkInDateStr = formatLocalDate(checkInDate);

            if (slotDateStr === checkInDateStr) {
              const match = slot.reason?.match(/after\s+(\d{1,2}):?(\d{0,2})\s*(AM|PM)/i);

      if (match) {
        let [_, h, m, period] = match;
        h = parseInt(h);
        m = m ? parseInt(m) : 0;

        if (period.toUpperCase() === 'PM' && h !== 12) h += 12;
        if (period.toUpperCase() === 'AM' && h === 12) h = 0;

        const availableAfterMinutes = h * 60 + m;
        const checkInMinutes = checkInDate.getHours() * 60 + checkInDate.getMinutes();

        if (checkInMinutes >= availableAfterMinutes) {
          return false; // ✅ allow booking
        }
      }
              }

          return true; // ❌ block only if before allowed time
                }
        
        return false;
      });
          
    console.log("blocking dates", blockingDates);
    // If any dates in the range don't have explicit availability records, they're unavailable
    // Add missing dates as conflicts (but only for non-hourly properties).
    const isHourlyProperty = property?.hourlyBooking?.enabled;
    if (missingDates.length > 0) {
      if (!isHourlyProperty) {
        missingDates.forEach(dateStr => {
          blockingDates.push({
            date: new Date(dateStr),
            status: 'unavailable',
            reason: 'Date not explicitly set as available by host'
          });
        });
        console.log(`❌ Missing availability records for dates: ${missingDates.join(', ')} - treating as unavailable (non-hourly property)`);
      } else {
        console.log(`INFO Missing availability records for dates: ${missingDates.join(', ')} but property is hourly-enabled; relying on event-based availability`);
      }
    }
    
    console.log('🔍 Final conflict check:', {
      hourlyConflicts: conflicts?.length || 0,
      blockingDatesCount: blockingDates.length,
      blockingDates: blockingDates.map(b => ({
        date: formatLocalDate(new Date(b.date)),
        status: b.status,
        reason: b.reason
      })),
      missingDatesCount: missingDates.length
    });
    
    // const hasConflicts = (conflicts && conflicts.length > 0) || blockingDates.length > 0;
    

    const hasHourlyConflict = conflicts && conflicts.available === false;

const hasConflicts =
  hasHourlyConflict || blockingDates.length > 0;
    console.log('✅ Final availability result:', {
      hasConflicts,
      available: !hasConflicts,
      reason: hasConflicts ? 'Conflicts found' : 'No conflicts - all dates available'
    });

    // Get next available slot if there are conflicts
    let nextAvailableSlot = null;
    if (hasConflicts) {
      const duration = Math.ceil((checkOutDate - checkInDate) / (1000 * 60 * 60)); // hours
      nextAvailableSlot = await AvailabilityEventService.getNextAvailableSlot(
        propertyId,
        checkInDate,
        duration
      );
    }

        const data = {
        available: !hasConflicts,
        checkIn: checkInDate.toISOString(),
        checkOut: checkOutDate.toISOString(),
        extensionHours,
        maintenanceEnd: maintenanceEndDate.toISOString()
      };

      console.log("ghfjflj fknfrrhvwbjekfef", data);

    res.status(200).json({
      success: true,
      data: {
        available: !hasConflicts,
        checkIn: checkInDate.toISOString(),
        checkOut: checkOutDate.toISOString(),
        extensionHours,
        maintenanceEnd: maintenanceEndDate.toISOString(),
        conflicts: hasConflicts ? {
          // hourlyConflicts: conflicts || [],
          hourlyConflicts: conflicts && conflicts.available === false ? [conflicts] : [],
          dailyConflicts: blockingDates.map(a => ({
            date: a.date,
            status: a.status,
            reason: a.reason || `${a.status} - not available for booking`
          }))
        } : null,
        nextAvailableSlot
      }
    });
  } catch (error) {
    console.error('❌ Error checking time slot availability:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking time slot availability',
      error: error.message
    });
  }
};

// ========================================
// END NEW: HOURLY AVAILABILITY ENDPOINTS
// ========================================



module.exports = {
  // OLD: Existing exports (keep these)
  getPropertyAvailability,
  getAvailabilityRange,
  createAvailability,
  updateAvailability,
  deleteAvailability,
  bulkUpdateAvailability,
  blockDates,
  unblockDates,
  blockDatesForBooking,
  confirmBooking,
  releaseDates,
  cleanupExpiredBlockedAvailability,
  manualCleanup,
  updateAvailabilityStatus,
  
  // NEW: Hourly availability exports (comment out if issues)
  getHourlyAvailability,
  getPropertyEvents,
  updateMaintenanceTime,
  getNextAvailableSlot,
  checkTimeSlotAvailability,

  
};
