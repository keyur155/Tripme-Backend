const Payout = require('../models/Payout');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Notification = require('../models/Notification');
const PaymentService = require('../services/payment.service');

// @desc    Get host's payout history
// @route   GET /api/payouts/host
// @access  Private (Host only)
const getHostPayouts = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;

    // Verify user is a host
    if (req.user.role !== 'host' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only hosts can access this endpoint'
      });
    }

    const query = { host: req.user.id };
    if (status) {
      query.status = status;
    }

    const payouts = await Payout.find(query)
      .populate('payment', 'amount currency')
      .populate('booking', 'totalAmount currency checkIn checkOut')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Payout.countDocuments(query);

    // Get payout statistics
    const payoutStats = await PaymentService.getHostPayoutStats(req.user.id);

    res.status(200).json({
      success: true,
      data: {
        payouts,
        payoutStats,
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
      message: 'Error fetching host payouts',
      error: error.message
    });
  }
};

// @desc    Get payout by ID
// @route   GET /api/payouts/:id
// @access  Private
const getPayoutById = async (req, res) => {
  try {
    const { id } = req.params;

    const payout = await Payout.findById(id)
      .populate('host', 'name email')
      .populate('payment', 'amount currency')
      .populate('booking', 'totalAmount currency checkIn checkOut')
      .populate('manualPayout.processedBy', 'name');

    if (!payout) {
      return res.status(404).json({
        success: false,
        message: 'Payout not found'
      });
    }

    // Check authorization
    if (payout.host.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this payout'
      });
    }

    res.status(200).json({
      success: true,
      data: { payout }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching payout',
      error: error.message
    });
  }
};

// @desc    Update payout method (host)
// @route   PUT /api/payouts/:id/method
// @access  Private (Host only)
const updatePayoutMethod = async (req, res) => {
  try {
    const { id } = req.params;
    const { method, bankDetails, paypalDetails, stripeDetails } = req.body;

    const payout = await Payout.findById(id);
    if (!payout) {
      return res.status(404).json({
        success: false,
        message: 'Payout not found'
      });
    }

    // Check authorization
    if (payout.host.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this payout'
      });
    }

    // Only allow updates for pending payouts
    if (payout.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Can only update method for pending payouts'
      });
    }

    payout.method = method;

    // Update method-specific details
    if (method === 'bank_transfer' && bankDetails) {
      payout.bankDetails = bankDetails;
    } else if (method === 'paypal' && paypalDetails) {
      payout.paypalDetails = paypalDetails;
    } else if (method === 'stripe_connect' && stripeDetails) {
      payout.stripeDetails = stripeDetails;
    }

    await payout.save();

    res.status(200).json({
      success: true,
      message: 'Payout method updated successfully',
      data: { payout }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating payout method',
      error: error.message
    });
  }
};

// @desc    Request payout cancellation (host)
// @route   POST /api/payouts/:id/cancel
// @access  Private (Host only)
const requestPayoutCancellation = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const payout = await Payout.findById(id);
    if (!payout) {
      return res.status(404).json({
        success: false,
        message: 'Payout not found'
      });
    }

    // Check authorization
    if (payout.host.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to cancel this payout'
      });
    }

    // Only allow cancellation for pending payouts
    if (payout.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Can only cancel pending payouts'
      });
    }

    payout.status = 'cancelled';
    payout.notes = reason ? `Cancellation requested: ${reason}` : 'Cancellation requested by host';
    await payout.save();

    // Send notification to admin
    await Notification.create({
      user: payout.host,
      type: 'payout_cancelled',
      title: 'Payout Cancellation Requested',
      message: 'Your payout cancellation request has been submitted and is under review.',
      data: { payoutId: payout._id }
    });

    res.status(200).json({
      success: true,
      message: 'Payout cancellation requested successfully',
      data: { payout }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error requesting payout cancellation',
      error: error.message
    });
  }
};

