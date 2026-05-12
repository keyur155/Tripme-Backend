const SupportTicket = require('../models/SupportTicket');
const Message = require('../models/Message');
const User = require('../models/User');
const { sendSupportTicketEmail } = require('../utils/sendEmail');

// Create a new support ticket
const createTicket = async (req, res) => {
  try {
    const { title, description, category, priority, attachments } = req.body;
    const userId = req.user.id;

    const ticket = new SupportTicket({
      user: userId,
      title,
      description,
      category,
      priority: priority || 'medium',
      attachments: attachments || [],
      status: 'open'
    });

    await ticket.save();

    // Populate user details
    await ticket.populate('user', 'name email');

    // Send confirmation email to user
    sendSupportTicketEmail(ticket.user.email, ticket.user.name, {
      ticketId: ticket._id,
      subject: ticket.title,
      priority: ticket.priority,
      status: ticket.status,
    }).catch(err => console.error('Error sending support ticket email:', err.message));

    res.status(201).json({
      success: true,
      message: 'Support ticket created successfully',
      data: ticket
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating support ticket',
      error: error.message
    });
  }
};

// Get user's tickets
const getMyTickets = async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, category, page = 1, limit = 10 } = req.query;

    const query = { user: userId };
    if (status) query.status = status;
    if (category) query.category = category;

    const tickets = await SupportTicket.find(query)
      .populate('user', 'name email')
      .populate('assignedTo', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await SupportTicket.countDocuments(query);

    res.json({
      success: true,
      data: tickets,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching tickets',
      error: error.message
    });
  }
};

// Get ticket by ID
const getTicketById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const ticket = await SupportTicket.findOne({ _id: id, user: userId })
      .populate('user', 'name email')
      .populate('assignedTo', 'name email');

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    res.json({
      success: true,
      data: ticket
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching ticket',
      error: error.message
    });
  }
};

// Update ticket
const updateTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, category, priority } = req.body;
    const userId = req.user.id;

    const ticket = await SupportTicket.findOne({ _id: id, user: userId });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    if (ticket.status === 'closed') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update closed ticket'
      });
    }

    const updatedTicket = await SupportTicket.findByIdAndUpdate(
      id,
      { title, description, category, priority },
      { new: true }
    ).populate('user', 'name email');

    res.json({
      success: true,
      message: 'Ticket updated successfully',
      data: updatedTicket
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating ticket',
      error: error.message
    });
  }
};

// Close ticket
const closeTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const ticket = await SupportTicket.findOne({ _id: id, user: userId });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    ticket.status = 'closed';
    ticket.closedAt = new Date();
    await ticket.save();

    res.json({
      success: true,
      message: 'Ticket closed successfully',
      data: ticket
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error closing ticket',
      error: error.message
    });
  }
};

// Add message to ticket
const addMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { content, attachments } = req.body;
    const userId = req.user.id;

    const ticket = await SupportTicket.findOne({ _id: id, user: userId });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    if (ticket.status === 'closed') {
      return res.status(400).json({
        success: false,
        message: 'Cannot add message to closed ticket'
      });
    }

    const message = new Message({
      ticket: id,
      sender: userId,
      content,
      attachments: attachments || [],
      type: 'support'
    });

    await message.save();

    // Update ticket status to 'in_progress' if it was 'open'
    if (ticket.status === 'open') {
      ticket.status = 'in_progress';
      await ticket.save();
    }

    await message.populate('sender', 'name email');

    res.status(201).json({
      success: true,
      message: 'Message added successfully',
      data: message
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error adding message',
      error: error.message
    });
  }
};

// Get ticket messages
const getTicketMessages = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const ticket = await SupportTicket.findOne({ _id: id, user: userId });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    const messages = await Message.find({ ticket: id })
      .populate('sender', 'name email')
      .sort({ createdAt: 1 });

    res.json({
      success: true,
      data: messages
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching messages',
      error: error.message
    });
  }
};

// Update ticket status
const updateTicketStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = req.user.id;

    const ticket = await SupportTicket.findOne({ _id: id, user: userId });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    ticket.status = status;
    if (status === 'closed') {
      ticket.closedAt = new Date();
    }
    await ticket.save();

    res.json({
      success: true,
      message: 'Ticket status updated successfully',
      data: ticket
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating ticket status',
      error: error.message
    });
  }
};

