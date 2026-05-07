// const express = require('express');
// const router = express.Router();
// const reviewController = require('../controllers/review.controller');
// const { auth } = require('../middlewares/auth.middleware');
// const { validateReview, validateReviewUpdate } = require('../validations/review.validation');
// const AuthorizationMiddleware = require('../middlewares/authorization.middleware');

// // Public routes
// router.get('/properties/:propertyId', reviewController.getPropertyReviews);
// router.get('/services/:serviceId', reviewController.getServiceReviews);
// router.get('/users/:userId', reviewController.getUserReviews);
// router.get('/hosts/:hostId', reviewController.getHostReviews);

// // Protected routes (require authentication)
// router.use(auth);

// // Review CRUD operations
// router.post('/', validateReview, reviewController.createReview);
// router.get('/my-reviews', reviewController.getMyReviews);
// router.get('/:id', AuthorizationMiddleware.canAccessReview, reviewController.getReviewById);
// router.put('/:id', AuthorizationMiddleware.canAccessReview, validateReviewUpdate, reviewController.updateReview);
// router.delete('/:id', AuthorizationMiddleware.canAccessReview, reviewController.deleteReview);

// // Review responses and interactions
// router.post('/:id/response', AuthorizationMiddleware.canAccessReview, reviewController.addHostResponse);
// router.post('/:id/report', reviewController.reportReview);
// router.post('/:id/like', reviewController.likeReview);
// router.delete('/:id/like', reviewController.unlikeReview);

// // Review statistics and analytics
// router.get('/stats/property/:propertyId', reviewController.getPropertyReviewStats);
// router.get('/stats/service/:serviceId', reviewController.getServiceReviewStats);
// router.get('/stats/host/:hostId', reviewController.getHostReviewStats);

// // Review moderation (admin/host only)
// router.get('/pending', reviewController.getPendingReviews);
// router.patch('/:id/moderate', reviewController.moderateReview);

// module.exports = router; 



const express = require('express');
const router = express.Router();
const reviewController = require('../controllers/review.controller');
const { auth } = require('../middlewares/auth.middleware');

// Public routes
router.get('/properties/:propertyId', reviewController.getPropertyReviews);
router.get('/properties/:propertyId/summary', reviewController.getPropertyReviewSummary);

// Protected routes (require authentication)
router.use(auth);

// Review CRUD operations
router.post('/', reviewController.createReview);
router.put('/:id', reviewController.updateReview);
router.delete('/:id', reviewController.deleteReview);

// Review interactions
router.post('/:id/response', reviewController.respondToReview);
router.post('/:id/helpful', reviewController.markReviewHelpful);
router.post('/:id/report', reviewController.reportReview);

module.exports = router;