// @desc    Get all payouts (admin)
// @route   GET /api/payouts/admin/all
// @access  Private (Admin only)
const getAllPayouts = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, hostId, method } = req.query;

    const query = {};
    if (status) {
      query.status = status;
    }
    if (hostId) {
      query.host = hostId;
    }
    if (method) {
      query.method = method;
    }

    const payouts = await Payout.find(query)
      .populate('host', 'name email')
      .populate('payment', 'amount currency')
      .populate('booking', 'totalAmount currency checkIn checkOut')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Payout.countDocuments(query);

    res.status(200).json({
      success: true,
      data: {
        payouts,
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
      message: 'Error fetching all payouts',
      error: error.message
    });
  }
};

// @desc    Get payout statistics (admin)
// @route   GET /api/payouts/admin/stats
// @access  Private (Admin only)
const getPayoutStats = async (req, res) => {
  try {
    const [
      totalPayouts,
      totalAmount,
      pendingPayouts,
      pendingAmount,
      completedPayouts,
      completedAmount,
      failedPayouts,
      failedAmount
    ] = await Promise.all([
      Payout.countDocuments(),
      Payout.aggregate([
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Payout.countDocuments({ status: 'pending' }),
      Payout.aggregate([
        { $match: { status: 'pending' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Payout.countDocuments({ status: 'completed' }),
      Payout.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Payout.countDocuments({ status: 'failed' }),
      Payout.aggregate([
        { $match: { status: 'failed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);

    // Get monthly payout trends
    const monthlyTrends = await Payout.aggregate([
      { $match: { status: 'completed' } },
      {
        $group: {
          _id: { 
            year: { $year: '$processedDate' }, 
            month: { $month: '$processedDate' } 
          },
          count: { $sum: 1 },
          total: { $sum: '$amount' }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: 6 }
    ]);

    // Get payout method distribution
    const methodDistribution = await Payout.aggregate([
      { $match: { status: 'completed' } },
      {
        $group: {
          _id: '$method',
          count: { $sum: 1 },
          total: { $sum: '$amount' }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalPayouts,
        totalAmount: totalAmount[0]?.total || 0,
        pendingPayouts,
        pendingAmount: pendingAmount[0]?.total || 0,
        completedPayouts,
        completedAmount: completedAmount[0]?.total || 0,
        failedPayouts,
        failedAmount: failedAmount[0]?.total || 0,
        monthlyTrends,
        methodDistribution
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching payout statistics',
      error: error.message
    });
  }
};

// @desc    Reverse completed payout (admin)
// @route   POST /api/payouts/:id/reverse
// @access  Private (Admin only)
const reversePayout = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, notes } = req.body;

    const payout = await Payout.findById(id);
    if (!payout) {
      return res.status(404).json({
        success: false,
        message: 'Payout not found'
      });
    }

    // Only allow reversal of completed payouts
    if (payout.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Can only reverse completed payouts'
      });
    }

    payout.status = 'reversed';
    payout.reversal = {
      reason,
      reversedAt: new Date(),
      reversedBy: req.user.id,
      notes
    };
    await payout.save();

    // Send notification to host
    await Notification.create({
      user: payout.host,
      type: 'payout_reversed',
      title: 'Payout Reversed',
      message: `Your payout of ₹${payout.amount} has been reversed. Reason: ${reason}`,
      data: { payoutId: payout._id, amount: payout.amount, reason }
    });

    res.status(200).json({
      success: true,
      message: 'Payout reversed successfully',
      data: { payout }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error reversing payout',
      error: error.message
    });
  }
};

// @desc    Confirm payout done from Razorpay dashboard (admin)
// @route   POST /api/payouts/admin/:id/confirm
// @access  Private (Admin only)
//
// Flow:
//   1. Admin pays the host via Razorpay dashboard (manually)
//   2. Razorpay generates a Payout ID (e.g. pout_XXXXXX) or UTR number
//   3. Admin opens this endpoint, enters that reference to mark the payout DONE
const confirmPayoutDone = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      razorpayPayoutId,   // e.g. "pout_QAB1234XYZ"  (from Razorpay dashboard)
      utrNumber,          // UTR / bank reference for IMPS/NEFT transfers
      transactionId,      // any additional transaction ID
      adminNotes,         // optional notes from admin
      processedDate       // optional override; defaults to now
    } = req.body;

    if (!razorpayPayoutId && !utrNumber && !transactionId) {
      return res.status(400).json({
        success: false,
        message: 'Please provide at least one of: razorpayPayoutId, utrNumber, or transactionId'
      });
    }

    const payout = await Payout.findById(id)
      .populate('host', 'name email');

    if (!payout) {
      return res.status(404).json({
        success: false,
        message: 'Payout not found'
      });
    }

    if (payout.status === 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Payout is already marked as completed',
        data: { payout }
      });
    }

    if (payout.status === 'reversed' || payout.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: `Cannot confirm a payout with status: ${payout.status}`
      });
    }

    // Build the reference string (use razorpay ID if available, fallback to UTR)
    const reference = razorpayPayoutId || utrNumber || transactionId;

    payout.status = 'completed';
    payout.transactionId = transactionId || razorpayPayoutId || payout.transactionId;
    payout.reference = reference;
    payout.processedDate = processedDate ? new Date(processedDate) : new Date();

    // Record who confirmed it and when
    payout.manualPayout = {
      processedBy: req.user._id || req.user.id,
      processedAt: new Date(),
      notes: adminNotes || `Confirmed via Razorpay dashboard. Ref: ${reference}`
    };

    // Store the full Razorpay payout ID in gatewayResponse for audit trail
    payout.gatewayResponse = {
      ...(payout.gatewayResponse || {}),
      razorpayPayoutId,
      utrNumber,
      confirmedBy: req.user._id || req.user.id,
      confirmedAt: new Date().toISOString(),
      source: 'admin_manual_confirmation'
    };

    if (adminNotes) {
      payout.adminNotes = adminNotes;
    }

    await payout.save();

    // Notify the host
    try {
      await Notification.create({
        user: payout.host._id || payout.host,
        type: 'payout_completed',
        title: 'Payout Completed! 🎉',
        message: `Your payout of ₹${payout.amount} has been processed. Reference: ${reference}`,
        data: {
          payoutId: payout._id,
          amount: payout.amount,
          reference,
          processedDate: payout.processedDate
        }
      });
    } catch (notifErr) {
      // Notification failure should not block the confirmation
      console.warn('⚠️ Failed to send payout notification:', notifErr.message);
    }

    res.status(200).json({
      success: true,
      message: `Payout of ₹${payout.amount} confirmed as completed. Reference: ${reference}`,
      data: {
        payout,
        confirmedAt: payout.manualPayout.processedAt,
        reference
      }
    });
  } catch (error) {
    console.error('❌ Error confirming payout:', error);
    res.status(500).json({
      success: false,
      message: 'Error confirming payout',
      error: error.message
    });
  }
};

// @desc    Bulk process payouts (admin)
// @route   POST /api/payouts/admin/bulk-process
// @access  Private (Admin only)
const bulkProcessPayouts = async (req, res) => {
  try {
    const { payoutIds, method, notes } = req.body;

    if (!payoutIds || !Array.isArray(payoutIds) || payoutIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide payout IDs to process'
      });
    }

    const payouts = await Payout.find({ 
      _id: { $in: payoutIds },
      status: 'pending'
    });

    if (payouts.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid pending payouts found'
      });
    }

    // Process each payout
    const processedPayouts = [];
    const errors = [];

    for (const payout of payouts) {
      try {
        const payoutData = {
          method,
          notes: `${notes || 'Bulk processing'}`,
          reference: `BULK_${Date.now()}_${payout._id}`
        };

        await PaymentService.processHostPayout(payout._id, payoutData, req.user);
        processedPayouts.push(payout._id);
      } catch (error) {
        errors.push({
          payoutId: payout._id,
          error: error.message
        });
      }
    }

    res.status(200).json({
      success: true,
      message: `Successfully processed ${processedPayouts.length} payouts`,
      data: {
        processed: processedPayouts,
        errors,
        total: payouts.length
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error processing bulk payouts',
      error: error.message
    });
  }
};

module.exports = {
  getHostPayouts,
  getPayoutById,
  updatePayoutMethod,
  requestPayoutCancellation,
  getAllPayouts,
  getPayoutStats,
  reversePayout,
  confirmPayoutDone,
  bulkProcessPayouts
};
