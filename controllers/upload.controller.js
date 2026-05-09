const cloudinary = require('../config/cloudinary');
const { Readable } = require('stream');

// @desc    Upload single image
// @route   POST /api/upload/image
// @access  Private
const uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    // Validate file type
    const allowedTypes = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/avif',
      'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'
    ];
    if (!allowedTypes.includes(req.file.mimetype)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file type. Only JPEG, PNG, WebP, AVIF images and MP4, MOV, AVI, WEBM videos are allowed.'
      });
    }

    const isVideo = req.file.mimetype.startsWith('video/');
    const resourceType = isVideo ? 'video' : 'image';

    // Set file size limit: 100MB for video, 5MB for image
    const maxSize = isVideo ? 100 * 1024 * 1024 : 5 * 1024 * 1024;
    if (req.file.size > maxSize) {
      return res.status(400).json({
        success: false,
        message: `File size too large. Maximum size is ${isVideo ? '100MB' : '5MB'}.`
      });
    }

    // Create a readable stream from the buffer
    const stream = Readable.from(req.file.buffer);

    // Upload to Cloudinary
    const uploadPromise = new Promise((resolve, reject) => {
      const uploadOptions = {
        folder: 'tripme/services',
        resource_type: resourceType
      };
      if (!isVideo) {
        uploadOptions.transformation = [
          { width: 1200, height: 800, crop: 'fill', quality: 'auto' },
          { fetch_format: 'auto' }
        ];
      }
      const uploadStream = cloudinary.uploader.upload_stream(
        uploadOptions,
        (error, result) => {
          if (error) {
            reject(error);
          } else {
            resolve(result);
          }
        }
      );
      stream.pipe(uploadStream);
    });

    const result = await uploadPromise;

    res.status(200).json({
      success: true,
      message: isVideo ? 'Video uploaded successfully' : 'Image uploaded successfully',
      data: {
        url: result.secure_url,
        publicId: result.public_id,
        width: result.width,
        height: result.height,
        format: result.format,
        size: result.bytes
      }
    });

  } catch (error) {
    const { logger } = require('../config/logger');
    logger.error('Upload error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error uploading media'
    });
  }
};

// @desc    Upload multiple images
// @route   POST /api/upload/images
// @access  Private
const uploadMultipleImages = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No files uploaded'
      });
    }

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/avif'];
    const maxSize = 5 * 1024 * 1024; // 5MB

    // Validate all files
    for (const file of req.files) {
      if (!allowedTypes.includes(file.mimetype)) {
        return res.status(400).json({
          success: false,
          message: `Invalid file type for ${file.originalname}. Only JPEG, PNG, WebP, and AVIF images are allowed.`
        });
      }

      if (file.size > maxSize) {
        return res.status(400).json({
          success: false,
          message: `File ${file.originalname} is too large. Maximum size is 5MB.`
        });
      }
    }

    const uploadPromises = req.files.map(file => {
      return new Promise((resolve, reject) => {
        const stream = Readable.from(file.buffer);
        
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: 'tripme/properties',
            resource_type: 'image',
            transformation: [
              { width: 1200, height: 800, crop: 'fill', quality: 'auto' },
              { fetch_format: 'auto' }
            ]
          },
          (error, result) => {
            if (error) {
              reject(error);
            } else {
              resolve({
                originalName: file.originalname,
                url: result.secure_url,
                publicId: result.public_id,
                width: result.width,
                height: result.height,
                format: result.format,
                size: result.bytes
              });
            }
          }
        );

        stream.pipe(uploadStream);
      });
    });

    const results = await Promise.all(uploadPromises);

    res.status(200).json({
      success: true,
      message: `${results.length} images uploaded successfully`,
      data: results
    });

  } catch (error) {
    const { logger } = require('../config/logger');
    logger.error('Multiple upload error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error uploading images'
    });
  }
};

// @desc    Delete image from Cloudinary
// @route   DELETE /api/upload/image/:publicId
// @access  Private
const deleteImage = async (req, res) => {
  try {
    const { publicId } = req.params;

    if (!publicId) {
      return res.status(400).json({
        success: false,
        message: 'Public ID is required'
      });
    }

    // Verify the image belongs to the requesting user by checking if it's
    // referenced in one of their listings or services
    const Listing = require('../models/Listing');
    const Service = require('../models/Service');

    const userOwnsImage = await Listing.findOne({
      host: req.user._id,
      $or: [
        { 'images.publicId': publicId },
        { 'photos.publicId': publicId }
      ]
    }) || await Service.findOne({
      user: req.user._id,
      $or: [
        { 'images.publicId': publicId },
        { 'photos.publicId': publicId },
        { 'media.publicId': publicId }
      ]
    });

    if (!userOwnsImage && !req.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete images that belong to your own listings or services'
      });
    }

    const result = await cloudinary.uploader.destroy(publicId);

    if (result.result === 'ok') {
      res.status(200).json({
        success: true,
        message: 'Image deleted successfully'
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Failed to delete image'
      });
    }

  } catch (error) {
    const { logger } = require('../config/logger');
    logger.error('Delete image error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error deleting image'
    });
  }
};

module.exports = {
  uploadImage,
  uploadMultipleImages,
  deleteImage
}; 