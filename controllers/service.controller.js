const Service = require('../models/Service');
const User = require('../models/User');
const Booking = require('../models/Booking');
const Review = require('../models/Review');
const slugify = require('slugify');

// @desc    Create new service
// @route   POST /api/services
// @access  Private (Service providers only)
const createService = async (req, res) => {
  try {
    const {
      title,
      description,
      serviceType,
      duration,
      location,
      groupSize,
      pricing,
      cancellationPolicy,
      requirements,
      media
    } = req.body;

    // Check if user is a service provider or admin
    if (req.user.role !== 'host' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only service providers can create services'
      });
    }

    // Ensure title is present
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Title is required to create a service.'
      });
    }

    // Generate slug
    const slug = slugify(title, { lower: true });

    let parsedLocation = location;
    // Format location properly for MongoDB GeoJSON
    if (parsedLocation) {
      if (typeof parsedLocation === 'string') {
        try { parsedLocation = JSON.parse(parsedLocation); } catch (e) {}
      }
      
      if (parsedLocation.coordinates) {
        if (typeof parsedLocation.coordinates === 'string') {
          try { parsedLocation.coordinates = JSON.parse(parsedLocation.coordinates); } catch (e) {}
        }
        
        // Convert [{lat, lng}] or {lat, lng} to [lng, lat] array of numbers
        if (Array.isArray(parsedLocation.coordinates) && parsedLocation.coordinates.length > 0) {
          if (typeof parsedLocation.coordinates[0] === 'object' && parsedLocation.coordinates[0] !== null) {
            const point = parsedLocation.coordinates[0];
            parsedLocation.coordinates = [
              Number(point.lng || point.longitude || 0),
              Number(point.lat || point.latitude || 0)
            ];
          } else {
            // Already numbers but maybe strings '72.1', '23.1'
            parsedLocation.coordinates = parsedLocation.coordinates.map(Number);
          }
        } else if (typeof parsedLocation.coordinates === 'object' && parsedLocation.coordinates !== null) {
            const point = parsedLocation.coordinates;
            parsedLocation.coordinates = [
              Number(point.lng || point.longitude || 0),
              Number(point.lat || point.latitude || 0)
            ];
        }
      }
    }

    const service = await Service.create({
      title,
      description,
      provider: req.user.id,
      serviceType,
      duration,
      location: parsedLocation,
      groupSize,
      pricing,
      cancellationPolicy,
      requirements,
      media,
      seo: {
        slug
      }
    });

    res.status(201).json({
      success: true,
      message: 'Service created successfully',
      data: { service }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating service',
      error: error.message
    });
  }
};

// @desc    Get all services with filters
// @route   GET /api/services
// @access  Public
const getServices = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      serviceType,
      minPrice,
      maxPrice,
      location,
      groupSize,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const query = { status: 'published' };

    // Search by title or description
    if (search) {
      query.$text = { $search: search };
    }

    // Filter by service type
    if (serviceType) {
      query.serviceType = { $in: serviceType.split(',') };
    }

    // Filter by price range
    if (minPrice || maxPrice) {
      query['pricing.basePrice'] = {};
      if (minPrice) query['pricing.basePrice'].$gte = Number(minPrice);
      if (maxPrice) query['pricing.basePrice'].$lte = Number(maxPrice);
    }

    // Filter by location (nearby search)
    if (location && location.coordinates) {
      query.location = {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [Number(location.coordinates[0]), Number(location.coordinates[1])]
          },
          $maxDistance: location.radius || 50000 // Default 50km
        }
      };
    }
    
    // Filter by city for services
    if (req.query.city) {
      query['location.city'] = req.query.city;
    }
    
    // Also support location.city for backward compatibility
    if (req.query['location.city']) {
      query['location.city'] = req.query['location.city'];
    }

    // Filter by group size
    if (groupSize) {
      query['groupSize.max'] = { $gte: Number(groupSize) };
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const services = await Service.find(query)
      .populate('provider', 'name profileImage rating')
      .sort(sort)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Service.countDocuments(query);

    res.status(200).json({
      success: true,
      data: {
        services,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalItems: total,
          itemsPerPage: limit
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching services',
      error: error.message
    });
  }
};

