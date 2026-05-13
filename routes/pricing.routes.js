const express = require('express');
const router = express.Router();
const { getPlatformFeeRate, calculatePricing, validateCoupon, calculateFullPrice } = require('../controllers/pricing.controller');

/**
 * @desc    Calculate pricing for property booking
 * @route   POST /api/pricing/calculate
 * @access  Public (for property details page)
 */
router.post('/calculate', calculatePricing);

/**
 * @desc    Get platform fee rate
 * @route   GET /api/pricing/platform-fee-rate
 * @access  Public
 */
router.get('/platform-fee-rate', getPlatformFeeRate);

/**
 * @desc    Validate coupon code
 * @route   POST /api/pricing/validate-coupon
 * @access  Public
 */
router.post('/validate-coupon', validateCoupon);

/**
 * @desc    Calculate full booking price including addon services
 * @route   POST /api/pricing/calculate-full
 * @access  Public (live pricing for booking flow)
 */
router.post('/calculate-full', calculateFullPrice);

module.exports = router;
