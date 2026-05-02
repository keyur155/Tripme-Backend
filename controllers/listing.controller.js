const Property = require('../models/Property');
const User = require('../models/User');
const Booking = require('../models/Booking');
const Review = require('../models/Review');
const Wishlist = require('../models/Wishlist');
const Notification = require('../models/Notification');
const slugify = require('slugify');


// helper function to count badges 
const generateBadges = (listing) => {
  const badges = [];

  if (listing.stats?.views > 1000) {
    badges.push({
      type: "trending",
      label: "Trending",
      description: "This listing is getting a lot of attention."
    });
  }

  if (listing.stats?.bookings > 50) {
    badges.push({
      type: "popular",
      label: "Popular choice",
      description: "Guests frequently book this place."
    });
  }

  if (listing.stats?.bookingsLast7Days > 5) {
    badges.push({
      type: "high_demand",
      label: "High demand",
      description: "Booked multiple times recently."
    });
  }

  if (listing.availability?.remainingSlots < 3) {
    badges.push({
      type: "rare",
      label: "Rare find",
      description: "Limited availability left."
    });
  }

  if (listing.ratings?.avgRating >= 4.5) {
    badges.push({
      type: "rating",
      label: "Highly rated",
      description: "Guests love this place."
    });
  }

  const daysSinceCreated =
    (Date.now() - new Date(listing.createdAt)) / (1000 * 60 * 60 * 24);

  if (daysSinceCreated < 15) {
    badges.push({
      type: "new",
      label: "New",
      description: "Recently added listing."
    });
  }

  return badges;
};
// Helper function to transform listing data for frontend
const transformListingForFrontend = (listing) => {
  const transformed = listing.toObject ? listing.toObject() : listing;
  
  // Transform images to match frontend expectations
  const imageUrls = transformed.images?.map(img => img.url) || [];
  
  return {
    ...transformed,
    // For StayCard component (expects string array)
    images: imageUrls,
    // For Property component (expects object array)
    propertyImages: transformed.images || [],
    // Transform pricing for frontend
    price: {
      amount: transformed.pricing?.basePrice || 0,
      currency: transformed.pricing?.currency || 'INR'
    },
    // Add rating info if not present
    rating: transformed.rating?.average || 0,
    reviewCount: transformed.reviewCount || 0,
    // Add tags based on amenities and features
    tags: [
      ...(transformed.amenities || []).slice(0, 3),
      ...(transformed.features || []).slice(0, 2)
    ],
    // Add instant bookable flag
    instantBookable: false,
    // Ensure coordinates are properly accessible for map markers
    coordinates: transformed.location?.coordinates || transformed.coordinates,
    // Ensure location object has proper structure
    location: {
      ...transformed.location,
      coordinates: transformed.location?.coordinates || transformed.coordinates
    },
    badges: transformed.badges
  };
};

