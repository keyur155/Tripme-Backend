const User = require('../models/User');
const Admin = require('../models/Admin');
const VerificationToken = require('../models/VerificationToken');
const Session = require('../models/Session');
const { generateToken } = require('../utils/generateToken');
const { sendEmail, sendWelcomeEmail, sendPasswordResetEmail } = require('../utils/sendEmail');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
// Google OAuth client
const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client();

// Initialize the client with credentials
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  googleClient.setCredentials({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET
  });
}

// FRONTEND_URL may be comma-separated (e.g. on Railway where multiple origins are listed).
// Always use the FIRST URL for links in emails.
const getFrontendUrl = () =>
  (process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map(u => u.trim())
    .filter(Boolean)[0] || 'http://localhost:3000';

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
const registerUser = async (req, res) => {
  try {
    const { name, email, password, phone, role = 'guest' } = req.body;

    // Check if user already exists
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(409).json({
        success: false,
        message: 'User already exists with this email',
        errors: [
          {
            field: 'email',
            message: 'An account already exists with this email address'
          }
        ]
      });
    }

    // Create user
    const user = await User.create({
      name,
      email,
      password,
      phone,
      role
    });

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    await VerificationToken.create({
      user: user._id,
      token: verificationToken,
      type: 'email',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
    });

    // Send verification email (non-blocking with timeout to avoid slowing registration on cold deploys)
    const frontendUrl = getFrontendUrl();
    const verificationUrl = `${frontendUrl}/auth/verify-email?token=${verificationToken}`;
    console.log('Sending welcome email to:', user.email);
    console.log('Verification URL:', verificationUrl);

    const sendEmailWithTimeout = async () => {
      const timeoutMs = 5000;
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Email send timeout')), timeoutMs)
      );
      return Promise.race([sendWelcomeEmail(user.email, user.name, verificationUrl), timeout]);
    };

    sendEmailWithTimeout()
      .then((emailResult) => console.log('Welcome email sent (async):', emailResult))
      .catch((emailError) => console.warn('Welcome email send skipped/failed (non-blocking):', emailError.message));
    
    // User starts as unverified - they must verify their email
    // user.isVerified = false; // This is the default value

    // Generate JWT token
    const token = user.generateAuthToken();

    res.status(201).json({
      success: true,
      message: 'User registered successfully. Please check your email to verify your account before logging in.',
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          isVerified: user.isVerified
        },
        token
      }
    });
  } catch (error) {
    // Handle Mongoose validation errors gracefully
    if (error.name === 'ValidationError') {
      const errors = Object.keys(error.errors || {}).map((field) => ({
        field,
        message: error.errors[field].message
      }));

      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors
      });
    }

    // Handle unique email race condition (just in case)
    if (error.code === 11000 && error.keyPattern?.email) {
      return res.status(409).json({
        success: false,
        message: 'User already exists with this email',
        errors: [{ field: 'email', message: 'An account already exists with this email address' }]
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error registering user',
      error: error.message
    });
  }
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Check if user exists
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
       console.log("❌ Email not found");
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Check if password is correct
    const isPasswordCorrect = await user.comparePassword(password);
    if (!isPasswordCorrect) {
      console.log("invalid passwoerd");
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Check if account is active
    if (user.accountStatus !== 'active') {
      let message = 'Account is not active';
      if (user.accountStatus === 'suspended') {
        message = 'Account is suspended. Please contact support.';
      } else if (user.accountStatus === 'banned') {
        message = 'Account is banned. Access denied.';
      } else if (user.accountStatus === 'deactivated') {
        message = 'Account is deactivated. Please contact support to reactivate.';
      }
      console.log("❌ Account blocked:", user.accountStatus);
      return res.status(401).json({
        success: false,
        message
      });
    }

    // Email verification is NOT enforced at login.
    // isVerified is returned in the response so the frontend can prompt the user to verify.

    // Generate JWT token
    const token = user.generateAuthToken();

    // Create session
    await Session.create({
      user: user._id,
      token,
      userAgent: req.headers['user-agent'] || 'unknown',
      ipAddress: req.ip || req.connection?.remoteAddress || 'unknown',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
    });

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          isVerified: user.isVerified,
          profileImage: user.profileImage
        },
        token
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error logging in',
      error: error.message
    });
  }
};

