const express = require('express');
const router = express.Router();
const supportController = require('../controllers/support.controller');
const { auth, adminOnly } = require('../middlewares/auth.middleware');
const { validateTicket, validateMessage } = require('../validations/support.validation');
const AuthorizationMiddleware = require('../middlewares/authorization.middleware');

// Protected routes (require authentication)
router.use(auth);

// Support ticket management
router.post('/tickets', validateTicket, supportController.createTicket);
router.get('/tickets', supportController.getMyTickets);
router.get('/tickets/:id', AuthorizationMiddleware.canAccessSupportTicket, supportController.getTicketById);
router.put('/tickets/:id', AuthorizationMiddleware.canAccessSupportTicket, validateTicket, supportController.updateTicket);
router.delete('/tickets/:id', AuthorizationMiddleware.canAccessSupportTicket, supportController.closeTicket);

// Ticket messaging
router.post('/tickets/:id/messages', AuthorizationMiddleware.canAccessSupportTicket, validateMessage, supportController.addMessage);
router.get('/tickets/:id/messages', AuthorizationMiddleware.canAccessSupportTicket, supportController.getTicketMessages);

// Ticket status and priority
router.patch('/tickets/:id/status', AuthorizationMiddleware.canAccessSupportTicket, supportController.updateTicketStatus);
router.patch('/tickets/:id/priority', AuthorizationMiddleware.canAccessSupportTicket, supportController.updateTicketPriority);

// Support categories and topics
router.get('/categories', supportController.getSupportCategories);
router.get('/topics', supportController.getSupportTopics);

// FAQ and help articles
router.get('/faq', supportController.getFAQ);
router.get('/help-articles', supportController.getHelpArticles);
router.get('/help-articles/:id', supportController.getHelpArticleById);

// Admin routes (admin only)
router.get('/admin/tickets', adminOnly, supportController.getAllTickets);
router.get('/admin/tickets/pending', adminOnly, supportController.getPendingTickets);
router.get('/admin/tickets/open', adminOnly, supportController.getOpenTickets);
router.patch('/admin/tickets/:id/assign', adminOnly, supportController.assignTicket);
router.patch('/admin/tickets/:id/status', adminOnly, supportController.updateTicketStatusAdmin);

// Admin FAQ and help management
router.post('/admin/faq', adminOnly, supportController.createFAQ);
router.put('/admin/faq/:id', adminOnly, supportController.updateFAQ);
router.delete('/admin/faq/:id', adminOnly, supportController.deleteFAQ);

router.post('/admin/help-articles', adminOnly, supportController.createHelpArticle);
router.put('/admin/help-articles/:id', adminOnly, supportController.updateHelpArticle);
router.delete('/admin/help-articles/:id', adminOnly, supportController.deleteHelpArticle);

module.exports = router; 