// @desc    Create new property listing
// @route   POST /api/listings
// @access  Private (Hosts only)
const createListing = async (req, res) => {
  try {
    const {
      title,
      description,
      location,
      type,
      propertyType,
      style,
      placeType,
      pricing,
      amenities,
      features,
      maxGuests,
      minNights,
      bedrooms,
      beds,
      bathrooms,
      houseRules,
      checkInTime,
      checkOutTime,
      cancellationPolicy,
      hourlyBooking,
      enable24HourBooking,
      images
    } = req.body;

    // Check if user is a host
    if (req.user.role !== 'host' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only hosts can create listings'
      });
    }

    // Check KYC status - required for publishing listings
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if KYC is verified or within grace period
    const kycStatus = user.kyc?.status || 'not_submitted';
    let kycDeadline = user.kyc?.deadline;
    
    // If this is the first listing and no deadline set, set 15-day grace period
    if (!kycDeadline && kycStatus !== 'verified') {
      const gracePeriodDays = 15;
      kycDeadline = new Date();
      kycDeadline.setDate(kycDeadline.getDate() + gracePeriodDays);
      
      // Update user with grace period deadline
      await User.findByIdAndUpdate(req.user.id, {
        'kyc.deadline': kycDeadline
      });
    }
    
    const isWithinGracePeriod = kycDeadline && new Date(kycDeadline) > new Date();
    
    // If KYC not submitted and grace period expired, block publishing
    if (kycStatus !== 'verified' && kycStatus !== 'pending' && !isWithinGracePeriod) {
      return res.status(403).json({
        success: false,
        message: 'KYC verification is required to publish listings. Your grace period has expired.',
        kycRequired: true
      });
    }

    // Validate required fields
    if (!title || !description || !location || !type || !pricing) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Generate slug
    const slug = slugify(title, { lower: true });

    // Transform images if they are strings to objects
    let transformedImages = images || [];
    if (Array.isArray(transformedImages)) {
      transformedImages = transformedImages.map((image, index) => {
        if (typeof image === 'string') {
          // If image is a string (URL), convert to object format
          return {
            url: image,
            publicId: `temp_${Date.now()}_${index}`, // Generate temporary publicId
            isPrimary: index === 0, // First image is primary
            caption: '',
            width: 0,
            height: 0,
            format: 'jpg',
            size: 0
          };
        }
        return image; // If already an object, keep as is
      });
    }

    // Create listing data object
    const listingData = {
      title,
      description,
      host: req.user.id,
      location,
      type,
      propertyType: propertyType || 'standard',
      style: style || 'modern',
      placeType: placeType || 'entire',
      pricing,
      amenities: amenities || [],
      features: features || [],
      maxGuests,
      minNights: minNights || 1,
      bedrooms,
      beds,
      bathrooms,
      houseRules: houseRules || [],
      checkInTime: checkInTime || '15:00',
      checkOutTime: checkOutTime || '11:00',
      cancellationPolicy: cancellationPolicy || 'moderate',
      hourlyBooking: hourlyBooking || {
        enabled: false,
        minStayDays: 1,
        hourlyRates: {
          sixHours: 0.30,
          twelveHours: 0.60,
          eighteenHours: 0.75
        }
      },
      enable24HourBooking: enable24HourBooking || false,
      images: transformedImages,
      seo: {
        slug
      }
    };

    const listing = await Property.create(listingData);

    res.status(201).json({
      success: true,
      message: 'Listing created successfully',
      data: { listing: transformListingForFrontend(listing) }
    });
  } catch (error) {
    console.error('Error creating listing:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating listing',
      error: error.message
    });
  }
};