// Update ticket priority
const updateTicketPriority = async (req, res) => {
  try {
    const { id } = req.params;
    const { priority } = req.body;
    const userId = req.user.id;

    const ticket = await SupportTicket.findOne({ _id: id, user: userId });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    ticket.priority = priority;
    await ticket.save();

    res.json({
      success: true,
      message: 'Ticket priority updated successfully',
      data: ticket
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating ticket priority',
      error: error.message
    });
  }
};

// Get support categories
const getSupportCategories = async (req, res) => {
  try {
    const categories = [
      { id: 'technical', name: 'Technical Issues', description: 'App or website problems' },
      { id: 'billing', name: 'Billing & Payments', description: 'Payment and billing questions' },
      { id: 'booking', name: 'Booking Issues', description: 'Problems with reservations' },
      { id: 'account', name: 'Account Issues', description: 'Account and profile problems' },
      { id: 'safety', name: 'Safety & Security', description: 'Safety concerns and reports' },
      { id: 'general', name: 'General Questions', description: 'Other questions and feedback' }
    ];

    res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching categories',
      error: error.message
    });
  }
};

// Get support topics
const getSupportTopics = async (req, res) => {
  try {
    const topics = [
      { id: 'login', name: 'Login Problems', category: 'technical' },
      { id: 'payment', name: 'Payment Issues', category: 'billing' },
      { id: 'refund', name: 'Refund Requests', category: 'billing' },
      { id: 'cancellation', name: 'Booking Cancellation', category: 'booking' },
      { id: 'verification', name: 'Account Verification', category: 'account' },
      { id: 'safety_concern', name: 'Safety Concern', category: 'safety' }
    ];

    res.json({
      success: true,
      data: topics
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching topics',
      error: error.message
    });
  }
};

// Get FAQ
const getFAQ = async (req, res) => {
  try {
    const faqs = [
      {
        question: 'How do I cancel a booking?',
        answer: 'You can cancel a booking through your dashboard or by contacting support.',
        category: 'booking'
      },
      {
        question: 'How do I get a refund?',
        answer: 'Refunds are processed according to the cancellation policy. Contact support for assistance.',
        category: 'billing'
      },
      {
        question: 'How do I verify my account?',
        answer: 'Complete your profile and upload required documents for verification.',
        category: 'account'
      }
    ];

    res.json({
      success: true,
      data: faqs
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching FAQ',
      error: error.message
    });
  }
};

// Get help articles
const getHelpArticles = async (req, res) => {
  try {
    const articles = [
      {
        id: 'getting-started',
        title: 'Getting Started with TripMe',
        content: 'Learn how to create your first listing...',
        category: 'guide'
      },
      {
        id: 'booking-guide',
        title: 'How to Book a Property',
        content: 'Step-by-step guide to booking...',
        category: 'guide'
      }
    ];

    res.json({
      success: true,
      data: articles
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching help articles',
      error: error.message
    });
  }
};

// Get help article by ID
const getHelpArticleById = async (req, res) => {
  try {
    const { id } = req.params;

    // In a real app, this would fetch from a database
    const article = {
      id,
      title: 'Sample Help Article',
      content: 'This is the content of the help article...',
      category: 'guide',
      lastUpdated: new Date()
    };

    res.json({
      success: true,
      data: article
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching help article',
      error: error.message
    });
  }
};

