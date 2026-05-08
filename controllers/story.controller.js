const Story = require('../models/Story');
const User = require('../models/User');
const { validateStory } = require('../validations/story.validation');
const { uploadToCloudinary } = require('../config/cloudinary');

// Get all published stories with pagination and filtering
const getAllStories = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 12,
      category,
      search,
      author,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const query = { isPublished: true };

    // Category filter
    if (category) {
      query.category = category;
    }

    // Search filter - use regex for partial matching across title, excerpt, tags, and location
    if (search) {
      const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { title: searchRegex },
        { excerpt: searchRegex },
        { tags: searchRegex },
        { 'location.city': searchRegex },
        { 'location.state': searchRegex },
        { 'location.country': searchRegex }
      ];
    }

    // Author filter
    if (author) {
      query.author = author;
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const stories = await Story.find(query)
      .populate('author', 'name profileImage')
      .sort(sortOptions)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Story.countDocuments(query);

    res.json({
      success: true,
      data: {
        stories,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
        total
      }
    });
  } catch (error) {
    console.error('Error fetching stories:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch stories'
    });
  }
};

// Search stories with query, category, and location filters
const searchStories = async (req, res) => {
  try {
    const {
      q = '',
      category,
      location,
      page = 1,
      limit = 12,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const query = { isPublished: true };

    if (q) {
      const searchRegex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { title: searchRegex },
        { excerpt: searchRegex },
        { tags: searchRegex },
        { 'location.city': searchRegex },
        { 'location.state': searchRegex },
        { 'location.country': searchRegex },
        { category: searchRegex }
      ];
    }

    if (category) {
      query.category = category;
    }

    if (location) {
      const locRegex = new RegExp(location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        ...(query.$or || []),
        { 'location.city': locRegex },
        { 'location.state': locRegex },
        { 'location.country': locRegex }
      ];
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const stories = await Story.find(query)
      .populate('author', 'name profileImage')
      .sort(sortOptions)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Story.countDocuments(query);

    res.json({
      success: true,
      data: {
        stories,
        totalPages: Math.ceil(total / limit),
        currentPage: Number(page),
        total
      }
    });
  } catch (error) {
    console.error('Error searching stories:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search stories'
    });
  }
};

// Get featured stories
const getFeaturedStories = async (req, res) => {
  try {
    const stories = await Story.find({ 
      isPublished: true, 
      isFeatured: true 
    })
    .populate('author', 'name profileImage')
    .sort({ createdAt: -1 })
    .limit(6);

    res.json({
      success: true,
      data: { stories }
    });
  } catch (error) {
    console.error('Error fetching featured stories:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch featured stories'
    });
  }
};

// Get single story by slug
const getStoryBySlug = async (req, res) => {
  try {
    const { slug } = req.params;

    const story = await Story.findOne({ 
      slug, 
      isPublished: true 
    }).populate('author', 'name profileImage bio');

    if (!story) {
      return res.status(404).json({
        success: false,
        message: 'Story not found'
      });
    }

    // Increment views
    story.views += 1;
    await story.save();

    res.json({
      success: true,
      data: { story }
    });
  } catch (error) {
    console.error('Error fetching story:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch story'
    });
  }
};

// Get single story by ID
const getStoryById = async (req, res) => {
  try {
    const { id } = req.params;

    const story = await Story.findById(id)
      .populate('author', 'name profileImage bio')
      .populate('comments.user', 'name profileImage');

    if (!story) {
      return res.status(404).json({
        success: false,
        message: 'Story not found'
      });
    }

    // Increment views
    story.views += 1;
    await story.save();

    res.json({
      success: true,
      data: { story }
    });
  } catch (error) {
    console.error('Error fetching story:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch story'
    });
  }
};

// Create new story
const createStory = async (req, res) => {
  try {
    const { error } = validateStory(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const storyData = {
      ...req.body,
      author: req.user.id
    };

    // Generate slug from title
    storyData.slug = req.body.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    const story = new Story(storyData);
    await story.save();

    const populatedStory = await Story.findById(story._id)
      .populate('author', 'name profileImage');

    res.status(201).json({
      success: true,
      data: { story: populatedStory }
    });
  } catch (error) {
    console.error('Error creating story:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create story'
    });
  }
};

// Update story
const updateStory = async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = validateStory(req.body);
    
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const story = await Story.findById(id);
    
    if (!story) {
      return res.status(404).json({
        success: false,
        message: 'Story not found'
      });
    }

    // Check if user is author or admin
    if (story.author.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this story'
      });
    }

    const updatedStory = await Story.findByIdAndUpdate(
      id,
      req.body,
      { new: true, runValidators: true }
    ).populate('author', 'name profileImage');

    res.json({
      success: true,
      data: { story: updatedStory }
    });
  } catch (error) {
    console.error('Error updating story:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update story'
    });
  }
};

// Delete story
const deleteStory = async (req, res) => {
  try {
    const { id } = req.params;

    const story = await Story.findById(id);
    
    if (!story) {
      return res.status(404).json({
        success: false,
        message: 'Story not found'
      });
    }

    // Check if user is author or admin
    if (story.author.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this story'
      });
    }

    await Story.findByIdAndDelete(id);

    res.json({
      success: true,
      message: 'Story deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting story:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete story'
    });
  }
};

// Like/Unlike story
const toggleLike = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const story = await Story.findById(id);
    
    if (!story) {
      return res.status(404).json({
        success: false,
        message: 'Story not found'
      });
    }

    const isLiked = story.likes.includes(userId);

    if (isLiked) {
      story.likes = story.likes.filter(like => like.toString() !== userId);
    } else {
      story.likes.push(userId);
    }

    await story.save();

    res.json({
      success: true,
      data: { 
        isLiked: !isLiked,
        likesCount: story.likes.length
      }
    });
  } catch (error) {
    console.error('Error toggling like:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle like'
    });
  }
};

// Add comment to story
const addComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Comment content is required'
      });
    }

    const story = await Story.findById(id);
    
    if (!story) {
      return res.status(404).json({
        success: false,
        message: 'Story not found'
      });
    }

    const comment = {
      user: req.user.id,
      content: content.trim()
    };

    story.comments.push(comment);
    await story.save();

    const populatedStory = await Story.findById(id)
      .populate('comments.user', 'name profileImage');

    const newComment = populatedStory.comments[populatedStory.comments.length - 1];

    res.json({
      success: true,
      data: { comment: newComment }
    });
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add comment'
    });
  }
};

// Get user's stories
const getUserStories = async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    const stories = await Story.find({ 
      author: userId,
      isPublished: true 
    })
    .populate('author', 'name profileImage')
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);

    const total = await Story.countDocuments({ 
      author: userId,
      isPublished: true 
    });

    res.json({
      success: true,
      data: {
        stories,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
        total
      }
    });
  } catch (error) {
    console.error('Error fetching user stories:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user stories'
    });
  }
};

// Get categories
const getCategories = async (req, res) => {
  try {
    const categories = await Story.aggregate([
      { $match: { isPublished: true } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    res.json({
      success: true,
      data: { categories }
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch categories'
    });
  }
};

module.exports = {
  getAllStories,
  searchStories,
  getFeaturedStories,
  getStoryBySlug,
  getStoryById,
  createStory,
  updateStory,
  deleteStory,
  toggleLike,
  addComment,
  getUserStories,
  getCategories
}; 