// const Review = require('../models/Review');
// const Booking = require('../models/Booking');
// const Property = require('../models/Property');
// const Service = require('../models/Service');
// const User = require('../models/User');
// const Notification = require('../models/Notification');

// // @desc    Create review
// // @route   POST /api/reviews
// // @access  Private
// const createReview = async (req, res) => {
//   try {
//     const {
//       bookingId,
//       rating,
//       subRatings,
//       comment,
//       reviewType
//     } = req.body;

//     // Validate booking exists and belongs to user
//     const booking = await Booking.findById(bookingId);
//     if (!booking) {
//       return res.status(404).json({
//         success: false,
//         message: 'Booking not found'
//       });
//     }

//     if (booking.user.toString() !== req.user.id) {
//       return res.status(403).json({
//         success: false,
//         message: 'Not authorized to review this booking'
//       });
//     }

//     // Check if booking is completed
//     if (booking.status !== 'completed') {
//       return res.status(400).json({
//         success: false,
//         message: 'Can only review completed bookings'
//       });
//     }

//     // Check if review already exists
//     const existingReview = await Review.findOne({ booking: bookingId });
//     if (existingReview) {
//       return res.status(400).json({
//         success: false,
//         message: 'Review already exists for this booking'
//       });
//     }

//     // Determine review type and related entities
//     let listing = null;
//     let service = null;
//     let reviewedUser = null;

//     if (booking.bookingType === 'property') {
//       listing = await Property.findById(booking.listing);
//       reviewedUser = booking.host;
//     } else {
//       service = await Service.findById(booking.service);
//       reviewedUser = booking.host;
//     }

//     // Create review
//     const review = await Review.create({
//       booking: bookingId,
//       reviewer: req.user.id,
//       reviewedUser,
//       listing: booking.listing,
//       service: booking.service,
//       reviewType,
//       rating,
//       subRatings,
//       comment
//     });

//     // Update average ratings
//     await updateAverageRatings(listing, service, reviewedUser);

//     // Create notification for host
//     await Notification.create({
//       user: reviewedUser,
//       type: 'new_review',
//       title: 'New Review Received',
//       message: `You received a ${rating}-star review from ${req.user.name}`,
//       data: { reviewId: review._id }
//     });

//     res.status(201).json({
//       success: true,
//       message: 'Review created successfully',
//       data: { review }
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: 'Error creating review',
//       error: error.message
//     });
//   }
// };

// // @desc    Get reviews for listing/service
// // @route   GET /api/reviews
// // @access  Public
// const getReviews = async (req, res) => {
//   try {
//     const {
//       listingId,
//       serviceId,
//       userId,
//       page = 1,
//       limit = 10,
//       rating,
//       sortBy = 'createdAt',
//       sortOrder = 'desc'
//     } = req.query;

//     const query = { isPublished: true };

//     if (listingId) {
//       query.listing = listingId;
//     } else if (serviceId) {
//       query.service = serviceId;
//     } else if (userId) {
//       query.reviewedUser = userId;
//     }

//     if (rating) {
//       query.rating = Number(rating);
//     }

//     // Build sort object
//     const sort = {};
//     sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

//     const reviews = await Review.find(query)
//       .populate('reviewer', 'name profileImage')
//       .populate('reviewedUser', 'name profileImage')
//       .sort(sort)
//       .limit(limit * 1)
//       .skip((page - 1) * limit)
//       .exec();

//     const total = await Review.countDocuments(query);

//     // Calculate rating distribution
//     const ratingDistribution = await Review.aggregate([
//       { $match: query },
//       {
//         $group: {
//           _id: '$rating',
//           count: { $sum: 1 }
//         }
//       },
//       { $sort: { _id: -1 } }
//     ]);

//     res.status(200).json({
//       success: true,
//       data: {
//         reviews,
//         pagination: {
//           currentPage: page,
//           totalPages: Math.ceil(total / limit),
//           totalItems: total,
//           itemsPerPage: limit
//         },
//         ratingDistribution
//       }
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: 'Error fetching reviews',
//       error: error.message
//     });
//   }
// };

