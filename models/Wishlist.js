const mongoose = require('mongoose');
const { Schema } = mongoose;

const wishlistSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  description: { type: String },
  isPublic: { type: Boolean, default: false },
  items: [{
    itemType: { type: String, enum: ['Property', 'Service'], required: true },
    itemId: { type: Schema.Types.ObjectId, required: true, refPath: 'items.itemType' },
    notes: { type: String },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    addedAt: { type: Date, default: Date.now }
  }],
  collaborators: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  shareId: { type: String, unique: true, sparse: true }
}, {
  timestamps: true
});

// Generate share ID before saving
wishlistSchema.pre('save', function(next) {
  if (this.isPublic && !this.shareId) {
    this.shareId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }
  next();
});

module.exports = mongoose.model('Wishlist', wishlistSchema); 