// @desc    Get all listings with filters
// @route   GET /api/listings
// @access  Public
const getListings = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      type,
      minPrice,
      maxPrice,
      guests,
      amenities,
      location,
      checkIn,
      checkOut,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const query = { 
      status: 'published',
      approvalStatus: 'approved',
      isPublished: true
    };

    // Search by title or description
    if (search) {
      query.$text = { $search: search };
    }

    // Filter by property type
    if (type) {
      query.type = { $in: type.split(',') };
    }

    // Filter by price range
    if (minPrice || maxPrice) {
      query['pricing.basePrice'] = {};
      if (minPrice) query['pricing.basePrice'].$gte = Number(minPrice);
      if (maxPrice) query['pricing.basePrice'].$lte = Number(maxPrice);
    }

    // Filter by number of guests
    if (guests) {
      query.maxGuests = { $gte: Number(guests) };
    }

    // Filter by amenities
    if (amenities) {
      query.amenities = { $all: amenities.split(',') };
    }

    // 🗺️ GOOGLE MAPS GEOSPATIAL SEARCH - Priority System
    // Parse Google Maps coordinates from query params
    const lng = req.query.lng ? Number(req.query.lng) : null;
    const lat = req.query.lat ? Number(req.query.lat) : null;
    const coordinates = req.query.coordinates?.split(',').map(Number);
    const radius = req.query.radius ? Number(req.query.radius) : 20000; // Default 20km
    const bounds = req.query.bounds?.split(',').map(Number);

    console.log('🗺️ Google Maps search params:', { lng, lat, coordinates, radius, bounds });

    // Priority 1: Bounding box search (for map viewport)
    if (bounds && bounds.length === 4) {
      const [swLng, swLat, neLng, neLat] = bounds;
      console.log('🗺️ Using bounding box search:', { swLng, swLat, neLng, neLat });
      query.location = {
        $geoWithin: {
          $box: [[swLng, swLat], [neLng, neLat]]
        }
      };
    }
    // Priority 2: Radius search from coordinates (Google Places selected location)
    else if (coordinates && coordinates.length === 2) {
      const [searchLng, searchLat] = coordinates;
      console.log('🗺️ Using radius search from coordinates:', { searchLng, searchLat, radius });
      query.location = {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [searchLng, searchLat]
          },
          $maxDistance: radius
        }
      };
    }
    // Priority 3: Radius search from lng/lat params
    else if (lng !== null && lat !== null) {
      console.log('🗺️ Using radius search from lng/lat:', { lng, lat, radius });
      query.location = {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [lng, lat]
          },
          $maxDistance: radius
        }
      };
    }
    // Priority 4: Legacy location object with coordinates
    else if (location && location.coordinates) {
      console.log('🗺️ Using legacy location object:', location);
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
    // Priority 5: City/text-based search (fallback when no coordinates)
    else {
      const locationSearchTerm = location?.city || req.query['location.city'] || req.query.city;
      
      if (locationSearchTerm) {
        const searchTerm = locationSearchTerm.trim();
        console.log('🔍 Fallback to city text search:', searchTerm);
        
        // Create location search conditions with flexible matching
        const locationConditions = [
          { 'location.city': { $regex: searchTerm, $options: 'i' } },
          { 'location.address': { $regex: searchTerm, $options: 'i' } },
          { 'location.userAddress': { $regex: searchTerm, $options: 'i' } },
          { 'location.state': { $regex: searchTerm, $options: 'i' } },
          { 'location.country': { $regex: searchTerm, $options: 'i' } },
          { 'location.postalCode': { $regex: searchTerm, $options: 'i' } }
        ];
        
        // Add flexible matching for partial matches
        if (searchTerm.length >= 3) {
          const flexibleRegex = searchTerm.split('').join('.*?');
          locationConditions.push(
            { 'location.city': { $regex: flexibleRegex, $options: 'i' } },
            { 'location.address': { $regex: flexibleRegex, $options: 'i' } },
            { 'location.userAddress': { $regex: flexibleRegex, $options: 'i' } },
            { 'location.state': { $regex: flexibleRegex, $options: 'i' } }
          );
        }
        
        // Combine with existing $or conditions if any
        if (query.$or) {
          query.$and = [
            { $or: query.$or },
            { $or: locationConditions }
          ];
          delete query.$or;
        } else {
          query.$or = locationConditions;
        }
      }
    }

    // 🚨 IMPORTANT: Skip city filters when using geospatial search
    // This ensures we get ALL properties within radius, not just matching city names
    if (query.location && (query.location.$near || query.location.$geoWithin)) {
      console.log('🗺️ Using geospatial search - skipping city filters to get ALL properties in area');
      // Remove any city-based filters that might conflict with geospatial search
      delete query.$or;
      delete query.$and;
    }
    



    // Build sort object (only if NOT using geospatial $near query)
    const isUsingNearQuery = query.location?.$near !== undefined;
    const sort = {};
    if (!isUsingNearQuery) {
      sort[sortBy] = sortOrder === 'desc' ? -1 : 1;
    }

    console.log('🔍 Final search query:', JSON.stringify(query, null, 2));
    console.log('🗺️ Using geospatial $near:', isUsingNearQuery);
    
    // Build the query - $near queries cannot use .sort()
    let queryBuilder = Property.find(query).populate('host', 'name profileImage rating');
    
    // Only apply sort if NOT using $near (as $near auto-sorts by distance)
    if (!isUsingNearQuery && Object.keys(sort).length > 0) {
      queryBuilder = queryBuilder.sort(sort);
    }
    
    const listings = await queryBuilder
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    console.log(`🔍 Found ${listings.length} properties`);
    if (listings.length > 0) {
      console.log('📍 First property location:', listings[0].location);
    }

    // For $near queries, we need to count differently to avoid errors
    let total;
    if (isUsingNearQuery) {
      // Count by running the same query without pagination
      total = await Property.countDocuments({
        ...query,
        // Remove the $near for counting and use $geoWithin with a large radius instead
        location: {
          $geoWithin: {
            $centerSphere: [
              query.location.$near.$geometry.coordinates,
              query.location.$near.$maxDistance / 6378100 // Convert meters to radians (Earth radius in meters)
            ]
          }
        }
      });
    } else {
      total = await Property.countDocuments(query);
    }

    // Transform listings for frontend
    const transformedListings = listings.map(transformListingForFrontend);

    res.status(200).json({
      success: true,
      data: {
        listings: transformedListings,
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
      message: 'Error fetching listings',
      error: error.message
    });
  }
};