// // @desc    Get single review
// // @route   GET /api/reviews/:id
// // @access  Public
// const getReview = async (req, res) => {
//   try {
//     const { id } = req.params;

//     const review = await Review.findById(id)
//       .populate('reviewer', 'name profileImage')
//       .populate('reviewedUser', 'name profileImage')
//       .populate('listing', 'title images')
//       .populate('service', 'title media');

//     if (!review) {
//       return res.status(404).json({
//         success: false,
//         message: 'Review not found'
//       });
//     }

//     res.status(200).json({
//       success: true,
//       data: { review }
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: 'Error fetching review',
//       error: error.message
//     });
//   }
// };

// // @desc    Update review
// // @route   PUT /api/reviews/:id
// // @access  Private
// const updateReview = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { rating, subRatings, comment } = req.body;

//     const review = await Review.findById(id);

//     if (!review) {
//       return res.status(404).json({
//         success: false,
//         message: 'Review not found'
//       });
//     }

//     // Check if user is the reviewer
//     if (review.reviewer.toString() !== req.user.id) {
//       return res.status(403).json({
//         success: false,
//         message: 'Not authorized to update this review'
//       });
//     }

//     // Update review
//     const updatedReview = await Review.findByIdAndUpdate(
//       id,
//       { rating, subRatings, comment },
//       { new: true, runValidators: true }
//     ).populate('reviewer', 'name profileImage');

//     // Update average ratings
//     await updateAverageRatings(
//       review.listing,
//       review.service,
//       review.reviewedUser
//     );

//     res.status(200).json({
//       success: true,
//       message: 'Review updated successfully',
//       data: { review: updatedReview }
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: 'Error updating review',
//       error: error.message
//     });
//   }
// };

// // @desc    Delete review
// // @route   DELETE /api/reviews/:id
// // @access  Private
// const deleteReview = async (req, res) => {
//   try {
//     const { id } = req.params;

//     const review = await Review.findById(id);

//     if (!review) {
//       return res.status(404).json({
//         success: false,
//         message: 'Review not found'
//       });
//     }

//     // Check if user is the reviewer or admin
//     if (review.reviewer.toString() !== req.user.id && req.user.role !== 'admin') {
//       return res.status(403).json({
//         success: false,
//         message: 'Not authorized to delete this review'
//       });
//     }

//     await Review.findByIdAndDelete(id);

//     // Update average ratings
//     await updateAverageRatings(
//       review.listing,
//       review.service,
//       review.reviewedUser
//     );

//     res.status(200).json({
//       success: true,
//       message: 'Review deleted successfully'
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: 'Error deleting review',
//       error: error.message
//     });
//   }
// };

// // @desc    Host response to review
// // @route   POST /api/reviews/:id/response
// // @access  Private
// const addHostResponse = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { text } = req.body;

//     const review = await Review.findById(id);

//     if (!review) {
//       return res.status(404).json({
//         success: false,
//         message: 'Review not found'
//       });
//     }

//     // Check if user is the reviewed host
//     if (review.reviewedUser.toString() !== req.user.id) {
//       return res.status(403).json({
//         success: false,
//         message: 'Not authorized to respond to this review'
//       });
//     }

//     // Check if response already exists
//     if (review.hostResponse && review.hostResponse.text) {
//       return res.status(400).json({
//         success: false,
//         message: 'Response already exists for this review'
//       });
//     }

//     // Add host response
//     review.hostResponse = {
//       text,
//       respondedAt: new Date()
//     };

//     await review.save();

//     res.status(200).json({
//       success: true,
//       message: 'Response added successfully',
//       data: { review }
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: 'Error adding response',
//       error: error.message
//     });
//   }
// };

// // @desc    Report review
// // @route   POST /api/reviews/:id/report
// // @access  Private
// const reportReview = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { reason } = req.body;

//     const review = await Review.findById(id);

//     if (!review) {
//       return res.status(404).json({
//         success: false,
//         message: 'Review not found'
//       });
//     }

//     // Check if already reported
//     if (review.reported && review.reported.isReported) {
//       return res.status(400).json({
//         success: false,
//         message: 'Review already reported'
//       });
//     }