// @desc    Get single service by ID or slug
// @route   GET /api/services/:id
// @access  Public
const getService = async (req, res) => {
  try {
    const { id } = req.params;

    let service;
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      // Search by ObjectId
      service = await Service.findById(id)
        .populate('provider', 'name profileImage bio rating reviewCount')
        .populate({
          path: 'reviews',
          populate: {
            path: 'reviewer',
            select: 'name profileImage'
          },
          options: { limit: 10 }
        });
    } else {
      // Search by slug
      service = await Service.findOne({ 'seo.slug': id })
        .populate('provider', 'name profileImage bio rating reviewCount')
        .populate({
          path: 'reviews',
          populate: {
            path: 'reviewer',
            select: 'name profileImage'
          },
          options: { limit: 10 }
        });
    }

    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    res.status(200).json({
      success: true,
      data: { service }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching service',
      error: error.message
    });
  }
};

// @desc    Update service
// @route   PUT /api/services/:id
// @access  Private (Provider/Owner only)
const updateService = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const service = await Service.findById(id);

    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    // Check if user is the provider or admin
    if (service.provider.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this service'
      });
    }

    // Generate new slug if title is updated
    if (updateData.title && updateData.title !== service.title) {
      updateData.seo = {
        ...updateData.seo,
        slug: slugify(updateData.title, { lower: true })
      };
    }

    // Format location properly for MongoDB GeoJSON
    if (updateData.location) {
      if (typeof updateData.location === 'string') {
        try { updateData.location = JSON.parse(updateData.location); } catch (e) {}
      }
      
      if (updateData.location.coordinates) {
        if (typeof updateData.location.coordinates === 'string') {
          try { updateData.location.coordinates = JSON.parse(updateData.location.coordinates); } catch (e) {}
        }
        
        // Convert [{lat, lng}] or {lat, lng} to [lng, lat] array of numbers
        if (Array.isArray(updateData.location.coordinates) && updateData.location.coordinates.length > 0) {
          if (typeof updateData.location.coordinates[0] === 'object' && updateData.location.coordinates[0] !== null) {
            const point = updateData.location.coordinates[0];
            updateData.location.coordinates = [
              Number(point.lng || point.longitude || 0),
              Number(point.lat || point.latitude || 0)
            ];
          } else {
            updateData.location.coordinates = updateData.location.coordinates.map(Number);
          }
        } else if (typeof updateData.location.coordinates === 'object' && updateData.location.coordinates !== null) {
            const point = updateData.location.coordinates;
            updateData.location.coordinates = [
              Number(point.lng || point.longitude || 0),
              Number(point.lat || point.latitude || 0)
            ];
        }
      }
    }

    const updatedService = await Service.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    ).populate('provider', 'name profileImage');

    res.status(200).json({
      success: true,
      message: 'Service updated successfully',
      data: { service: updatedService }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating service',
      error: error.message
    });
  }
};

// @desc    Delete service
// @route   DELETE /api/services/:id
// @access  Private (Provider/Owner only)
const deleteService = async (req, res) => {
  try {
    const { id } = req.params;

    const service = await Service.findById(id);

    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    // Check if user is the provider or admin
    if (service.provider.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this service'
      });
    }

    // Check if there are any active bookings
    const activeBookings = await Booking.find({
      service: id,
      status: { $in: ['confirmed', 'pending'] }
    });

    if (activeBookings.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete service with active bookings'
      });
    }

    // Soft delete by changing status
    await Service.findByIdAndUpdate(id, { status: 'deleted' });

    res.status(200).json({
      success: true,
      message: 'Service deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting service',
      error: error.message
    });
  }
};

// Helper function to transform service data for frontend
const transformServiceForFrontend = (service) => {
  const transformed = service.toObject ? service.toObject() : service;
  return {
    ...transformed,
    // media: transformed.media, // not needed, just ensure it's not mapped to URLs
  };
};

// @desc    Get user's services
// @route   GET /api/services/my-services
// @access  Private
const getMyServices = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    const query = { provider: req.user.id };
    if (status) query.status = status;

    const services = await Service.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Service.countDocuments(query);

    // Transform services for frontend
    const transformedServices = services.map(transformServiceForFrontend);

    res.status(200).json({
      success: true,
      data: {
        services: transformedServices,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalItems: total,
          itemsPerPage: limit
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching your services',
      error: error.message
    });
  }
};