// @desc    Verify email
// @route   GET /api/auth/verify-email/:token
// @access  Public
const verifyEmail = async (req, res) => {
  try {
    const { token } = req.params;

    const verificationToken = await VerificationToken.findOne({
      token,
      type: 'email',
      expiresAt: { $gt: new Date() }
    });

    if (!verificationToken) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired verification token'
      });
    }

    // Update user
    await User.findByIdAndUpdate(verificationToken.user, {
      isVerified: true
    });

    // Delete verification token
    await VerificationToken.findByIdAndDelete(verificationToken._id);

    res.status(200).json({
      success: true,
      message: 'Email verified successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error verifying email',
      error: error.message
    });
  }
};

// @desc    Forgot password
// @route   POST /api/auth/forgot-password
// @access  Public
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    await VerificationToken.create({
      user: user._id,
      token: resetToken,
      type: 'password_reset',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000) // 1 hour
    });

    // Send reset email
    // Use frontend URL for password reset - the frontend will handle the API call
    const frontendUrl = getFrontendUrl();
    const resetUrl = `${frontendUrl}/auth/reset-password?token=${resetToken}`;
    await sendPasswordResetEmail(user.email, user.name, resetUrl);

    res.status(200).json({
      success: true,
      message: 'Password reset email sent'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error sending password reset email',
      error: error.message
    });
  }
};

// @desc    Reset password
// @route   POST /api/auth/reset-password/:token
// @access  Public
const resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    const verificationToken = await VerificationToken.findOne({
      token,
      type: 'password_reset',
      expiresAt: { $gt: new Date() }
    });

    if (!verificationToken) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset token'
      });
    }

    // Update user password
    const user = await User.findById(verificationToken.user);
    user.password = password;
    await user.save();

    // Delete verification token
    await VerificationToken.findByIdAndDelete(verificationToken._id);

    res.status(200).json({
      success: true,
      message: 'Password reset successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error resetting password',
      error: error.message
    });
  }
};

// @desc    Logout user
// @route   POST /api/auth/logout
// @access  Private
const logoutUser = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (token) {
      // Delete session
      await Session.findOneAndDelete({ token });
    }

    res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error logging out',
      error: error.message
    });
  }
};

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
const getCurrentUser = async (req, res) => {
  try {
    // If req.user is an admin, return null for user (admins don't have regular user profiles)
    if (req.isAdmin) {
      return res.status(200).json({
        success: true,
        data: { user: null }
      });
    }

    const user = await User.findById(req.user.id)
      .select('-password')
      .populate('savedListings', 'title images pricing');

    res.status(200).json({
      success: true,
      data: { user }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching user data',
      error: error.message
    });
  }
};

// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
const updateProfile = async (req, res) => {
  try {
    const { name, phone, bio, languages, location } = req.body;

    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        name,
        phone,
        bio,
        languages,
        location
      },
      { new: true, runValidators: true }
    ).select('-password');

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: { user }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating profile',
      error: error.message
    });
  }
};

// @desc    Change password
// @route   PUT /api/auth/change-password
// @access  Private
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user.id).select('+password');

    // Check current password
    const isPasswordCorrect = await user.comparePassword(currentPassword);
    if (!isPasswordCorrect) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error changing password',
      error: error.message
    });
  }
};


