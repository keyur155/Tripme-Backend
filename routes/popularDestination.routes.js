const express = require('express');
const router = express.Router();
const controller = require('../controllers/popularDestination.controller');

// ─── Public route only ────────────────────────────────────────────────────────
// GET /api/popular-destinations  →  returns active destinations for the user-facing homepage
router.get('/', controller.getPublicDestinations);

module.exports = router;
