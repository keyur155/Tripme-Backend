const PopularDestination = require('../models/PopularDestination');

// ─── Public ─────────────────────────────────────────────────────────────────

/**
 * GET /api/popular-destinations
 * Returns all active popular destinations ordered by displayOrder.
 */
exports.getPublicDestinations = async (req, res) => {
    try {
        const destinations = await PopularDestination.find({ isActive: true })
            .sort({ displayOrder: 1, createdAt: -1 });

        res.status(200).json({
            success: true,
            data: { destinations }
        });
    } catch (error) {
        console.error('Error fetching popular destinations:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch popular destinations' });
    }
};

// ─── Admin ───────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/popular-destinations
 * Returns all destinations (active + inactive) for admin management.
 */
exports.getAdminDestinations = async (req, res) => {
    try {
        const destinations = await PopularDestination.find()
            .sort({ displayOrder: 1, createdAt: -1 });

        res.status(200).json({
            success: true,
            data: { destinations }
        });
    } catch (error) {
        console.error('Error fetching admin popular destinations:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch destinations' });
    }
};

/**
 * POST /api/admin/popular-destinations
 * Create a new popular destination.
 */
exports.createDestination = async (req, res) => {
    try {
        const { name, description, image, staysLabel, displayOrder, isActive, searchCity } = req.body;

        if (!name || !image) {
            return res.status(400).json({ success: false, message: 'Name and image are required' });
        }

        const destination = await PopularDestination.create({
            name,
            description,
            image,
            staysLabel,
            displayOrder: displayOrder ?? 0,
            isActive: isActive !== undefined ? isActive : true,
            searchCity: searchCity || name
        });

        res.status(201).json({
            success: true,
            message: 'Popular destination created successfully',
            data: { destination }
        });
    } catch (error) {
        console.error('Error creating popular destination:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to create destination' });
    }
};

/**
 * PUT /api/admin/popular-destinations/:id
 * Update an existing popular destination.
 */
exports.updateDestination = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, image, staysLabel, displayOrder, isActive, searchCity } = req.body;

        const destination = await PopularDestination.findByIdAndUpdate(
            id,
            { name, description, image, staysLabel, displayOrder, isActive, searchCity },
            { new: true, runValidators: true }
        );

        if (!destination) {
            return res.status(404).json({ success: false, message: 'Destination not found' });
        }

        res.status(200).json({
            success: true,
            message: 'Destination updated successfully',
            data: { destination }
        });
    } catch (error) {
        console.error('Error updating popular destination:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to update destination' });
    }
};

/**
 * DELETE /api/admin/popular-destinations/:id
 * Delete a popular destination.
 */
exports.deleteDestination = async (req, res) => {
    try {
        const { id } = req.params;

        const destination = await PopularDestination.findByIdAndDelete(id);

        if (!destination) {
            return res.status(404).json({ success: false, message: 'Destination not found' });
        }

        res.status(200).json({
            success: true,
            message: 'Destination deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting popular destination:', error);
        res.status(500).json({ success: false, message: 'Failed to delete destination' });
    }
};

/**
 * PATCH /api/admin/popular-destinations/:id/toggle
 * Toggle the isActive status of a destination.
 */
exports.toggleActive = async (req, res) => {
    try {
        const { id } = req.params;
        const destination = await PopularDestination.findById(id);

        if (!destination) {
            return res.status(404).json({ success: false, message: 'Destination not found' });
        }

        destination.isActive = !destination.isActive;
        await destination.save();

        res.status(200).json({
            success: true,
            message: `Destination ${destination.isActive ? 'activated' : 'deactivated'} successfully`,
            data: { destination }
        });
    } catch (error) {
        console.error('Error toggling popular destination:', error);
        res.status(500).json({ success: false, message: 'Failed to toggle destination' });
    }
};

/**
 * PATCH /api/admin/popular-destinations/reorder
 * Bulk update displayOrder for all destinations.
 * Body: { destinations: [{ id, displayOrder }] }
 */
exports.reorderDestinations = async (req, res) => {
    try {
        const { destinations } = req.body;

        if (!Array.isArray(destinations)) {
            return res.status(400).json({ success: false, message: 'destinations array is required' });
        }

        const updates = destinations.map(({ id, displayOrder }) =>
            PopularDestination.findByIdAndUpdate(id, { displayOrder }, { new: true })
        );

        await Promise.all(updates);

        res.status(200).json({
            success: true,
            message: 'Order updated successfully'
        });
    } catch (error) {
        console.error('Error reordering popular destinations:', error);
        res.status(500).json({ success: false, message: 'Failed to reorder destinations' });
    }
};