// Helper: call Google userinfo endpoint with the user's access token directly.
// We do NOT use googleClient.request() here because that method attaches its own
// server-side OAuth2 credentials and overrides the Bearer token, causing a 401.
const fetchGoogleUserInfo = (accessToken) =>
  new Promise((resolve, reject) => {
    const https = require('https');
    const options = {
      hostname: 'www.googleapis.com',
      path: '/oauth2/v2/userinfo',
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { reject(new Error('Failed to parse Google userinfo response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });

// @desc    Social login (Google/Facebook)
// @route   POST /api/auth/social-login
// @access  Public
const socialLogin = async (req, res) => {
  try {
    const { provider, token } = req.body;
    let user = null;

    if (provider === 'google') {
      try {
        console.log('Attempting to verify Google token...');
        console.log('Token length:', token ? token.length : 0);
        console.log('Token preview:', token ? token.substring(0, 20) + '...' : 'No token');
        
        // Call Google userinfo directly with the user's access token
        const userInfoResponse = await fetchGoogleUserInfo(token);

        console.log('Google API response status:', userInfoResponse.status);
        
        if (!userInfoResponse.ok) {
          const errorText = await userInfoResponse.text();
          console.error('Google API error response:', errorText);
          return res.status(401).json({
            success: false,
            message: 'Invalid Google access token',
            debug: process.env.NODE_ENV === 'development' ? errorText : undefined
          });
        }
        
        const userInfo = await userInfoResponse.json();
        console.log('Google API user info received:', {
          hasEmail: !!userInfo.email,
          hasName: !!userInfo.name,
          hasPicture: !!userInfo.picture,
          hasId: !!userInfo.id
        });
        
        const { email, name, picture, id: googleId } = userInfo;

        // Check if user already exists
        user = await User.findOne({ email });
        
        if (!user) {
          // Create new user with a password that meets validation requirements
          const generateSecurePassword = () => {
            const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            const lowercase = 'abcdefghijklmnopqrstuvwxyz';
            const numbers = '0123456789';
            const special = '!@#$%^&*()';
            
            let password = '';
            password += uppercase[Math.floor(Math.random() * uppercase.length)]; // 1 uppercase
            password += lowercase[Math.floor(Math.random() * lowercase.length)]; // 1 lowercase
            password += numbers[Math.floor(Math.random() * numbers.length)]; // 1 number
            password += special[Math.floor(Math.random() * special.length)]; // 1 special
            
            // Fill the rest with random characters to meet 12 character minimum
            const allChars = uppercase + lowercase + numbers + special;
            for (let i = 4; i < 12; i++) {
              password += allChars[Math.floor(Math.random() * allChars.length)];
            }
            
            // Shuffle the password
            return password.split('').sort(() => Math.random() - 0.5).join('');
          };
          
          const generatedPassword = generateSecurePassword();
          console.log('Generated secure password for Google user:', generatedPassword.substring(0, 8) + '...');
          
          user = await User.create({
            name: name || 'Google User',
            email: email,
            profileImage: picture || 'default.jpg',
            isVerified: true,
            password: generatedPassword,
            'socialLogins.googleId': googleId,
            role: 'guest'
          });
          
          console.log('Google user created successfully:', user.email);
        } else {
          // Update existing user's Google ID if not set
          if (!user.socialLogins?.googleId) {
            user.socialLogins = user.socialLogins || {};
            user.socialLogins.googleId = googleId;
            await user.save();
          }
        }
      } catch (googleError) {
        console.error('Google API error details:', {
          message: googleError.message,
          stack: googleError.stack,
          name: googleError.name
        });
        
        // Check if it's a network error
        if (googleError.code === 'ENOTFOUND' || googleError.code === 'ECONNREFUSED') {
          return res.status(500).json({
            success: false,
            message: 'Network error: Unable to reach Google API. Please check your internet connection.'
          });
        }
        
        // Check if it's a fetch error
        if (googleError.name === 'TypeError' && googleError.message.includes('fetch')) {
          return res.status(500).json({
            success: false,
            message: 'Server error: Fetch API not available. Please contact support.'
          });
        }
        
        return res.status(401).json({
          success: false,
          message: 'Failed to verify Google token. Please try again.',
          debug: process.env.NODE_ENV === 'development' ? googleError.message : undefined
        });
      }
    } else {
      return res.status(400).json({ 
        success: false, 
        message: 'Only Google login is supported.' 
      });
    }

    if (!user) {
      return res.status(400).json({ 
        success: false, 
        message: 'Google login failed.' 
      });
    }

    // Check if account is active
    if (user.accountStatus !== 'active') {
      return res.status(401).json({
        success: false,
        message: 'Account is suspended or deactivated'
      });
    }

    // Email verification is NOT enforced at login — users can log in with unverified emails.
    // The isVerified flag is returned in the response so the frontend/profile can prompt verification.

    // Generate JWT token
    const jwtToken = user.generateAuthToken();

    // Create session
    await Session.create({
      user: user._id,
      token: jwtToken,
      userAgent: req.headers['user-agent'] || 'unknown',
      ipAddress: req.ip || req.connection?.remoteAddress || 'unknown',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    res.status(200).json({
      success: true,
      message: 'Google login successful',
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          isVerified: user.isVerified,
          profileImage: user.profileImage
        },
        token: jwtToken
      }
    });
  } catch (error) {
    console.error('Social login error:', error);
    res.status(500).json({
      success: false,
      message: 'Error with Google login',
      error: error.message
    });
  }
};

// @desc    Resend verification email
// @route   POST /api/auth/resend-verification
// @access  Public
const resendVerificationEmail = async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.isVerified) {
      return res.status(400).json({
        success: false,
        message: 'Email is already verified'
      });
    }

    // Delete existing verification token
    await VerificationToken.findOneAndDelete({
      user: user._id,
      type: 'email'
    });

    // Generate new verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    await VerificationToken.create({
      user: user._id,
      token: verificationToken,
      type: 'email',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
    });

    // Send verification email
    // Use frontend URL for verification - the frontend will handle the API call
    const frontendUrl = getFrontendUrl();
    const verificationUrl = `${frontendUrl}/auth/verify-email?token=${verificationToken}`;
    await sendWelcomeEmail(user.email, user.name, verificationUrl);

    res.status(200).json({
      success: true,
      message: 'Verification email sent successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error sending verification email',
      error: error.message
    });
  }
};

// @desc    Logout all devices
// @route   POST /api/auth/logout-all
// @access  Private
const logoutAllDevices = async (req, res) => {
  try {
    // Delete all sessions for the user
    await Session.deleteMany({ user: req.user.id });

    res.status(200).json({
      success: true,
      message: 'Logged out from all devices successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error logging out from all devices',
      error: error.message
    });
  }
};

// @desc    Delete account
// @route   DELETE /api/auth/account
// @access  Private
const deleteAccount = async (req, res) => {
  try {
    const { password } = req.body;

    const user = await User.findById(req.user.id).select('+password');

    // Check password
    const isPasswordCorrect = await user.comparePassword(password);
    if (!isPasswordCorrect) {
      return res.status(400).json({
        success: false,
        message: 'Password is incorrect'
      });
    }

    // Delete user sessions
    await Session.deleteMany({ user: req.user.id });

    // Delete user
    await User.findByIdAndDelete(req.user.id);

    res.status(200).json({
      success: true,
      message: 'Account deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting account',
      error: error.message
    });
  }
};

// @desc    Deactivate account
// @route   POST /api/auth/deactivate
// @access  Private
const deactivateAccount = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.id, {
      accountStatus: 'deactivated'
    });

    res.status(200).json({
      success: true,
      message: 'Account deactivated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deactivating account',
      error: error.message
    });
  }
};