// @desc    Get single listing by ID or slug
// @route   GET /api/listings/:id
// @access  Public
const getListing = async (req, res) => {
  try {
    const { id } = req.params;

    let listing;
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      // Search by ObjectId
      listing = await Property.findById(id)
        .populate('host', 'name profileImage bio rating reviewCount email phone location languages createdAt')
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
      listing = await Property.findOne({ 'seo.slug': id })
        .populate('host', 'name profileImage bio rating reviewCount email phone location languages createdAt')
        .populate({
          path: 'reviews',
          populate: {
            path: 'reviewer',
            select: 'name profileImage'
          },
          options: { limit: 10 }
        });
    }

    if (!listing) {
      return res.status(404).json({
        success: false,
        message: 'Listing not found'
      });
    }

    // Check if user has this in wishlist
    let isWishlisted = false;
    if (req.user) {
      const wishlistItem = await Wishlist.findOne({
        user: req.user.id,
        listing: listing._id
      });
      isWishlisted = !!wishlistItem;
    }

    // Check if this is a request for editing (by checking if user is the host)
    const isForEditing = req.user && listing.host && listing.host.toString() === req.user.id;
    
    let responseData;
    if (isForEditing) {
      const listingObj = listing.toObject();
      // Ensure images have the correct structure for editing
      if (listingObj.images && Array.isArray(listingObj.images)) {
        listingObj.images = listingObj.images.map((image, index) => ({
          url: image.url,
          category: image.category || "Other",
          publicId: image.publicId,
          isPrimary: image.isPrimary || index === 0, // Ensure isPrimary is set
          caption: image.caption || '',
          width: image.width || 0,
          height: image.height || 0,
          format: image.format || 'jpg',
          size: image.size || 0
        }));
      }
      responseData = listingObj;
    } else {
      responseData = transformListingForFrontend(listing);
     responseData.badges = {
  highlight: [{ label: "Guest favourite", icon: "🌿" }],
  details: [
    { label: "Exceptional check-in", icon: "🔑" },
    { label: "Great location", icon: "📍" }
  ],
  insights: [
    { label: "Price is lower than average", icon: "🏷️" }
  ],
  urgency: [
    { label: "Only 1 left", icon: "⚡" }
  ]
};
    }
    

    
    res.status(200).json({
      success: true,
      data: {
        listing: {
          ...responseData,
          isWishlisted
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching listing',
      error: error.message
    });
  }
};

// @desc    Update listing
// @route   PUT /api/listings/:id
// @access  Private (Host/Owner only)
const updateListing = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    
    console.log('Update listing request:', {
      id,
      updateData,
      placeType: updateData.placeType,
      hasImages: !!updateData.images,
      imagesCount: updateData.images?.length || 0,
      images: updateData.images
    });

    const listing = await Property.findById(id);

    if (!listing) {
      return res.status(404).json({
        success: false,
        message: 'Listing not found'
      });
    }

    // Check if user is the host or admin
    if (listing.host && listing.host.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this listing'
      });
    }

    // Transform images if they are strings to objects
    if (updateData.images && Array.isArray(updateData.images) && updateData.images.length > 0) {
      updateData.images = updateData.images.map((image, index) => {
        if (typeof image === 'string') {
          // If image is a string (URL), convert to object format
          return {
            url: image,
            publicId: `temp_${Date.now()}_${index}`, // Generate temporary publicId
            isPrimary: index === 0, // First image is primary
            caption: '',
            width: 0,
            height: 0,
            format: 'jpg',
            size: 0
          };
        }
        return image; // If already an object, keep as is
      });
    } else if (updateData.images && Array.isArray(updateData.images) && updateData.images.length === 0) {
      // If empty array is sent, remove it from updateData to avoid overwriting existing images
      console.log('Empty images array received, removing from update data to preserve existing images');
      delete updateData.images;
    }
    
    console.log('Processed update data:', {
      hasImages: !!updateData.images,
      imagesCount: updateData.images?.length || 0,
      images: updateData.images,
      allFields: Object.keys(updateData)
    });

    // Generate new slug if title is updated
    if (updateData.title && updateData.title !== listing.title) {
      updateData.seo = {
        ...updateData.seo,
        slug: slugify(updateData.title, { lower: true })
      };
    }

    const updatedListing = await Property.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    ).populate('host', 'name profileImage');

    console.log('Updated listing:', {
      id: updatedListing._id,
      placeType: updatedListing.placeType,
      originalPlaceType: listing.placeType
    });

    res.status(200).json({
      success: true,
      message: 'Listing updated successfully',
      data: { listing: transformListingForFrontend(updatedListing) }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating listing',
      error: error.message
    });
  }
};

