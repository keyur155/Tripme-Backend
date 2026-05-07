const mongoose = require('mongoose');

const popularDestinationSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Destination name is required'],
        trim: true,
        maxlength: [100, 'Name cannot exceed 100 characters']
    },
    description: {
        type: String,
        trim: true,
        maxlength: [200, 'Description cannot exceed 200 characters'],
        default: 'Amazing Destination'
    },
    image: {
        type: String,
        required: [true, 'Destination image URL is required'],
        validate: {
            validator: function (v) {
                return /^https?:\/\/.+/.test(v);
            },
            message: 'Image must be a valid HTTP/HTTPS URL'
        }
    },
    staysLabel: {
        type: String,
        trim: true,
        default: '',
        maxlength: [50, 'Stays label cannot exceed 50 characters']
    },
    displayOrder: {
        type: Number,
        default: 0
    },
    isActive: {
        type: Boolean,
        default: true
    },
    searchCity: {
        type: String,
        trim: true,
        default: ''
    }
}, {
    timestamps: true
});

popularDestinationSchema.index({ displayOrder: 1 });
popularDestinationSchema.index({ isActive: 1 });

module.exports = mongoose.model('PopularDestination', popularDestinationSchema);
