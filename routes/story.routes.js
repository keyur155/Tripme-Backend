const express = require('express');
const router = express.Router();
const storyController = require('../controllers/story.controller');
const { auth } = require('../middlewares/auth.middleware');
const { generalRateLimit } = require('../middlewares/rateLimit.middleware');
const AuthorizationMiddleware = require('../middlewares/authorization.middleware');

// Public routes
router.get('/', storyController.getAllStories);
router.get('/search', storyController.searchStories);
router.get('/featured', storyController.getFeaturedStories);
router.get('/categories', storyController.getCategories);
router.get('/user/:userId', storyController.getUserStories);
router.get('/story/:id', storyController.getStoryById);
router.get('/:slug', storyController.getStoryBySlug);

// Protected routes (require authentication)
router.use(auth);

// Story management (create, update, delete)
router.post('/', generalRateLimit, storyController.createStory);
router.put('/:id', AuthorizationMiddleware.ownsResource('story'), generalRateLimit, storyController.updateStory);
router.delete('/:id', AuthorizationMiddleware.ownsResource('story'), generalRateLimit, storyController.deleteStory);

// Engagement (like, comment)
router.post('/:id/like', generalRateLimit, storyController.toggleLike);
router.post('/:id/comments', generalRateLimit, storyController.addComment);

module.exports = router; 