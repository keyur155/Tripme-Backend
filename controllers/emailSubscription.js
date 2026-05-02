const EmailSubscription = require('../models/EmailSubscription');
const User = require('../models/User');
const { sendEmail } = require('../utils/sendEmail');
const { validationResult } = require('express-validator');


exports.subscribeEmail = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation errors',
        errors: errors.array()
      });
    }

    const { email, name, userId, source = 'footer' } = req.body;

    // Check if already subscribed
    const existingSubscription = await EmailSubscription.findOne({ email });
    
    if (existingSubscription) {
      if (existingSubscription.status === 'active') {
        return res.status(400).json({
          success: false,
          message: 'Email is already subscribed'
        });
      } else {
        // Reactivate subscription
        existingSubscription.status = 'active';
        existingSubscription.subscribedAt = new Date();
        existingSubscription.unsubscribedAt = null;
        await existingSubscription.save();
      }
    } else {
      // Create new subscription
      const subscription = new EmailSubscription({
        email,
        name: name || email.split('@')[0], // Use email prefix as default name
        userId: userId || null,
        source
      });
      await subscription.save();
    }

    // Get user details if userId provided
    let userDetails = null;
    if (userId) {
      userDetails = await User.findById(userId).select('name email');
    }

    // Send notification email to support
    await sendNotificationEmail(email, name, userDetails);

    res.status(201).json({
      success: true,
      message: 'Successfully subscribed to email list'
    });

  } catch (error) {
    console.error('Email subscription error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Send notification email to support team
const sendNotificationEmail = async (subscriberEmail, subscriberName, userDetails) => {
  try {
   

     await sendEmail(subscriberEmail, 'welcome', {
      userName: subscriberName || subscriberEmail.split('@')[0],
      link: `${(process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim()}/verify-email`
    });

    // await sendEmail('19bet1030@gmail.com', emailContent);
    await sendEmail('19bet1030@gmail.com', 'emailSubscription', {
  subscriberEmail,
  subscriberName,
  userDetails
});
    
  } catch (error) {
    console.error('Error sending notification email:', error);
    // Don't throw error here as subscription should still succeed
  }
};

// Get all subscriptions (admin only)
exports.getAllSubscriptions = async (req, res) => {
  try {
    const { page = 1, limit = 10, status = 'active' } = req.query;
    
    const subscriptions = await EmailSubscription.find({ status })
      .populate('userId', 'name email')
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ subscribedAt: -1 });

    const total = await EmailSubscription.countDocuments({ status });

    res.status(200).json({
      success: true,
      data: subscriptions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Error fetching subscriptions:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Unsubscribe email
exports.unsubscribeEmail = async (req, res) => {
  try {
    const { email } = req.body;

    const subscription = await EmailSubscription.findOne({ email });
    
    if (!subscription) {
      return res.status(404).json({
        success: false,
        message: 'Email not found in subscription list'
      });
    }

    subscription.status = 'unsubscribed';
    subscription.unsubscribedAt = new Date();
    await subscription.save();

    res.status(200).json({
      success: true,
      message: 'Successfully unsubscribed'
    });

  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};