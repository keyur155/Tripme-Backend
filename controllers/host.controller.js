// controllers/host.controller.js
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types; 
const Host = require('../models/Host');
const User = require('../models/User');
const Property = require('../models/Property');

// @desc    Get host profile by ID
// @route   GET /api/hosts/:id
// const getHostProfile = async (req, res) => {
//   try {
//     const { id } = req.params;
//        console.log('host profile called:', id); // Debug log
//     const host = await Host.findOne({ user: require('mongoose').Types.ObjectId(id) })
//       .populate('user', 'name email profileImage phone location bio languages')
//       .populate('savedListings', 'title images pricing');

//     if (!host) {
//       console.log('❌ Host not found for ID:', id); // Debug log
//       return res.status(404).json({
//         success: false,
//         message: 'Host profile not found'
//       });
//     }

//     res.status(200).json({
//       success: true,
//       data: {
//         _id: host.user._id,
//         name: host.user.name,
//         email: host.user.email,
//         profileImage: host.user.profileImage,
//         bio: host.user.bio,
//         location: host.user.location,
//         languages: host.user.languages,
//         phone: host.user.phone,
//         rating: host.rating,
//         reviewCount: host.reviewCount,
//         responseRate: host.responseRate,
//         responseTime: host.responseTime,
//         isSuperhost: host.isSuperhost,
//         createdAt: host.hostingSince,
//         listings: host.savedListings || []
//       }
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: 'Server error',
//       error: error.message
//     });
//   }
// };


// @desc    Get host profile by ID
// @route   GET /api/hosts/:id
const getHostProfile = async (req, res) => {
  try {
    const { id } = req.params;
    console.log('🔍 Looking for host with ID:', id); // Debug log
    
     // First try to get Host record
    let host = await Host.findOne({ user: new ObjectId(id) })
      .populate('user', 'name email profileImage phone location bio languages')
      .populate('savedListings', 'title images pricing');
    
    console.log('🏠 Found host:', host); // Debug log

   
    // If no Host record, get user data directly
    if (!host) {
      console.log('🏠 No Host record found, getting User data directly');
      const User = require('../models/User');
      const user = await User.findById(id).select('name email profileImage phone location bio languages');
      
      if (user) {
        return res.status(200).json({
          success: true,
          data: {
            _id: user._id,
            name: user.name,
            email: user.email,
            profileImage: user.profileImage,
            bio: user.bio || '',
            location: user.location,
            languages: user.languages || [],
            phone: user.phone,
            rating: 0, // Default values
            reviewCount: 0,
            responseRate: 0,
            responseTime: 'within a day',
            isSuperhost: false,
            createdAt: user.createdAt,
            listings: [] // Empty since no Host record
          }
        });
      }
    }

    console.log('✅ Sending host profile response'); // Debug log
    res.status(200).json({
      success: true,
      data: {
        _id: host.user._id,
        name: host.user.name,
        email: host.user.email,
        profileImage: host.user.profileImage,
        bio: host.user.bio,
        location: host.user.location,
        languages: host.user.languages,
        phone: host.user.phone,
        rating: host.rating,
        reviewCount: host.reviewCount,
        responseRate: host.responseRate,
        responseTime: host.responseTime,
        isSuperhost: host.isSuperhost,
        createdAt: host.hostingSince,
        listings: host.savedListings || []
      }
    });
  } catch (error) {
    console.log('💥 Error in getHostProfile:', error); // Debug log
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

const getHostListings = async(req, res) =>{

  try {
        const {id} =  req.params;

        const listing = await Property.find({host:id})
        .select('title images pricing location')
        .populate('host', 'name email profileImage phone location bio languages')
        console.log("listing",listing); 
         res.status(200).json({
          success: true,
          data: listing
         })
        

  } catch (error) {
    console.log('💥 Error in getHostListing:', error); // Debug log
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }

}

module.exports = {
  getHostProfile,
  getHostListings
};