// Admin: Get all tickets
const getAllTickets = async (req, res) => {
  try {
    const { status, category, priority, page = 1, limit = 20 } = req.query;

    const query = {};
    if (status) query.status = status;
    if (category) query.category = category;
    if (priority) query.priority = priority;

    const tickets = await SupportTicket.find(query)
      .populate('user', 'name email')
      .populate('assignedTo', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await SupportTicket.countDocuments(query);

    res.json({
      success: true,
      data: tickets,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching tickets',
      error: error.message
    });
  }
};

// Admin: Get pending tickets
const getPendingTickets = async (req, res) => {
  try {
    const tickets = await SupportTicket.find({ status: 'open' })
      .populate('user', 'name email')
      .sort({ priority: -1, createdAt: 1 });

    res.json({
      success: true,
      data: tickets
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching pending tickets',
      error: error.message
    });
  }
};

// Admin: Get open tickets
const getOpenTickets = async (req, res) => {
  try {
    const tickets = await SupportTicket.find({ status: { $in: ['open', 'in_progress'] } })
      .populate('user', 'name email')
      .populate('assignedTo', 'name email')
      .sort({ priority: -1, createdAt: 1 });

    res.json({
      success: true,
      data: tickets
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching open tickets',
      error: error.message
    });
  }
};

// Admin: Assign ticket
const assignTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const { assignedTo } = req.body;

    const ticket = await SupportTicket.findById(id);

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    ticket.assignedTo = assignedTo;
    ticket.status = 'in_progress';
    await ticket.save();

    await ticket.populate('assignedTo', 'name email');

    res.json({
      success: true,
      message: 'Ticket assigned successfully',
      data: ticket
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error assigning ticket',
      error: error.message
    });
  }
};

// Admin: Update ticket status
const updateTicketStatusAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resolution } = req.body;

    const ticket = await SupportTicket.findById(id);

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    ticket.status = status;
    if (resolution) ticket.resolution = resolution;
    if (status === 'closed') {
      ticket.closedAt = new Date();
    }
    await ticket.save();

    res.json({
      success: true,
      message: 'Ticket status updated successfully',
      data: ticket
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating ticket status',
      error: error.message
    });
  }
};

// Admin: Create FAQ
const createFAQ = async (req, res) => {
  try {
    const { question, answer, category } = req.body;

    // In a real app, this would save to a FAQ collection
    const faq = {
      question,
      answer,
      category,
      createdAt: new Date()
    };

    res.status(201).json({
      success: true,
      message: 'FAQ created successfully',
      data: faq
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating FAQ',
      error: error.message
    });
  }
};

// Admin: Update FAQ
const updateFAQ = async (req, res) => {
  try {
    const { id } = req.params;
    const { question, answer, category } = req.body;

    // In a real app, this would update in a FAQ collection
    const faq = {
      id,
      question,
      answer,
      category,
      updatedAt: new Date()
    };

    res.json({
      success: true,
      message: 'FAQ updated successfully',
      data: faq
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating FAQ',
      error: error.message
    });
  }
};

// Admin: Delete FAQ
const deleteFAQ = async (req, res) => {
  try {
    const { id } = req.params;

    // In a real app, this would delete from a FAQ collection

    res.json({
      success: true,
      message: 'FAQ deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting FAQ',
      error: error.message
    });
  }
};

// Admin: Create help article
const createHelpArticle = async (req, res) => {
  try {
    const { title, content, category } = req.body;

    // In a real app, this would save to a help articles collection
    const article = {
      title,
      content,
      category,
      createdAt: new Date()
    };

    res.status(201).json({
      success: true,
      message: 'Help article created successfully',
      data: article
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating help article',
      error: error.message
    });
  }
};

// Admin: Update help article
const updateHelpArticle = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, category } = req.body;

    // In a real app, this would update in a help articles collection
    const article = {
      id,
      title,
      content,
      category,
      updatedAt: new Date()
    };

    res.json({
      success: true,
      message: 'Help article updated successfully',
      data: article
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating help article',
      error: error.message
    });
  }
};

// Admin: Delete help article
const deleteHelpArticle = async (req, res) => {
  try {
    const { id } = req.params;

    // In a real app, this would delete from a help articles collection

    res.json({
      success: true,
      message: 'Help article deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting help article',
      error: error.message
    });
  }
};

module.exports = {
  createTicket,
  getMyTickets,
  getTicketById,
  updateTicket,
  closeTicket,
  addMessage,
  getTicketMessages,
  updateTicketStatus,
  updateTicketPriority,
  getSupportCategories,
  getSupportTopics,
  getFAQ,
  getHelpArticles,
  getHelpArticleById,
  getAllTickets,
  getPendingTickets,
  getOpenTickets,
  assignTicket,
  updateTicketStatusAdmin,
  createFAQ,
  updateFAQ,
  deleteFAQ,
  createHelpArticle,
  updateHelpArticle,
  deleteHelpArticle
}; 