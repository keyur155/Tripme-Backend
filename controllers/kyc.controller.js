const User = require('../models/User');
const Host = require('../models/Host');
const KycVerification = require('../models/KycVerification');
const Notification = require('../models/Notification');
const { sendEmail } = require('../utils/sendEmail');

// @desc    Submit KYC documents
// @route   POST /api/kyc/submit
// @access  Private
const submitKYC = async (req, res) => {
  try {
    const {
      identityDocument,
      documentNumber,
      documentImage,
      addressProof,
      addressProofImage,
      selfie
    } = req.body;
    console.log(req.body);
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if KYC is already submitted and pending
    if (user.kyc && user.kyc.status === 'pending') {
      return res.status(400).json({
        success: false,
        message: 'KYC application is already under review'
      });
    }

    // Check if KYC is already verified
    if (user.kyc && user.kyc.status === 'verified') {
      return res.status(400).json({
        success: false,
        message: 'KYC is already verified'
      });
    }

    // Validate required fields - only identity document is required
    if (!identityDocument || !documentNumber || !documentImage) {
      return res.status(400).json({
        success: false,
        message: 'Identity document details are required'
      });
    }

    // Validate document number format based on document type
    const documentValidation = {
      'aadhar-card': { pattern: /^\d{12}$/, message: 'Aadhaar number must be 12 digits' },
      'pan-card': { pattern: /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, message: 'Invalid PAN format (e.g., ABCDE1234F)' },
      'voter-id': { pattern: /^[A-Z]{3}[0-9]{7}$/, message: 'Invalid Voter ID format (e.g., ABC1234567)' },
      'passport': { pattern: /^[A-Z]{1}[0-9]{7}$/, message: 'Invalid Passport format (e.g., A1234567)' },
      'drivers-license': { pattern: /^[A-Z]{2}[0-9]{13}$/, message: 'Invalid DL format (e.g., DL0120110012345)' }
    };

    const validation = documentValidation[identityDocument];
    if (validation && !validation.pattern.test(documentNumber)) {
      return res.status(400).json({
        success: false,
        message: validation.message
      });
    }

    // Create or update KYC verification record
    const kycData = {
      user: user._id,
      identityDocument: {
        type: identityDocument,
        number: documentNumber,
        frontImage: documentImage,
        backImage: documentImage, // Using same image for both sides for now
        expiryDate: null // Can be added later
      },
      status: 'pending'
    };

    // Add address proof if provided (optional)
    if (addressProof && addressProofImage) {
      kycData.addressProof = {
        type: addressProof,
        documentImage: addressProofImage,
        address: user.location || {}
      };
    }

    // Add selfie if provided (optional)
    if (selfie) {
      kycData.selfie = selfie;
    }

    // Update user's KYC status
    user.kyc = {
      identityDocument,
      documentNumber,
      documentImage,
      status: 'pending',
      submittedAt: new Date()
    };

    // Add address proof to user if provided
    if (addressProof && addressProofImage) {
      user.kyc.addressProofType = addressProof;
      user.kyc.addressProofImage = addressProofImage;
    }

    await user.save();

    // Create KYC verification record
    await KycVerification.findOneAndUpdate(
      { user: user._id },
      kycData,
      { upsert: true, new: true }
    );

    // Create notification for admin (if admin notification system exists)
    // This will be handled by the admin dashboard

    res.status(200).json({
      success: true,
      message: 'KYC documents submitted successfully. Please wait for verification.',
      data: { 
        kyc: user.kyc,
        nextStep: 'wait_for_approval'
      }
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: 'Error submitting KYC',
      error: error.message
    });
  }
};

// @desc    Get KYC status
// @route   GET /api/kyc/status
// @access  Private
const getKYCStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const kycVerification = await KycVerification.findOne({ user: user._id });

    res.status(200).json({
      success: true,
      data: {
        kyc: user.kyc,
        verification: kycVerification,
        canBecomeHost: user.kyc?.status === 'verified'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching KYC status',
      error: error.message
    });
  }
};

// @desc    Update KYC documents
// @route   PUT /api/kyc/update
// @access  Private
const updateKYC = async (req, res) => {
  try {
    const {
      identityDocument,
      documentNumber,
      documentImage,
      addressProof,
      addressProofImage,
      selfie
    } = req.body;

    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if KYC is pending (can't update while under review)
    if (user.kyc && user.kyc.status === 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update KYC while application is under review'
      });
    }

    // Check if KYC is verified (can't update verified KYC)
    if (user.kyc && user.kyc.status === 'verified') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update verified KYC'
      });
    }

    // Update user's KYC information
    if (identityDocument) user.kyc.identityDocument = identityDocument;
    if (documentNumber) user.kyc.documentNumber = documentNumber;
    if (documentImage) user.kyc.documentImage = documentImage;
    
    // Reset status to pending for new submission
    user.kyc.status = 'pending';


    await user.save();

    // Update KYC verification record
    const kycData = {
      user: user._id,
      status: 'pending'
    };

    if (identityDocument) kycData.identityDocument = { type: identityDocument };
    if (documentNumber) kycData.identityDocument = { ...kycData.identityDocument, number: documentNumber };
    if (documentImage) kycData.identityDocument = { ...kycData.identityDocument, frontImage: documentImage };
    if (addressProof) kycData.addressProof = { type: addressProof };
    if (addressProofImage) kycData.addressProof = { ...kycData.addressProof, documentImage: addressProofImage };
    if (selfie) kycData.selfie = selfie;

    await KycVerification.findOneAndUpdate(
      { user: user._id },
      kycData,
      { upsert: true, new: true }
    );

    res.status(200).json({
      success: true,
      message: 'KYC documents updated successfully. Please wait for verification.',
      data: { 
        kyc: user.kyc,
        nextStep: 'wait_for_approval'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating KYC',
      error: error.message
    });
  }
};