// @desc    Delete listing
// @route   DELETE /api/listings/:id
// @access  Private (Host/Owner only)
const deleteListing = async (req, res) => {
  try {
    const { id } = req.params;

    const listing = await Property.findById(id);

    if (!listing) {
      return res.status(404).json({
        success: false,
        message: 'Listing not found'
      });
    }

    // Check if user is the host or admin
    if (listing.host && listing.host.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this listing'
      });
    }

    // Check if there are any active bookings
    const activeBookings = await Booking.find({
      listing: id,
      status: { $in: ['confirmed', 'pending'] }
    });

    if (activeBookings.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete listing with active bookings'
      });
    }

    // Soft delete by changing status
    await Property.findByIdAndUpdate(id, { status: 'deleted' });

    res.status(200).json({
      success: true,
      message: 'Listing deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting listing',
      error: error.message
    });
  }
};

// @desc    Get user's listings
// @route   GET /api/listings/my-listings
// @access  Private
const getMyListings = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;

    const query = { host: req.user.id };
    if (status) {
      query.status = status;
    }

    const listings = await Property.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Property.countDocuments(query);

    // Transform listings for frontend
    const transformedListings = listings.map(transformListingForFrontend);

    res.status(200).json({
      success: true,
      data: {
        listings: transformedListings,
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
      message: 'Error fetching your listings',
      error: error.message
    });
  }
};





// @desc    Add listing to wishlist
// @route   POST /api/listings/:id/wishlist
// @access  Private
const addToWishlist = async (req, res) => {
  try {
    const { id } = req.params;

    const listing = await Property.findById(id);
    if (!listing) {
      return res.status(404).json({
        success: false,
        message: 'Listing not found'
      });
    }

    const existingWishlist = await Wishlist.findOne({
      user: req.user.id,
      listing: id
    });

    if (existingWishlist) {
      return res.status(400).json({
        success: false,
        message: 'Listing already in wishlist'
      });
    }

    await Wishlist.create({
      user: req.user.id,
      listing: id
    });

    res.status(200).json({
      success: true,
      message: 'Added to wishlist successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error adding to wishlist',
      error: error.message
    });
  }
};

