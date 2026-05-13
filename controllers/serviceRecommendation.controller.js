const Service = require('../models/Service');
const Property = require('../models/Property');
const Booking = require('../models/Booking');
const mongoose = require('mongoose');

// ════════════════════════════════════════════════════════════════════════════════
// SERVICE RECOMMENDATION ENGINE
// Intelligently recommends area services during the booking flow
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Smart recommendation rules based on booking context
 * Each rule maps a condition to a set of preferred service types
 */
const RECOMMENDATION_RULES = [
  {
    name: 'long-stay',
    condition: (ctx) => ctx.nights >= 4,
    preferredTypes: ['cleaning', 'chef', 'fitness', 'yoga-teacher'],
    boost: 1.3,
    reason: 'Great for longer stays'
  },
  {
    name: 'family-booking',
    condition: (ctx) => ctx.totalGuests >= 4 || ctx.children > 0,
    preferredTypes: ['transport', 'transportation', 'chef', 'tour-guide'],
    boost: 1.25,
    reason: 'Perfect for families'
  },
  {
    name: 'couple-stay',
    condition: (ctx) => ctx.totalGuests === 2 && ctx.children === 0,
    preferredTypes: ['photographer', 'chef', 'yoga-teacher', 'music'],
    boost: 1.2,
    reason: 'Ideal for couples'
  },
  {
    name: 'solo-traveller',
    condition: (ctx) => ctx.totalGuests === 1,
    preferredTypes: ['tour-guide', 'fitness', 'yoga-teacher', 'art'],
    boost: 1.15,
    reason: 'Great for solo travellers'
  },
  {
    name: 'short-stay',
    condition: (ctx) => ctx.nights <= 2,
    preferredTypes: ['transport', 'transportation', 'tour-guide', 'photographer'],
    boost: 1.1,
    reason: 'Make the most of your short trip'
  },
  {
    name: 'weekend-getaway',
    condition: (ctx) => {
      if (!ctx.checkInDate) return false;
      const day = new Date(ctx.checkInDate).getDay();
      return (day === 5 || day === 6) && ctx.nights <= 3;
    },
    preferredTypes: ['chef', 'photographer', 'music', 'art'],
    boost: 1.15,
    reason: 'Weekend special'
  }
];

/**
 * Map property services (from property.services array) to service types
 * This allows matching property-listed services to actual Service documents
 */
const PROPERTY_SERVICE_TO_TYPE_MAP = {
  'car-rental': ['transport', 'transportation'],
  'airport-pickup': ['transport', 'transportation'],
  'guided-tours': ['tour-guide'],
  'cooking-classes': ['chef'],
  'yoga-classes': ['yoga-teacher', 'fitness'],
  'massage': ['fitness', 'yoga-teacher'],
  'cleaning': ['cleaning'],
  'laundry': ['cleaning'],
  'concierge': ['tour-guide', 'transport'],
  'breakfast': ['chef'],
  'dinner': ['chef']
};

