const express = require('express');
const router = express.Router();
const listingController = require('../controllers/listing.controller');
const { auth, optionalAuth } = require('../middlewares/auth.middleware');
const { validateListing, validateListingUpdate } = require('../validations/listing.validation');
const AuthorizationMiddleware = require('../middlewares/authorization.middleware');

// Public routes (with optional authentication)
router.get('/', listingController.getListings);
router.get('/search', listingController.searchListings);
router.get('/map', listingController.getMapProperties); // Dedicated map viewport search
router.get('/featured', listingController.getFeaturedListings);
router.get('/sponsored', listingController.getSponseredListings);
router.get('/categories', listingController.getListingCategories);
router.get('/locations', listingController.getPopularLocations);

// Add this before any dynamic :id routes
router.get('/my-listings', auth, listingController.getMyListings);

// Public parameterized routes - Place these before auth middleware
router.get('/:id', optionalAuth, listingController.getListing);
router.get('/:id/similar', listingController.getSimilarListings);
router.get('/:id/reviews', listingController.getListingReviews);
router.get('/:id/rating', listingController.getListingRating);

// Protected routes (require authentication)
router.use(auth);



// Listing CRUD operations - Place specific routes before parameterized routes
router.post('/', validateListing, listingController.createListing);
router.get('/wishlist', listingController.getWishlistedListings);
router.get('/stats/overview', listingController.getListingStats);
router.get('/stats/revenue', listingController.getListingRevenue);
router.get('/stats/views', listingController.getListingViews);
router.get('/host/dashboard', listingController.getHostDashboard);
router.get('/host/performance', listingController.getHostPerformance);

// Protected parameterized routes
router.put('/:id', AuthorizationMiddleware.isPropertyHost, validateListingUpdate, listingController.updateListing);
router.delete('/:id', AuthorizationMiddleware.isPropertyHost, listingController.deleteListing);

// Listing media management
router.post('/:id/photos', AuthorizationMiddleware.isPropertyHost, listingController.uploadPhotos);
router.delete('/:id/photos/:photoId', AuthorizationMiddleware.isPropertyHost, listingController.deletePhoto);
router.patch('/:id/photos/:photoId/primary', AuthorizationMiddleware.isPropertyHost, listingController.setPrimaryPhoto);

// Listing pricing
router.put('/:id/pricing', AuthorizationMiddleware.isPropertyHost, listingController.updatePricing);

// Listing status and visibility
router.patch('/:id/status', AuthorizationMiddleware.isPropertyHost, listingController.updateListingStatus);
router.patch('/:id/visibility', AuthorizationMiddleware.isPropertyHost, listingController.updateListingVisibility);
router.post('/:id/publish', AuthorizationMiddleware.isPropertyHost, listingController.publishListing);
router.post('/:id/publish-approved', AuthorizationMiddleware.isPropertyHost, listingController.publishApprovedListing);
router.post('/:id/unpublish', AuthorizationMiddleware.isPropertyHost, listingController.unpublishListing);

// Wishlist integration
router.post('/:id/wishlist', listingController.addToWishlist);
router.delete('/:id/wishlist', listingController.removeFromWishlist);

// Admin routes (admin only)
router.get('/admin/pending', listingController.getPendingListings);
router.patch('/admin/:id/approve', listingController.approveListing);
router.patch('/admin/:id/reject', listingController.rejectListing);
router.patch('/admin/:id/feature', listingController.featureListing);

module.exports = router;