// @desc    Remove listing from wishlist
// @route   DELETE /api/listings/:id/wishlist
// @access  Private
const removeFromWishlist = async (req, res) => {
  try {
    const { id } = req.params;

    await Wishlist.findOneAndDelete({
      user: req.user.id,
      listing: id
    });

    res.status(200).json({
      success: true,
      message: 'Removed from wishlist successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error removing from wishlist',
      error: error.message
    });
  }
};

// @desc    Publish listing
// @route   POST /api/listings/:id/publish
// @access  Private (Host/Owner only)
const publishListing = async (req, res) => {
  try {
    const { id } = req.params;

    const listing = await Property.findById(id);

    if (!listing) {
      return res.status(404).json({
        success: false,
        message: 'Listing not found'
      });
    }

    // Check if user is the host or admin
    if (listing.host && listing.host.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to publish this listing'
      });
    }

    // Check if listing is already published
    if (listing.status === 'published') {
      return res.status(400).json({
        success: false,
        message: 'Listing is already published'
      });
    }

    // Submit the listing for admin approval
    listing.status = 'draft'; // Keep as draft until approved
    listing.approvalStatus = 'pending';
    listing.isDraft = false;
    listing.isPublished = false; // Not published until host decides
    
    await listing.save();

    res.status(200).json({
      success: true,
      message: 'Listing submitted for approval. It will be published once approved by admin.',
      data: { listing: transformListingForFrontend(listing) }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error publishing listing',
      error: error.message
    });
  }
};

// @desc    Publish approved listing (make it available for booking)
// @route   POST /api/listings/:id/publish-approved
// @access  Private (Host/Owner only)
const publishApprovedListing = async (req, res) => {
  try {
    const { id } = req.params;

    const listing = await Property.findById(id);

    if (!listing) {
      return res.status(404).json({
        success: false,
        message: 'Listing not found'
      });
    }

    // Check if user is the host or admin
    if (listing.host && listing.host.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to publish this listing'
      });
    }

    // Check if listing is approved
    if (listing.approvalStatus !== 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Listing must be approved before publishing'
      });
    }

    // Publish the listing
    listing.status = 'published';
    listing.isPublished = true;
    
    await listing.save();

    res.status(200).json({
      success: true,
      message: 'Listing published successfully and is now available for booking',
      data: { listing: transformListingForFrontend(listing) }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error publishing listing',
      error: error.message
    });
  }
};

// @desc    Unpublish listing
// @route   POST /api/listings/:id/unpublish
// @access  Private (Host/Owner only)
const unpublishListing = async (req, res) => {
  try {
    const { id } = req.params;

    const listing = await Property.findById(id);

    if (!listing) {
      return res.status(404).json({
        success: false,
        message: 'Listing not found'
      });
    }

    // Check if user is the host or admin
    if (listing.host && listing.host.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to unpublish this listing'
      });
    }

    // Check if listing is already unpublished
    if (listing.status !== 'published') {
      return res.status(400).json({
        success: false,
        message: 'Listing is not published'
      });
    }

    // Unpublish the listing (but keep approval status)
    listing.status = 'draft';
    listing.isDraft = true;
    listing.isPublished = false;
    
    await listing.save();

    res.status(200).json({
      success: true,
      message: 'Listing unpublished successfully',
      data: { listing: transformListingForFrontend(listing) }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error unpublishing listing',
      error: error.message
    });
  }
};

// @desc    Get featured listings
// @route   GET /api/listings/featured
// @access  Public
const getFeaturedListings = async (req, res) => {
  try {
    const { limit = 6 } = req.query;

    const listings = await Property.find({
      status: 'published',
      approvalStatus: 'approved',
      isFeatured: true
    })
      .populate('host', 'name profileImage')
      .sort({ rating: -1, reviewCount: -1 })
      .limit(Number(limit));

    // Transform featured listings for frontend
    const transformedFeaturedListings = listings.map(transformListingForFrontend);

    res.status(200).json({
      success: true,
      data: { listings: transformedFeaturedListings }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching featured listings',
      error: error.message
    });
  }
};


