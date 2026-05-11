const mongoose = require('mongoose');
const { Schema } = mongoose;

const notificationSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: ['booking', 'review', 'payment', 'system', 'admin', 'service'],
    required: true
  },
  title: { 
    type: String, 
    required: true,
    maxlength: [100, 'Notification title cannot exceed 100 characters']
  },
  message: { 
    type: String, 
    required: true,
    maxlength: [500, 'Notification message cannot exceed 500 characters']
  },
  relatedEntity: {
    type: { type: String, enum: ['Booking', 'Property', 'Review', 'Service'] },
    id: { type: Schema.Types.ObjectId }
  },
  isRead: { type: Boolean, default: false },
  metadata: { type: Schema.Types.Mixed }
}, { timestamps: true, toJSON: { virtuals: true } });

// Indexes
notificationSchema.index({ user: 1, isRead: 1 });
notificationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);