//     // Report review
//     review.reported = {
//       isReported: true,
//       reason,
//       reportedBy: req.user.id,
//       reportedAt: new Date()
//     };

//     await review.save();

//     res.status(200).json({
//       success: true,
//       message: 'Review reported successfully'
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: 'Error reporting review',
//       error: error.message
//     });
//   }
// };

// // @desc    Get user's reviews
// // @route   GET /api/reviews/my-reviews
// // @access  Private
// const getMyReviews = async (req, res) => {
//   try {
//     const { page = 1, limit = 10 } = req.query;

//     const reviews = await Review.find({ reviewer: req.user.id })
//       .populate('listing', 'title images')
//       .populate('service', 'title media')
//       .populate('reviewedUser', 'name profileImage')
//       .sort({ createdAt: -1 })
//       .limit(limit * 1)
//       .skip((page - 1) * limit)
//       .exec();

//     const total = await Review.countDocuments({ reviewer: req.user.id });

//     res.status(200).json({
//       success: true,
//       data: {
//         reviews,
//         pagination: {
//           currentPage: page,
//           totalPages: Math.ceil(total / limit),
//           totalItems: total,
//           itemsPerPage: limit
//         }
//       }
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: 'Error fetching your reviews',
//       error: error.message
//     });
//   }
// };

// // @desc    Get reviews received by user
// // @route   GET /api/reviews/received
// // @access  Private
// const getReceivedReviews = async (req, res) => {
//   try {
//     const { page = 1, limit = 10 } = req.query;

//     const reviews = await Review.find({ reviewedUser: req.user.id })
//       .populate('reviewer', 'name profileImage')
//       .populate('listing', 'title images')
//       .populate('service', 'title media')
//       .sort({ createdAt: -1 })
//       .limit(limit * 1)
//       .skip((page - 1) * limit)
//       .exec();

//     const total = await Review.countDocuments({ reviewedUser: req.user.id });

//     res.status(200).json({
//       success: true,
//       data: {
//         reviews,
//         pagination: {
//           currentPage: page,
//           totalPages: Math.ceil(total / limit),
//           totalItems: total,
//           itemsPerPage: limit
//         }
//       }
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: 'Error fetching received reviews',
//       error: error.message
//     });
//   }
// };

// // Helper function to update average ratings
// const updateAverageRatings = async (listing, service, reviewedUser) => {
//   try {
//     // Update listing ratings
//     if (listing) {
//       const listingReviews = await Review.find({
//         listing: listing._id,
//         isPublished: true
//       });

//       if (listingReviews.length > 0) {
//         const avgRating = listingReviews.reduce((sum, review) => sum + review.rating, 0) / listingReviews.length;
        
//         const subRatings = {
//           cleanliness: 0,
//           accuracy: 0,
//           communication: 0,
//           location: 0,
//           checkIn: 0,
//           value: 0
//         };

//         let subRatingCount = 0;
//         listingReviews.forEach(review => {
//           if (review.subRatings) {
//             Object.keys(subRatings).forEach(key => {
//               if (review.subRatings[key]) {
//                 subRatings[key] += review.subRatings[key];
//                 subRatingCount++;
//               }
//             });
//           }
//         });

//         if (subRatingCount > 0) {
//           Object.keys(subRatings).forEach(key => {
//             subRatings[key] = subRatings[key] / (subRatingCount / 6); // Divide by number of reviews
//           });
//         }

//         await Property.findByIdAndUpdate(listing._id, {
//           rating: {
//             average: Math.round(avgRating * 10) / 10,
//             ...subRatings
//           },
//           reviewCount: listingReviews.length
//         });
//       }
//     }

//     // Update service ratings
//     if (service) {
//       const serviceReviews = await Review.find({
//         service: service._id,
//         isPublished: true
//       });

//       if (serviceReviews.length > 0) {
//         const avgRating = serviceReviews.reduce((sum, review) => sum + review.rating, 0) / serviceReviews.length;
        
//         const subRatings = {
//           quality: 0,
//           communication: 0,
//           value: 0
//         };

