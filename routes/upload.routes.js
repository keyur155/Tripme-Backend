const express = require('express');
const router = express.Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { uploadImage, uploadMultipleImages, deleteImage } = require('../controllers/upload.controller');
const { auth } = require('../middlewares/auth.middleware');

// Rate limit uploads: 20 uploads per 15 minutes per user
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many upload attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(uploadLimiter);

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
    files: 10 // Maximum 10 files for multiple upload
  }
});

const uploadMedia = multer({ 
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB for media (images/videos)
    files: 10
  }
});

// @route   POST /api/upload/image
// @desc    Upload single image
// @access  Private
router.post('/image', auth, upload.single('image'), uploadImage);

// @route   POST /api/upload/images
// @desc    Upload multiple images
// @access  Private
router.post('/images', auth, upload.array('images', 10), uploadMultipleImages);

// @route   POST /api/upload/media
// @desc    Upload single image or video
// @access  Private
router.post('/media', auth, uploadMedia.single('media'), uploadImage);

// @route   DELETE /api/upload/image/:publicId
// @desc    Delete image from Cloudinary
// @access  Private
router.delete('/image/:publicId', auth, deleteImage);

module.exports = router; 