// @desc    Reactivate account
// @route   POST /api/auth/reactivate
// @access  Private
const reactivateAccount = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.id, {
      accountStatus: 'active'
    });

    res.status(200).json({
      success: true,
      message: 'Account reactivated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error reactivating account',
      error: error.message
    });
  }
};

// @desc    Enable 2FA
// @route   POST /api/auth/2fa/enable
// @access  Private
const enable2FA = async (req, res) => {
  try {
    // TODO: Implement 2FA logic
    res.status(200).json({
      success: true,
      message: '2FA enabled successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error enabling 2FA',
      error: error.message
    });
  }
};

// @desc    Disable 2FA
// @route   POST /api/auth/2fa/disable
// @access  Private
const disable2FA = async (req, res) => {
  try {
    // TODO: Implement 2FA logic
    res.status(200).json({
      success: true,
      message: '2FA disabled successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error disabling 2FA',
      error: error.message
    });
  }
};

// @desc    Verify 2FA
// @route   POST /api/auth/2fa/verify
// @access  Private
const verify2FA = async (req, res) => {
  try {
    // TODO: Implement 2FA logic
    res.status(200).json({
      success: true,
      message: '2FA verified successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error verifying 2FA',
      error: error.message
    });
  }
};

// @desc    Get active sessions
// @route   GET /api/auth/sessions
// @access  Private
const getActiveSessions = async (req, res) => {
  try {
    const sessions = await Session.find({ user: req.user.id })
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: { sessions }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching sessions',
      error: error.message
    });
  }
};