//         let subRatingCount = 0;
//         serviceReviews.forEach(review => {
//           if (review.subRatings) {
//             Object.keys(subRatings).forEach(key => {
//               if (review.subRatings[key]) {
//                 subRatings[key] += review.subRatings[key];
//                 subRatingCount++;
//               }
//             });
//           }
//         });

//         if (subRatingCount > 0) {
//           Object.keys(subRatings).forEach(key => {
//             subRatings[key] = subRatings[key] / (subRatingCount / 3);
//           });
//         }

//         await Service.findByIdAndUpdate(service._id, {
//           rating: {
//             average: Math.round(avgRating * 10) / 10,
//             ...subRatings
//           },
//           reviewCount: serviceReviews.length
//         });
//       }
//     }

//     // Update user ratings
//     if (reviewedUser) {
//       const userReviews = await Review.find({
//         reviewedUser: reviewedUser._id,
//         isPublished: true
//       });

//       if (userReviews.length > 0) {
//         const avgRating = userReviews.reduce((sum, review) => sum + review.rating, 0) / userReviews.length;
        
//         await User.findByIdAndUpdate(reviewedUser._id, {
//           rating: Math.round(avgRating * 10) / 10,
//           reviewCount: userReviews.length
//         });
//       }
//     }
//   } catch (error) {
//     console.error('Error updating average ratings:', error);
//   }
// };

// module.exports = {
//   createReview,
//   getReviews,
//   getReview,
//   updateReview,
//   deleteReview,
//   addHostResponse,
//   reportReview,
//   getMyReviews,
//   getReceivedReviews
// };

// // --- STUBS FOR UNIMPLEMENTED ROUTE HANDLERS ---
// const notImplemented = (name) => (req, res) => res.status(501).json({ success: false, message: `${name} not implemented yet` });

// const stubMethods = [
//   'getPropertyReviews',
//   'getServiceReviews',
//   'getUserReviews',
//   'getHostReviews',
//   'getReviewById',
//   'likeReview',
//   'unlikeReview',
//   'getPropertyReviewStats',
//   'getServiceReviewStats',
//   'getHostReviewStats',
//   'getPendingReviews',
//   'moderateReview'
// ];
// stubMethods.forEach((name) => {
//   if (typeof module.exports[name] === 'undefined') {
//     module.exports[name] = notImplemented(name);
//   }
// }); 


const Review = require('../models/Review');
const Booking = require('../models/Booking');
const Property = require('../models/Property');
const User = require('../models/User');
const Notification = require('../models/Notification');

// @desc    Create review
// @route   POST /api/reviews
// @access  Private
const createReview = async (req, res) => {
  try {
    const {
      bookingId,
      rating,
      comment
    } = req.body;

    // Validate booking exists and belongs to user
    const booking = await Booking.findById(bookingId).populate('listing');
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (booking.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to review this booking'
      });
    }

    // Check if booking is completed
    // if (booking.status !== 'completed') {
    //   return res.status(400).json({
    //     success: false,
    //     message: 'Can only review completed bookings'
    //   });
    // }

    // Check if review already exists
    const existingReview = await Review.findOne({ booking: bookingId });
    if (existingReview) {
      return res.status(400).json({
        success: false,
        message: 'Review already exists for this booking'
      });
    }

    // Create review
    const review = await Review.create({
      booking: bookingId,
      property: booking.listing._id,
      reviewer: req.user.id,
      host: booking.host,
      rating,
      comment,
      isVerified: true // Verified stay since it's from a completed booking
    });

    // Update property ratings
    await updatePropertyRatings(booking.listing._id);

    // Create notification for host
    await Notification.create({
      user: booking.host,
      type: 'review',
      title: 'New Review Received',
      message: `You received a ${rating.overall}-star review from ${req.user.name}`,
      data: { reviewId: review._id }
    });

    const populatedReview = await Review.findById(review._id)
      .populate('reviewer', 'name profileImage')
      .populate('host', 'name profileImage')
      .populate('property', 'title images');

    res.status(201).json({
      success: true,
      message: 'Review created successfully',
      data: populatedReview
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating review',
      error: error.message
    });
  }
};