// @desc    Get recommended services for a property booking
// @route   GET /api/services/recommended
// @access  Public
const getRecommendedServices = async (req, res) => {
  try {
    const {
      propertyId,
      checkIn,
      checkOut,
      adults = 1,
      children = 0,
      infants = 0,
      limit = 12
    } = req.query;

    if (!propertyId) {
      return res.status(400).json({
        success: false,
        message: 'propertyId is required'
      });
    }

    // 1. Fetch the property
    const property = await Property.findById(propertyId).lean();
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    // 2. Build booking context for recommendation rules
    const checkInDate = checkIn ? new Date(checkIn) : new Date();
    const checkOutDate = checkOut ? new Date(checkOut) : new Date(Date.now() + 86400000);
    const nights = Math.max(1, Math.ceil((checkOutDate - checkInDate) / 86400000));
    const totalGuests = parseInt(adults) + parseInt(children);

    const ctx = {
      propertyType: property.type,
      propertyCity: property.location?.city,
      propertyServices: property.services || [],
      nights,
      totalGuests,
      adults: parseInt(adults),
      children: parseInt(children),
      infants: parseInt(infants),
      checkInDate,
      checkOutDate
    };

    // 3. Build the geo query - find services within 50km of property
    const coordinates = property.location?.coordinates;
    if (!coordinates || coordinates.length !== 2) {
      return res.status(400).json({
        success: false,
        message: 'Property location data is incomplete'
      });
    }

    // 4. Determine which service types to prioritize based on rules
    const activeRules = RECOMMENDATION_RULES.filter(rule => rule.condition(ctx));
    const typeBoostMap = {};
    const typeReasonMap = {};

    activeRules.forEach(rule => {
      rule.preferredTypes.forEach(type => {
        typeBoostMap[type] = Math.max(typeBoostMap[type] || 1, rule.boost);
        if (!typeReasonMap[type]) typeReasonMap[type] = [];
        typeReasonMap[type].push(rule.reason);
      });
    });

    // Also boost types that match property's own listed services
    (property.services || []).forEach(propService => {
      const mappedTypes = PROPERTY_SERVICE_TO_TYPE_MAP[propService] || [];
      mappedTypes.forEach(type => {
        typeBoostMap[type] = Math.max(typeBoostMap[type] || 1, 1.2);
        if (!typeReasonMap[type]) typeReasonMap[type] = [];
        typeReasonMap[type].push('Offered by property');
      });
    });

    // 5. Query nearby services
    const geoQuery = {
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: coordinates // [lng, lat]
          },
          $maxDistance: 50000 // 50km radius
        }
      },
      status: 'published',
      isPublished: true,
      approvalStatus: 'approved'
    };

    // Also filter by available slots overlapping with booking dates
    // Only if we have valid date range
    let dateFilter = {};
    if (checkIn && checkOut) {
      dateFilter = {
        $or: [
          // Services with no slots (always available, e.g. on-demand)
          { availableSlots: { $size: 0 } },
          { availableSlots: { $exists: false } },
          // Services with at least one available slot in the date range
          {
            availableSlots: {
              $elemMatch: {
                isAvailable: true,
                status: 'available',
                startTime: { $lte: checkOutDate },
                endTime: { $gte: checkInDate }
              }
            }
          }
        ]
      };
    }

    const services = await Service.find({
      ...geoQuery,
      ...dateFilter
    })
      .populate('provider', 'name profilePicture')
      .limit(parseInt(limit) * 2) // Fetch more to allow scoring/filtering
      .lean();

    // 6. Score and rank services
    const scoredServices = services.map(service => {
      let score = 0;

      // Base score from rating
      score += (service.rating?.average || 0) * 2;

      // Review count bonus (popularity)
      score += Math.min(service.reviewCount || 0, 50) * 0.1;

      // Type boost from recommendation rules
      const typeBoost = typeBoostMap[service.serviceType] || 1;
      score *= typeBoost;

      // Distance penalty (closer = better) - handled by $near sorting
      // Just add a small bonus for being in the same city
      if (service.location?.city && property.location?.city &&
          service.location.city.toLowerCase() === property.location.city.toLowerCase()) {
        score += 3;
      }

      // Guest capacity match
      if (service.groupSize?.max >= totalGuests) {
        score += 1;
      }

      // Pricing reasonability bonus (services under ₹2000/person get a small boost)
      if (service.pricing?.basePrice && service.pricing.basePrice / Math.max(1, totalGuests) < 2000) {
        score += 0.5;
      }

      // Get recommendation reason
      const reasons = typeReasonMap[service.serviceType] || [];
      const primaryReason = reasons[0] || 'Available in your area';

      return {
        ...service,
        _recommendationScore: Math.round(score * 100) / 100,
        _recommendationReason: primaryReason,
        _matchedRules: activeRules
          .filter(r => r.preferredTypes.includes(service.serviceType))
          .map(r => r.name)
      };
    });

    // Sort by score descending
    scoredServices.sort((a, b) => b._recommendationScore - a._recommendationScore);

    // Deduplicate by provider+type (keep highest scored)
    const seen = new Set();
    const deduplicated = scoredServices.filter(s => {
      const key = `${s.provider?._id || s.provider}-${s.serviceType}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Take top N
    const finalServices = deduplicated.slice(0, parseInt(limit));

    // 7. Calculate pricing for each service based on booking context
    const servicesWithPricing = finalServices.map(service => {
      const pricing = calculateServicePricing(service, ctx);
      return {
        _id: service._id,
        title: service.title,
        description: service.description,
        serviceType: service.serviceType,
        provider: service.provider,
        media: service.media?.slice(0, 3), // First 3 images only
        rating: service.rating,
        reviewCount: service.reviewCount,
        pricing: {
          basePrice: service.pricing?.basePrice || 0,
          perPersonPrice: service.pricing?.perPersonPrice || 0,
          currency: service.pricing?.currency || 'INR',
          includedGuests: service.pricing?.includedGuests || 1,
          // Calculated pricing for this booking
          calculatedTotal: pricing.total,
          pricingType: pricing.type,
          pricingLabel: pricing.label,
          perDayPrice: pricing.perDay || null,
          perGuestPrice: pricing.perGuest || null
        },
        duration: service.duration,
        groupSize: service.groupSize,
        cancellationPolicy: service.cancellationPolicy,
        location: {
          city: service.location?.city,
          address: service.location?.address
        },
        _recommendationScore: service._recommendationScore,
        _recommendationReason: service._recommendationReason,
        _matchedRules: service._matchedRules
      };
    });

    res.json({
      success: true,
      data: {
        services: servicesWithPricing,
        context: {
          propertyId,
          propertyCity: property.location?.city,
          nights,
          guests: { adults: parseInt(adults), children: parseInt(children), infants: parseInt(infants) },
          activeRules: activeRules.map(r => r.name),
          totalFound: services.length,
          totalReturned: servicesWithPricing.length
        }
      }
    });

  } catch (error) {
    console.error('Error getting recommended services:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching recommended services',
      error: error.message
    });
  }
};

/**
 * Calculate service pricing based on booking context
 * Supports: fixed, per-day, per-guest, per-guest-per-day
 */
function calculateServicePricing(service, ctx) {
  const basePrice = service.pricing?.basePrice || 0;
  const perPersonPrice = service.pricing?.perPersonPrice || 0;
  const includedGuests = service.pricing?.includedGuests || 1;
  const durationUnit = service.duration?.unit || 'hours';

  // If service is per-day (duration unit = days)
  if (durationUnit === 'days') {
    const perDayTotal = basePrice * ctx.nights;
    const extraGuests = Math.max(0, ctx.totalGuests - includedGuests);
    const guestSurcharge = extraGuests * perPersonPrice * ctx.nights;
    return {
      total: perDayTotal + guestSurcharge,
      type: 'per-day',
      label: `₹${basePrice}/day × ${ctx.nights} day${ctx.nights > 1 ? 's' : ''}`,
      perDay: basePrice
    };
  }

  // If service has per-person pricing
  if (perPersonPrice > 0) {
    const extraGuests = Math.max(0, ctx.totalGuests - includedGuests);
    const guestSurcharge = extraGuests * perPersonPrice;
    return {
      total: basePrice + guestSurcharge,
      type: 'per-guest',
      label: `₹${basePrice} + ₹${perPersonPrice}/extra guest`,
      perGuest: perPersonPrice
    };
  }

  // Fixed pricing
  return {
    total: basePrice,
    type: 'fixed',
    label: `₹${basePrice} flat`
  };
}

// @desc    Calculate total with selected services
// @route   POST /api/services/calculate-addon-total
// @access  Public
const calculateAddonTotal = async (req, res) => {
  try {
    const {
      selectedServices, // Array of { serviceId, quantity? }
      checkIn,
      checkOut,
      adults = 1,
      children = 0
    } = req.body;

    if (!selectedServices || !Array.isArray(selectedServices) || selectedServices.length === 0) {
      return res.json({
        success: true,
        data: {
          services: [],
          totalServiceCharges: 0,
          breakdown: []
        }
      });
    }

    const checkInDate = checkIn ? new Date(checkIn) : new Date();
    const checkOutDate = checkOut ? new Date(checkOut) : new Date(Date.now() + 86400000);
    const nights = Math.max(1, Math.ceil((checkOutDate - checkInDate) / 86400000));
    const totalGuests = parseInt(adults) + parseInt(children);

    const ctx = { nights, totalGuests, adults: parseInt(adults), children: parseInt(children) };

    // Fetch all selected services
    const serviceIds = selectedServices.map(s => s.serviceId);
    const services = await Service.find({
      _id: { $in: serviceIds },
      status: 'published',
      isPublished: true
    }).lean();

    // Validate all services exist
    if (services.length !== serviceIds.length) {
      const foundIds = new Set(services.map(s => s._id.toString()));
      const missingIds = serviceIds.filter(id => !foundIds.has(id));
      return res.status(400).json({
        success: false,
        message: `Some services are no longer available: ${missingIds.join(', ')}`
      });
    }

    // Calculate pricing for each
    let totalServiceCharges = 0;
    const breakdown = services.map(service => {
      const selectedItem = selectedServices.find(s => s.serviceId === service._id.toString());
      const quantity = selectedItem?.quantity || 1;
      const pricing = calculateServicePricing(service, ctx);
      const lineTotal = pricing.total * quantity;
      totalServiceCharges += lineTotal;

      return {
        serviceId: service._id,
        title: service.title,
        serviceType: service.serviceType,
        quantity,
        unitPrice: pricing.total,
        lineTotal,
        pricingType: pricing.type,
        pricingLabel: pricing.label
      };
    });

    res.json({
      success: true,
      data: {
        services: breakdown,
        totalServiceCharges,
        breakdown
      }
    });

  } catch (error) {
    console.error('Error calculating addon total:', error);
    res.status(500).json({
      success: false,
      message: 'Error calculating service total',
      error: error.message
    });
  }
};

// @desc    Validate selected services are still available
// @route   POST /api/services/validate-addons
// @access  Public
const validateAddons = async (req, res) => {
  try {
    const { selectedServices, checkIn, checkOut } = req.body;

    if (!selectedServices || selectedServices.length === 0) {
      return res.json({ success: true, data: { valid: true, services: [] } });
    }

    const checkInDate = checkIn ? new Date(checkIn) : null;
    const checkOutDate = checkOut ? new Date(checkOut) : null;

    const serviceIds = selectedServices.map(s => s.serviceId);
    const services = await Service.find({
      _id: { $in: serviceIds },
      status: 'published',
      isPublished: true,
      approvalStatus: 'approved'
    }).lean();

    const results = selectedServices.map(selected => {
      const service = services.find(s => s._id.toString() === selected.serviceId);
      if (!service) {
        return {
          serviceId: selected.serviceId,
          valid: false,
          reason: 'Service no longer available'
        };
      }

      // Check date availability if dates provided
      if (checkInDate && checkOutDate && service.availableSlots?.length > 0) {
        const hasAvailableSlot = service.availableSlots.some(slot =>
          slot.isAvailable &&
          slot.status === 'available' &&
          new Date(slot.startTime) <= checkOutDate &&
          new Date(slot.endTime) >= checkInDate
        );
        if (!hasAvailableSlot) {
          return {
            serviceId: selected.serviceId,
            title: service.title,
            valid: false,
            reason: 'Service not available for selected dates'
          };
        }
      }

      return {
        serviceId: selected.serviceId,
        title: service.title,
        valid: true
      };
    });

    const allValid = results.every(r => r.valid);

    res.json({
      success: true,
      data: {
        valid: allValid,
        services: results
      }
    });

  } catch (error) {
    console.error('Error validating addons:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating services',
      error: error.message
    });
  }
};

module.exports = {
  getRecommendedServices,
  calculateAddonTotal,
  validateAddons
};
