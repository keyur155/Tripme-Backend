const Admin = require('../models/Admin');
const { logger } = require('../config/logger');

const MAX_IN_MEMORY_LOGS = 500;

class AuditService {
  constructor() {
    this.logs = [];
  }

  // Log admin action
  async logAction(adminId, action, details = {}) {
    try {
      const auditLog = {
        adminId,
        action,
        timestamp: new Date(),
        ipAddress: details.ipAddress,
        userAgent: details.userAgent,
        method: details.method,
        url: details.url,
        statusCode: details.statusCode,
        success: details.success,
        additionalData: details.additionalData || {},
        sessionId: details.sessionId
      };

      logger.info('AUDIT', { audit: auditLog });

      this.logs.push(auditLog);

      // Cap in-memory buffer to prevent unbounded growth
      if (this.logs.length > MAX_IN_MEMORY_LOGS) {
        this.logs = this.logs.slice(-MAX_IN_MEMORY_LOGS);
      }

      return auditLog;
    } catch (error) {
      logger.error('Error logging audit action', { error: error.message });
    }
  }

  // Log sensitive operations
  async logSensitiveOperation(adminId, operation, details = {}) {
    const sensitiveOperations = [
      'admin_login',
      'verify_kyc',
      'approve_property',
      'approve_host',
      'reject_host',
      'process_manual_payout',
      'update_user_status',
      'update_admin_profile',
      'delete_user',
      'suspend_user',
      'change_admin_permissions'
    ];

    if (sensitiveOperations.includes(operation)) {
      await this.logAction(adminId, operation, {
        ...details,
        isSensitive: true,
        requiresReview: true
      });
    }
  }

  // Log failed authentication attempts
  async logFailedAuth(email, ipAddress, userAgent, reason) {
    const auditLog = {
      action: 'failed_auth_attempt',
      email,
      ipAddress,
      userAgent,
      reason,
      timestamp: new Date(),
      success: false
    };

    logger.warn('FAILED AUTH', { audit: auditLog });
    this.logs.push(auditLog);

    // Cap buffer
    if (this.logs.length > MAX_IN_MEMORY_LOGS) {
      this.logs = this.logs.slice(-MAX_IN_MEMORY_LOGS);
    }
  }

  // Log successful authentication
  async logSuccessfulAuth(adminId, email, ipAddress, userAgent) {
    await this.logAction(adminId, 'admin_login', {
      email,
      ipAddress,
      userAgent,
      success: true
    });
  }

  // Get audit logs for admin
  async getAuditLogs(adminId, limit = 100) {
    return this.logs
      .filter(log => log.adminId === adminId)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  // Get all audit logs (admin only)
  async getAllAuditLogs(limit = 1000) {
    return this.logs
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  // Get failed authentication attempts
  async getFailedAuthAttempts(limit = 100) {
    return this.logs
      .filter(log => log.action === 'failed_auth_attempt')
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  // Get sensitive operations
  async getSensitiveOperations(limit = 100) {
    return this.logs
      .filter(log => log.isSensitive)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  // Check for suspicious activity
  async checkSuspiciousActivity(adminId, timeWindow = 24 * 60 * 60 * 1000) {
    const recentLogs = this.logs.filter(log => 
      log.adminId === adminId && 
      new Date(log.timestamp) > new Date(Date.now() - timeWindow)
    );

    const suspiciousPatterns = {
      multipleFailedLogins: recentLogs.filter(log => 
        log.action === 'failed_auth_attempt'
      ).length > 3,
      
      unusualHours: recentLogs.some(log => {
        const hour = new Date(log.timestamp).getHours();
        return hour < 6 || hour > 22; // Activity outside 6 AM - 10 PM
      }),
      
      multipleIPs: new Set(recentLogs.map(log => log.ipAddress)).size > 3,
      
      rapidOperations: recentLogs.filter(log => 
        log.isSensitive
      ).length > 10
    };

    return {
      isSuspicious: Object.values(suspiciousPatterns).some(Boolean),
      patterns: suspiciousPatterns,
      recentActivityCount: recentLogs.length
    };
  }

  // Export audit logs
  async exportAuditLogs(format = 'json') {
    switch (format) {
      case 'json':
        return JSON.stringify(this.logs, null, 2);
      case 'csv':
        return this.convertToCSV(this.logs);
      default:
        return this.logs;
    }
  }

  // Convert logs to CSV
  convertToCSV(logs) {
    if (logs.length === 0) return '';
    
    const headers = Object.keys(logs[0]).join(',');
    const rows = logs.map(log => 
      Object.values(log).map(value => 
        typeof value === 'string' ? `"${value}"` : value
      ).join(',')
    );
    
    return [headers, ...rows].join('\n');
  }

  // Clear old logs
  async clearOldLogs(daysToKeep = 30) {
    const cutoffDate = new Date(Date.now() - (daysToKeep * 24 * 60 * 60 * 1000));
    this.logs = this.logs.filter(log => new Date(log.timestamp) > cutoffDate);
  }
}

module.exports = new AuditService(); 