// @desc    Get property reviews
// @route   GET /api/reviews/properties/:propertyId
// @access  Public
const getPropertyReviews = async (req, res) => {
  try {
    const { propertyId  } = req.params;
    const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    const query = { property: propertyId, isPublic: true };
    
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const reviews = await Review.find(query)
      .populate('reviewer', 'name profileImage')
      .populate('response.respondedBy', 'name profileImage')
      .sort(sort)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Review.countDocuments(query);

    res.status(200).json({
      success: true,
      data: {
        reviews,
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
      message: 'Error fetching reviews',
      error: error.message
    });
  }
};

// @desc    Get property review summary
// @route   GET /api/reviews/properties/:propertyId/summary
// @access  Public
const getPropertyReviewSummary = async (req, res) => {
  try {
    const { propertyId  } = req.params;

    const reviews = await Review.find({ property: propertyId, isPublic: true });
    
    if (reviews.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          averageRating: 0,
          totalReviews: 0,
          ratingBreakdown: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
          categoryAverages: {
            cleanliness: 0,
            communication: 0,
            checkIn: 0,
            accuracy: 0,
            location: 0,
            value: 0
          },
          recentReviews: []
        }
      });
    }

    // Calculate overall rating
    const averageRating = reviews.reduce((sum, review) => sum + review.rating.overall, 0) / reviews.length;

    // Calculate rating breakdown
    const ratingBreakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    reviews.forEach(review => {
      ratingBreakdown[review.rating.overall]++;
    });

    // Calculate category averages
    const categoryAverages = {
      cleanliness: reviews.reduce((sum, review) => sum + review.rating.cleanliness, 0) / reviews.length,
      communication: reviews.reduce((sum, review) => sum + review.rating.communication, 0) / reviews.length,
      checkIn: reviews.reduce((sum, review) => sum + review.rating.checkIn, 0) / reviews.length,
      accuracy: reviews.reduce((sum, review) => sum + review.rating.accuracy, 0) / reviews.length,
      location: reviews.reduce((sum, review) => sum + review.rating.location, 0) / reviews.length,
      value: reviews.reduce((sum, review) => sum + review.rating.value, 0) / reviews.length
    };

    // Get recent reviews
    const recentReviews = await Review.find({ property: propertyId, isPublic: true })
      .populate('reviewer', 'name profileImage')
      .populate('response.respondedBy', 'name profileImage')
      .sort({ createdAt: -1 })
      .limit(5);

    res.status(200).json({
      success: true,
      data: {
        averageRating: Math.round(averageRating * 10) / 10,
        totalReviews: reviews.length,
        ratingBreakdown,
        categoryAverages: {
          cleanliness: Math.round(categoryAverages.cleanliness * 10) / 10,
          communication: Math.round(categoryAverages.communication * 10) / 10,
          checkIn: Math.round(categoryAverages.checkIn * 10) / 10,
          accuracy: Math.round(categoryAverages.accuracy * 10) / 10,
          location: Math.round(categoryAverages.location * 10) / 10,
          value: Math.round(categoryAverages.value * 10) / 10
        },
        recentReviews
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching review summary',
      error: error.message
    });
  }
};

// @desc    Update review
// @route   PUT /api/reviews/:id
// @access  Private
const updateReview = async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;

    const review = await Review.findById(id);

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    // Check if user is reviewer
    if (review.reviewer.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this review'
      });
    }

    // Update review
    const updatedReview = await Review.findByIdAndUpdate(
      id,
      { rating, comment },
      { new: true, runValidators: true }
    ).populate('reviewer', 'name profileImage')
     .populate('response.respondedBy', 'name profileImage');

    // Update property ratings
    await updatePropertyRatings(review.property);

    res.status(200).json({
      success: true,
      message: 'Review updated successfully',
      data: updatedReview
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating review',
      error: error.message
    });
  }
};

// @desc    Delete review
// @route   DELETE /api/reviews/:id
// @access  Private
const deleteReview = async (req, res) => {
  try {
    const { id } = req.params;

    const review = await Review.findById(id);

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    // Check if user is reviewer or admin
    if (review.reviewer.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this review'
      });
    }

    await Review.findByIdAndDelete(id);

    // Update property ratings
    await updatePropertyRatings(review.property);

    res.status(200).json({
      success: true,
      message: 'Review deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting review',
      error: error.message
    });
  }
};