// @desc    Terminate session
// @route   DELETE /api/auth/sessions/:sessionId
// @access  Private
const terminateSession = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await Session.findOneAndDelete({
      _id: sessionId,
      user: req.user.id
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Session terminated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error terminating session',
      error: error.message
    });
  }
};

// @desc    Validate reset password token
// @route   GET /api/auth/reset-password/:token
// @access  Public
const validateResetToken = async (req, res) => {
  try {
    const { token } = req.params;
    const verificationToken = await VerificationToken.findOne({
      token,
      type: 'password_reset',
      expiresAt: { $gt: new Date() }
    });
    if (!verificationToken) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
    }
    res.status(200).json({ success: true, message: 'Valid token' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error validating token', error: error.message });
  }
};

// @desc    Admin login
// @route   POST /api/admin/login
// @access  Public
const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log("request received admin login");
    // Check if admin exists
    const admin = await Admin.findOne({ email }).select('+password');
    if (!admin) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Check if password is correct
    const isPasswordCorrect = await admin.comparePassword(password);
    if (!isPasswordCorrect) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Check if admin account is active
    if (!admin.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Admin account is suspended or deactivated'
      });
    }

    // Generate JWT token for admin
    const token = jwt.sign(
      { 
        id: admin._id, 
        email: admin.email, 
        role: 'admin',
        name: admin.name
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Create session
    await Session.create({
      user: admin._id,
      token,
      userAgent: req.headers['user-agent'] || 'unknown',
      ipAddress: req.ip || req.connection?.remoteAddress || 'unknown',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
    });

    // Remove password from response
    const adminData = {
      _id: admin._id,
      name: admin.name,
      email: admin.email,
      role: 'admin',
      isActive: admin.isActive,
      lastLogin: admin.lastLogin,
      createdAt: admin.createdAt
    };

    // Update last login
    admin.lastLogin = new Date();
    await admin.save();

    console.log(`✅ Admin login successful: ${admin.email}`);

    res.status(200).json({
      success: true,
      message: 'Admin login successful',
      data: {
        admin: adminData,
        token
      }
    });

  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during admin login'
    });
  }
};

module.exports = {
  registerUser,
  loginUser,
  adminLogin,
  verifyEmail,
  forgotPassword,
  resetPassword,
  logoutUser,
  getCurrentUser,
  updateProfile,
  changePassword,
  socialLogin,
  resendVerificationEmail,
  logoutAllDevices,
  deleteAccount,
  deactivateAccount,
  reactivateAccount,
  enable2FA,
  disable2FA,
  verify2FA,
  getActiveSessions,
  terminateSession,
  validateResetToken
};
