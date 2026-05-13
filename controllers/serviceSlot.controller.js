/**
 * Service Slot Controller
 * Handles slot-based booking for services (availability, reservation, release)
 */
const ServiceSlot = require('../models/ServiceSlot');
const Service = require('../models/Service');

/**
 * GET /api/services/:serviceId/slots?date=YYYY-MM-DD
 * Get available slots for a service on a specific date.
 * Auto-generates slots from service.slotBooking.defaultSlots if none exist.
 */
const getAvailableSlots = async (req, res) => {
  try {
    const { serviceId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ success: false, message: 'Date query parameter is required (YYYY-MM-DD)' });
    }

    const service = await Service.findById(serviceId).lean();
    if (!service) {
      return res.status(404).json({ success: false, message: 'Service not found' });
    }

    if (!service.slotBooking?.enabled) {
      return res.json({
        success: true,
        slotBookingEnabled: false,
        message: 'This service does not use slot-based booking',
        slots: []
      });
    }

    const dateObj = new Date(date);
    dateObj.setHours(0, 0, 0, 0);

    // Clean up expired reservations first
    await ServiceSlot.cleanupExpiredReservations();

    // Find existing slots
    const dateEnd = new Date(dateObj);
    dateEnd.setHours(23, 59, 59, 999);

    let slots = await ServiceSlot.find({
      service: serviceId,
      date: { $gte: dateObj, $lte: dateEnd }
    }).sort({ startTime: 1 }).lean();

    // Auto-generate slots from defaults if none exist
    if (slots.length === 0 && service.slotBooking.autoGenerateSlots && service.slotBooking.defaultSlots?.length > 0) {
      const newSlots = service.slotBooking.defaultSlots.map(ds => ({
        service: serviceId,
        date: dateObj,
        startTime: ds.startTime,
        endTime: ds.endTime,
        capacity: ds.capacity || 1,
        bookedCount: 0,
        status: 'available',
        metadata: { createdBy: service.provider }
      }));

      const created = await ServiceSlot.insertMany(newSlots);
      slots = created.map(s => s.toObject());
    }

    // Format response
    const formattedSlots = slots.map(slot => ({
      _id: slot._id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      capacity: slot.capacity,
      bookedCount: slot.bookedCount,
      availableCapacity: Math.max(0, slot.capacity - slot.bookedCount),
      status: slot.status,
      priceOverride: slot.priceOverride,
      isAvailable: slot.status === 'available' && slot.bookedCount < slot.capacity
    }));

    return res.json({
      success: true,
      slotBookingEnabled: true,
      date: date,
      serviceId,
      slots: formattedSlots
    });
  } catch (error) {
    console.error('Error fetching service slots:', error);
    return res.status(500).json({ success: false, message: 'Error fetching slots', error: error.message });
  }
};

/**
 * POST /api/services/:serviceId/slots/check
 * Check if specific slots are available for booking
 * Body: { slots: [{ slotId, quantity }] }
 */
const checkSlotAvailability = async (req, res) => {
  try {
    const { serviceId } = req.params;
    const { slots } = req.body;

    if (!slots || !Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ success: false, message: 'Slots array is required' });
    }

    await ServiceSlot.cleanupExpiredReservations();

    const results = [];
    let allAvailable = true;

    for (const requested of slots) {
      const slot = await ServiceSlot.findOne({
        _id: requested.slotId,
        service: serviceId
      });

      if (!slot) {
        results.push({ slotId: requested.slotId, available: false, reason: 'Slot not found' });
        allAvailable = false;
        continue;
      }

      const canBook = slot.canBook(requested.quantity || 1);
      results.push({
        slotId: requested.slotId,
        startTime: slot.startTime,
        endTime: slot.endTime,
        available: canBook,
        availableCapacity: Math.max(0, slot.capacity - slot.bookedCount),
        requestedQuantity: requested.quantity || 1,
        reason: canBook ? 'Available' : 'Insufficient capacity'
      });

      if (!canBook) allAvailable = false;
    }

    return res.json({
      success: true,
      allAvailable,
      slots: results
    });
  } catch (error) {
    console.error('Error checking slot availability:', error);
    return res.status(500).json({ success: false, message: 'Error checking availability', error: error.message });
  }
};

/**
 * POST /api/services/:serviceId/slots/manage
 * Provider-only: Create or update slots for their service
 * Body: { date, slots: [{ startTime, endTime, capacity, label }] }
 */
const manageSlots = async (req, res) => {
  try {
    const { serviceId } = req.params;
    const { date, slots } = req.body;

    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({ success: false, message: 'Service not found' });
    }

    if (service.provider.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only the service provider can manage slots' });
    }

    if (!date || !slots || !Array.isArray(slots)) {
      return res.status(400).json({ success: false, message: 'Date and slots array required' });
    }

    const dateObj = new Date(date);
    dateObj.setHours(0, 0, 0, 0);

    const results = [];
    for (const slotData of slots) {
      const existing = await ServiceSlot.findOne({
        service: serviceId,
        date: dateObj,
        startTime: slotData.startTime
      });

      if (existing) {
        existing.endTime = slotData.endTime || existing.endTime;
        existing.capacity = slotData.capacity || existing.capacity;
        existing.priceOverride = slotData.priceOverride ?? existing.priceOverride;
        if (slotData.status) existing.status = slotData.status;
        await existing.save();
        results.push({ action: 'updated', slot: existing });
      } else {
        const newSlot = await ServiceSlot.create({
          service: serviceId,
          date: dateObj,
          startTime: slotData.startTime,
          endTime: slotData.endTime,
          capacity: slotData.capacity || 1,
          status: 'available',
          priceOverride: slotData.priceOverride || null,
          metadata: { createdBy: req.user._id }
        });
        results.push({ action: 'created', slot: newSlot });
      }
    }

    // Enable slot booking on the service if not already
    if (!service.slotBooking?.enabled) {
      service.slotBooking = service.slotBooking || {};
      service.slotBooking.enabled = true;
      await service.save();
    }

    return res.json({
      success: true,
      message: `Managed ${results.length} slots`,
      results
    });
  } catch (error) {
    console.error('Error managing slots:', error);
    return res.status(500).json({ success: false, message: 'Error managing slots', error: error.message });
  }
};

module.exports = {
  getAvailableSlots,
  checkSlotAvailability,
  manageSlots
};
