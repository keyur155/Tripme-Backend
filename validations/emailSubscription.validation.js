const { body } = require('express-validator');

exports.validateEmailSubscription = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  
  body('name')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Name cannot exceed 100 characters'),
  
  body('userId')
    .optional()
    .isMongoId()
    .withMessage('Invalid user ID format'),
  
  body('source')
    .optional()
    .isIn(['footer', 'landing_page', 'popup', 'manual'])
    .withMessage('Invalid subscription source')
];

exports.validateEmailUnsubscribe = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address')
];