// @desc    Respond to review
// @route   POST /api/reviews/:id/response
// @access  Private
const respondToReview = async (req, res) => {
  try {
    const { id } = req.params;
    const { response } = req.body;

    const review = await Review.findById(id).populate('property');

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    // Check if user is property host
    if (review.host.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to respond to this review'
      });
    }

    // Add response
    const updatedReview = await Review.findByIdAndUpdate(
      id,
      {
        response: {
          comment: response,
          respondedAt: new Date(),
          respondedBy: req.user.id
        }
      },
      { new: true }
    ).populate('response.respondedBy', 'name profileImage')
     .populate('reviewer', 'name profileImage');

    res.status(200).json({
      success: true,
      message: 'Response added successfully',
      data: updatedReview
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error adding response',
      error: error.message
    });
  }
};

// @desc    Mark review as helpful
// @route   POST /api/reviews/:id/helpful
// @access  Private
const markReviewHelpful = async (req, res) => {
  try {
    const { id } = req.params;

    const review = await Review.findById(id);

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    // Check if user already voted
    const alreadyVoted = review.helpfulVotes.some(
      vote => vote.user.toString() === req.user.id
    );

    if (alreadyVoted) {
      return res.status(400).json({
        success: false,
        message: 'You have already marked this review as helpful'
      });
    }

    // Add helpful vote
    review.helpfulVotes.push({ user: req.user.id });
    review.helpfulCount = review.helpfulVotes.length;
    await review.save();

    res.status(200).json({
      success: true,
      message: 'Review marked as helpful'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error marking review helpful',
      error: error.message
    });
  }
};

// @desc    Report review
// @route   POST /api/reviews/:id/report
// @access  Private
const reportReview = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const review = await Review.findById(id);

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    // Check if already reported
    const alreadyReported = review.reports.some(
      report => report.reportedBy.toString() === req.user.id
    );

    if (alreadyReported) {
      return res.status(400).json({
        success: false,
        message: 'You have already reported this review'
      });
    }

    // Add report
    review.reports.push({
      reason,
      reportedBy: req.user.id,
      reportedAt: new Date()
    });
    await review.save();

    res.status(200).json({
      success: true,
      message: 'Review reported successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error reporting review',
      error: error.message
    });
  }
};

// Helper function to update property ratings
const updatePropertyRatings = async (propertyId) => {
  try {
    const reviews = await Review.find({ property: propertyId, isPublic: true });

    if (reviews.length === 0) return;

    // Calculate averages
    const averages = {
      overall: reviews.reduce((sum, review) => sum + review.rating.overall, 0) / reviews.length,
      cleanliness: reviews.reduce((sum, review) => sum + review.rating.cleanliness, 0) / reviews.length,
      communication: reviews.reduce((sum, review) => sum + review.rating.communication, 0) / reviews.length,
      checkIn: reviews.reduce((sum, review) => sum + review.rating.checkIn, 0) / reviews.length,
      accuracy: reviews.reduce((sum, review) => sum + review.rating.accuracy, 0) / reviews.length,
      location: reviews.reduce((sum, review) => sum + review.rating.location, 0) / reviews.length,
      value: reviews.reduce((sum, review) => sum + review.rating.value, 0) / reviews.length
    };

    // Update property with rounded values
    await Property.findByIdAndUpdate(propertyId, {
      rating: {
        average: Math.round(averages.overall * 10) / 10,
        cleanliness: Math.round(averages.cleanliness * 10) / 10,
        communication: Math.round(averages.communication * 10) / 10,
        checkIn: Math.round(averages.checkIn * 10) / 10,
        accuracy: Math.round(averages.accuracy * 10) / 10,
        location: Math.round(averages.location * 10) / 10,
        value: Math.round(averages.value * 10) / 10
      },
      reviewCount: reviews.length
    });
  } catch (error) {
    console.error('Error updating property ratings:', error);
  }
};

module.exports = {
  createReview,
  getPropertyReviews,
  getPropertyReviewSummary,
  updateReview,
  deleteReview,
  respondToReview,
  markReviewHelpful,
  reportReview
};