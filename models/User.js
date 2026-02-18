const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const validator = require('validator');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please enter your name'],
    trim: true,
    maxlength: [50, 'Name cannot exceed 50 characters']
  },
  email: {
    type: String,
    required: [true, 'Please enter your email'],
    unique: true,
    lowercase: true,
    validate: [validator.isEmail, 'Please enter a valid email']
  },
  phone: {
    type: String,
    validate: {
      validator: function(v) {
        return /^\+?[1-9]\d{1,14}$/.test(v); // E.164 format
      },
      message: props => `${props.value} is not a valid phone number!`
    }
  },
  password: {
    type: String,
    required: [true, 'Please enter a password'],
    minlength: [12, 'Password must be at least 12 characters'],
    validate: {
      validator: function(password) {
        // Require: uppercase, lowercase, number, special character
        const hasUpperCase = /[A-Z]/.test(password);
        const hasLowerCase = /[a-z]/.test(password);
        const hasNumbers = /\d/.test(password);
        const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
        return hasUpperCase && hasLowerCase && hasNumbers && hasSpecialChar;
      },
      message: 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'
    },
    select: false
  },
  role: {
    type: String,
    enum: ['guest', 'host', 'admin'],
    default: 'guest'
  },
  profileImage: {
    type: String,
    default: 'default.jpg'
  },
  kyc: {
    identityDocument: {
      type: String,
      validate: {
        validator: function(v) {
          return !v || ['aadhar-card', 'pan-card', 'voter-id', 'passport', 'drivers-license'].includes(v);
        },
        message: 'Invalid identity document type'
      }
    },
    documentNumber: {
      type: String,
      validate: {
        validator: function(v) {
          if (!v) return true;
          const docType = this.kyc?.identityDocument;
          switch(docType) {
            case 'aadhar-card':
              return /^\d{12}$/.test(v); // 12 digits
            case 'pan-card':
              return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(v); // ABCDE1234F format
            case 'voter-id':
              return /^[A-Z]{3}[0-9]{7}$/.test(v); // ABC1234567 format
            case 'passport':
              return /^[A-Z]{1}[0-9]{7}$/.test(v); // A1234567 format
            case 'drivers-license':
              return /^[A-Z]{2}[0-9]{2}[0-9]{11}$/.test(v); // DL format
            default:
              return v.length >= 5;
          }
        },
        message: 'Invalid document number format for the selected document type'
      }
    },
    documentImage: String,
    // Address Proof
    addressProofType: {
      type: String,
      validate: {
        validator: function(v) {
          return !v || ['aadhar-address', 'voter-id', 'passport', 'utility-bill', 'bank-statement', 'rent-agreement'].includes(v);
        },
        message: 'Invalid address proof type'
      }
    },
    addressProofNumber: String,
    addressProofImage: String,
    status: {
      type: String,
      enum: ['pending', 'verified', 'rejected', 'not_submitted'],
      default: 'not_submitted'
    },
    // Grace period deadline - 15 days from first listing creation
    deadline: {
      type: Date,
      default: null
    },
    submittedAt: Date,
    verifiedAt: Date,
    rejectionReason: String
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      default: [0, 0]
    },
    address: String,
    city: String,
    state: String,
    country: String
  },
  bio: {
    type: String,
    maxlength: [500, 'Bio cannot exceed 500 characters']
  },
  languages: [{
    type: String,
    enum: ['en', 'fr', 'es', 'de', 'it', 'pt', 'ru', 'zh', 'ja', 'ar']
  }],
  accountStatus: {
    type: String,
    enum: ['active', 'suspended', 'banned', 'deactivated'],
    default: 'active'
  },
  socialLogins: {
    googleId: String,
    facebookId: String
  },
  savedListings: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Property'
  }],
  metadata: mongoose.Schema.Types.Mixed
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ location: '2dsphere' });

// Virtuals
userSchema.virtual('reviews', {
  ref: 'Review',
  localField: '_id',
  foreignField: 'reviewedUser'
});

userSchema.virtual('bookings', {
  ref: 'Booking',
  localField: '_id',
  foreignField: 'user'
});

userSchema.virtual('listings', {
  ref: 'Property',
  localField: '_id',
  foreignField: 'host'
});

// Pre-save hooks
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Methods
userSchema.methods.generateAuthToken = function() {
  return jwt.sign({ id: this._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN
  });
};

userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);


// // models/User.js (keep it clean)
// const userSchema = new mongoose.Schema({
//   name: {
//     type: String,
//     required: true
//   },
//   email: {
//     type: String,
//     required: true,
//     unique: true
//   },
//   password: {
//     type: String,
//     required: true
//   },
//   role: {
//     type: String,
//     enum: ['guest', 'host', 'admin'],
//     default: 'guest'
//   },
//   profileImage: String,
//   phone: String,
//   location: {
//     address: String,
//     city: String,
//     state: String,
//     country: String,
//     coordinates: [Number]
//   },
//   languages: [String],
//   bio: String,
//   isVerified: {
//     type: Boolean,
//     default: false
//   }
// }, {
//   timestamps: true
// });

// // Reference to Host model
// userSchema.virtual('hostProfile', {
//   ref: 'Host',
//   localField: '_id',
//   foreignField: 'user'
// });

// module.exports = mongoose.model('User', userSchema);