// @desc    Get KYC requirements
// @route   GET /api/kyc/requirements
// @access  Public
const getKYCRequirements = async (req, res) => {
  try {
    const requirements = {
      identityDocuments: [
        {
          type: 'aadhar-card',
          name: 'Aadhar Card',
          description: 'Indian Aadhar card with photo and QR code'
        },
        {
          type: 'pan-card',
          name: 'PAN Card',
          description: 'Indian PAN (Permanent Account Number) card'
        },
        {
          type: 'voter-id',
          name: 'Voter ID Card',
          description: 'Indian Voter ID card (EPIC)'
        },
        {
          type: 'passport',
          name: 'Passport',
          description: 'Valid passport with clear photo and details'
        },
        {
          type: 'drivers-license',
          name: 'Driver\'s License',
          description: 'Valid driver\'s license with photo'
        }
      ],
      addressProofs: [
        {
          type: 'utility-bill',
          name: 'Utility Bill',
          description: 'Recent electricity, water, or gas bill (not older than 3 months)'
        },
        {
          type: 'bank-statement',
          name: 'Bank Statement',
          description: 'Recent bank statement with address (not older than 3 months)'
        },
        {
          type: 'rent-agreement',
          name: 'Rental Agreement',
          description: 'Current rental or lease agreement'
        },
        {
          type: 'property-tax',
          name: 'Property Tax Receipt',
          description: 'Property tax receipt or assessment'
        },
        {
          type: 'aadhar-address',
          name: 'Aadhar Card',
          description: 'Aadhar card showing current address'
        },
        {
          type: 'voter-id-address',
          name: 'Voter ID Card',
          description: 'Voter ID card showing current address'
        },
         {
          type: 'passport',
          name: 'Passport',
          description: 'Valid passport with current address'
        },
      ],
      selfie: {
        description: 'Clear selfie photo holding your ID document',
        requirements: [
          'Face should be clearly visible',
          'ID document should be readable',
          'Good lighting conditions',
          'No filters or editing'
        ]
      },
      generalRequirements: [
        'All documents must be in English or have English translations',
        'Documents must be valid and not expired',
        'Photos must be clear and legible',
        'All personal information must match across documents'
      ]
    };

    res.status(200).json({
      success: true,
      data: { requirements }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching KYC requirements',
      error: error.message
    });
  }
};

// @desc    Verify KYC (Admin only)
// @route   PUT /api/kyc/:userId/verify
// @access  Private (Admin only)
const verifyKYC = async (req, res) => {
  try {
    const { userId } = req.params;
    console.log("🚀 ~ verifyKYC ~ userId:", req.body)
    const { status, rejectionReason } = req.body;


    const user = await User.findById(userId);
    const host = await Host.findOne({ user: user._id });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.kyc || user.kyc.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'No pending KYC application found'
      });
    }

    // Update KYC status
    user.kyc.status = status;
    if (status === 'rejected' && rejectionReason) {
      user.kyc.rejectionReason = rejectionReason;
    }

    // KYC status is already set above

    await user.save();

    // Update KYC verification record
    await KycVerification.findOneAndUpdate(
      { user: user._id },
      { 
        status,
        rejectionReason: status === 'rejected' ? rejectionReason : undefined,
        verifiedBy: req.user.id,
        verifiedAt: new Date()
      }
    );

    if(status === 'verified'){
      host.isVerified = true;
      await host.save();
    }

    // Create notification for user
    await Notification.create({
      user: user._id,
      type: 'kyc',
      title: `KYC ${status === 'verified' ? 'Approved' : 'Rejected'}`,
      message: status === 'verified' 
        ? 'Your KYC has been approved! You can now apply to become a host.'
        : `Your KYC has been rejected. Reason: ${rejectionReason}`,
      metadata: { kycStatus: status }
    });

    // Send email notification
    const emailSubject = status === 'verified' ? 'KYC Approved' : 'KYC Rejected';
    const emailMessage = status === 'verified'
      ? 'Congratulations! Your KYC has been approved. You can now apply to become a host and start creating listings and services.'
      : `Your KYC application has been rejected. Reason: ${rejectionReason}. Please submit new documents and try again.`;

    await sendEmail(user.email, emailSubject, emailMessage);

    res.status(200).json({
      success: true,
      message: `KYC ${status === 'verified' ? 'approved' : 'rejected'} successfully`,
      data: { user }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error verifying KYC',
      error: error.message
    });
  }
};

module.exports = {
  submitKYC,
  getKYCStatus,
  updateKYC,
  getKYCRequirements,
  verifyKYC
}; 