// @desc    Update service availability
// @route   PUT /api/services/:id/availability
// @access  Private (Provider only)
const updateServiceAvailability = async (req, res) => {
  try {
    const { id } = req.params;
    const { availableSlots } = req.body;

    const service = await Service.findById(id);

    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    if (service.provider.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this service'
      });
    }

    // Update available slots
    service.availableSlots = availableSlots;
    await service.save();

    res.status(200).json({
      success: true,
      message: 'Service availability updated successfully',
      data: { service }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating service availability',
      error: error.message
    });
  }
};

// @desc    Get service availability
// @route   GET /api/services/:id/availability
// @access  Public
const getServiceAvailability = async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;
    console.log(id);
    const service = await Service.findById(id);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    let availableSlots = service.availableSlots;

    // Filter by date range if provided
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      availableSlots = availableSlots.filter(slot => {
        const slotStart = new Date(slot.startTime);
        return slotStart >= start && slotStart <= end;
      });
    }

    res.status(200).json({
      success: true,
      data: { availableSlots }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching service availability',
      error: error.message
    });
  }
};

// @desc    Get featured services
// @route   GET /api/services/featured
// @access  Public
const getFeaturedServices = async (req, res) => {
  try {
    const { limit = 6 } = req.query;

    const services = await Service.find({
      status: 'published'
    })
      .populate('provider', 'name profileImage')
      .sort({ rating: -1, reviewCount: -1 })
      .limit(Number(limit));

    res.status(200).json({
      success: true,
      data: { services }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching featured services',
      error: error.message
    });
  }
};

// @desc    Get similar services
// @route   GET /api/services/:id/similar
// @access  Public
const getSimilarServices = async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 4 } = req.query;

    const service = await Service.findById(id);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    const similarServices = await Service.find({
      _id: { $ne: id },
      status: 'published',
      serviceType: service.serviceType,
      'location.city': service.location.city
    })
      .populate('provider', 'name profileImage')
      .sort({ rating: -1 })
      .limit(Number(limit));

    res.status(200).json({
      success: true,
      data: { services: similarServices }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching similar services',
      error: error.message
    });
  }
};

// @desc    Get services by provider
// @route   GET /api/services/provider/:providerId
// @access  Public
const getServicesByProvider = async (req, res) => {
  try {
    const { providerId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    const services = await Service.find({
      provider: providerId,
      status: 'published'
    })
      .populate('provider', 'name profileImage')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Service.countDocuments({
      provider: providerId,
      status: 'published'
    });

    res.status(200).json({
      success: true,
      data: {
        services,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalItems: total,
          itemsPerPage: limit
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching provider services',
      error: error.message
    });
  }
};

// @desc    Get service statistics
// @route   GET /api/services/stats
// @access  Private
const getServiceStats = async (req, res) => {
  try {
    const userId = req.user.id;

    const stats = await Service.aggregate([
      { $match: { provider: userId } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          avgRating: { $avg: '$rating.average' }
        }
      }
    ]);

    const totalServices = await Service.countDocuments({ provider: userId });
    const totalBookings = await Booking.countDocuments({ 
      service: { $in: await Service.find({ provider: userId }).distinct('_id') }
    });

    const monthlyStats = await Service.aggregate([
      { $match: { provider: userId } },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: 12 }
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalServices,
        totalBookings,
        statusBreakdown: stats,
        monthlyStats
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching service statistics',
      error: error.message
    });
  }
};

module.exports = {
  createService,
  getServices,
  getService,
  updateService,
  deleteService,
  getMyServices,
  updateServiceAvailability,
  getServiceAvailability,
  getFeaturedServices,
  getSimilarServices,
  getServicesByProvider,
  getServiceStats
};

// --- STUBS FOR UNIMPLEMENTED ROUTE HANDLERS ---
const notImplemented = (name) => (req, res) => res.status(501).json({ success: false, message: `${name} not implemented yet` });

const stubMethods = [
  'getAllServices',
  'searchServices',
  'getServiceCategories',
  'getServiceById',
  'addAvailability',
  'updateAvailability',
  'deleteAvailability',
  'updateServiceStatus',
  'updateServiceVisibility',
  'getServiceBookings',
  'bookService',
  'getServiceRevenue',
  'getPopularServices',
  'getServiceReviews',
  'getServiceRating',
  'getPendingServices',
  'approveService',
  'rejectService'
];
stubMethods.forEach((name) => {
  if (typeof module.exports[name] === 'undefined') {
    module.exports[name] = notImplemented(name);
  }
}); 