// @desc    Get featured listings
// @route   GET /api/listings/featured
// @access  Public
const getSponseredListings = async (req, res) => {
  try {
    const { limit = 6 } = req.query;

    const listings = await Property.find({
      status: 'published',
      approvalStatus: 'approved',
      isSponsored: true
    })
      .populate('host', 'name profileImage')
      .sort({ rating: -1, reviewCount: -1 })
      .limit(Number(limit));

    // Transform featured listings for frontend
    const transformedFeaturedListings = listings.map(transformListingForFrontend);

    res.status(200).json({
      success: true,
      data: { listings: transformedFeaturedListings }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching featured listings',
      error: error.message
    });
  }
};

// @desc    Get similar listings
// @route   GET /api/listings/:id/similar
// @access  Public
const getSimilarListings = async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 4 } = req.query;

    const listing = await Property.findById(id);
    if (!listing) {
      return res.status(404).json({
        success: false,
        message: 'Listing not found'
      });
    }

    const similarListings = await Property.find({
      _id: { $ne: id },
      status: 'published',
      approvalStatus: 'approved',
      type: listing.type,
      'location.city': listing.location.city
    })
      .populate('host', 'name profileImage')
      .sort({ rating: -1 })
      .limit(Number(limit));

    // Transform similar listings for frontend
    const transformedSimilarListings = similarListings.map(transformListingForFrontend);

    res.status(200).json({
      success: true,
      data: { listings: transformedSimilarListings }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching similar listings',
      error: error.message
    });
  }
};

module.exports = {
  createListing,
  getListings,
  getListing,
  updateListing,
  deleteListing,
  getMyListings,
  addToWishlist,
  removeFromWishlist,
  getFeaturedListings,
  getSponseredListings,
  getSimilarListings,
  publishListing,
  publishApprovedListing,
  unpublishListing
};

// @desc    Get pending listings for admin approval
// @route   GET /api/listings/admin/pending
// @access  Private (Admin only)
const getPendingListings = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    
    const query = {
      status: 'draft',
      approvalStatus: 'pending'
    };
    
    const listings = await Property.find(query)
      .populate('host', 'name email profileImage')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Property.countDocuments(query);
    console.log('🔍 Found listings:', listings.length, 'Total:', total);
    
    res.status(200).json({
      success: true,
      data: {
        listings: listings.map(transformListingForFrontend),
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
      message: 'Error fetching pending listings',
      error: error.message
    });
  }
};

// @desc    Approve listing (Admin only)
// @route   PATCH /api/listings/admin/:id/approve
// @access  Private (Admin only)
const approveListing = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNotes } = req.body;
    
    const listing = await Property.findById(id);
    
    if (!listing) {
      return res.status(404).json({
        success: false,
        message: 'Listing not found'
      });
    }
    
    if (listing.status !== 'draft' || listing.approvalStatus !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Listing is not pending approval'
      });
    }
    
    // Approve the listing
    listing.status = 'draft'; // Keep as draft until host publishes
    listing.approvalStatus = 'approved';
    listing.approvedBy = req.user.id;
    listing.approvedAt = new Date();
    listing.isPublished = false; // Not published until host decides
    if (adminNotes) {
      listing.adminNotes = adminNotes;
    }
    
    await listing.save();
    
    // Create notification for host
    await Notification.create({
      user: listing.host,
      type: 'listing_approved',
      title: 'Listing Approved',
      message: `Your listing "${listing.title}" has been approved and is now live!`,
      data: { listingId: listing._id }
    });
    
    res.status(200).json({
      success: true,
      message: 'Listing approved successfully',
      data: { listing: transformListingForFrontend(listing) }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error approving listing',
      error: error.message
    });
  }
};

// @desc    Reject listing (Admin only)
// @route   PATCH /api/listings/admin/:id/reject
// @access  Private (Admin only)
const rejectListing = async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectionReason, adminNotes } = req.body;
    
    if (!rejectionReason) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required'
      });
    }
    
    const listing = await Property.findById(id);
    
    if (!listing) {
      return res.status(404).json({
        success: false,
        message: 'Listing not found'
      });
    }
    
    if (listing.status !== 'draft' || listing.approvalStatus !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Listing is not pending approval'
      });
    }
    
    // Reject the listing
    listing.status = 'rejected';
    listing.approvalStatus = 'rejected';
    listing.rejectedBy = req.user.id;
    listing.rejectedAt = new Date();
    listing.rejectionReason = rejectionReason;
    if (adminNotes) {
      listing.adminNotes = adminNotes;
    }
    
    await listing.save();
    
    // Create notification for host
    await Notification.create({
      user: listing.host,
      type: 'listing_rejected',
      title: 'Listing Rejected',
      message: `Your listing "${listing.title}" was rejected. Reason: ${rejectionReason}`,
      data: { listingId: listing._id, rejectionReason }
    });
    
    res.status(200).json({
      success: true,
      message: 'Listing rejected successfully',
      data: { listing: transformListingForFrontend(listing) }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error rejecting listing',
      error: error.message
    });
  }
};

// --- STUBS FOR UNIMPLEMENTED ROUTE HANDLERS ---
// Only add stubs for methods that don't exist in module.exports
const notImplemented = (name) => (req, res) => res.status(501).json({ success: false, message: `${name} not implemented yet` });

// List of all referenced route handlers in listing.routes.js that need stubs
const stubMethods = [
  'getAllListings',
  'searchListings',
  'getListingCategories',
  'getPopularLocations',
  'uploadPhotos',
  'deletePhoto',
  'setPrimaryPhoto',
  'updatePricing',
  'updateListingStatus',
  'updateListingVisibility',
  'getListingReviews',
  'getListingRating',
  'getWishlistedListings',
  'getListingStats',
  'getListingRevenue',
  'getListingViews',
  'getHostDashboard',
  'getHostPerformance',
  'featureListing'
];
stubMethods.forEach((name) => {
  if (!module.exports[name]) {
    module.exports[name] = notImplemented(name);
  }
});

// @desc    Get properties for map viewport (geospatial only, no text filters)
// @route   GET /api/listings/map
// @access  Public
const getMapProperties = async (req, res) => {
  try {
    const { bounds, guests, checkIn, checkOut } = req.query;

    console.log('🗺️ MAP SEARCH - Bounds:', bounds);

    // Base query - only published and approved properties
    const query = { 
      status: 'published',
      approvalStatus: 'approved',
      isPublished: true
    };

    // Guest filter
    if (guests) {
      query.maxGuests = { $gte: Number(guests) };
    }

    // Geospatial query - REQUIRED for map searches
    if (bounds) {
      const boundsArray = bounds.split(',').map(Number);
      if (boundsArray.length === 4) {
        const [swLng, swLat, neLng, neLat] = boundsArray;
        console.log('🗺️ Searching properties in viewport:', { swLng, swLat, neLng, neLat });
        
        query.location = {
          $geoWithin: {
            $box: [[swLng, swLat], [neLng, neLat]]
          }
        };
      } else {
        return res.status(400).json({
          success: false,
          error: 'Invalid bounds format. Expected: swLng,swLat,neLng,neLat'
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        error: 'Bounds parameter is required for map searches'
      });
    }

    console.log('🗺️ Final query:', JSON.stringify(query, null, 2));

    // Execute query
    const properties = await Property.find(query)
      .populate('host', 'name profileImage')
      .select('-reviews -__v')
      .limit(500) // Higher limit for map display
      .lean();

    console.log('🗺️ Found properties:', properties.length);

    // Transform for frontend
    const transformedProperties = properties.map(transformListingForFrontend);

    res.json({
      success: true,
      data: {
        listings: transformedProperties,
        count: transformedProperties.length,
        searchType: 'map_viewport'
      }
    });

  } catch (error) {
    console.error('❌ Error in map search:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch properties for map',
      message: error.message
    });
  }
};

// Add the new admin functions to module.exports
module.exports.getPendingListings = getPendingListings;
module.exports.approveListing = approveListing;
module.exports.rejectListing = rejectListing;
module.exports.getMapProperties = getMapProperties;
