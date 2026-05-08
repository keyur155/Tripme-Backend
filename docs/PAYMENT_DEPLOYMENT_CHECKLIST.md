# Payment System Deployment Readiness Checklist

## Pre-Deployment Verification

### 1. Environment Configuration
- [ ] `RAZORPAY_KEY_ID` is set (production key)
- [ ] `RAZORPAY_KEY_SECRET` is set (production secret)
- [ ] `RAZORPAY_WEBHOOK_SECRET` is set
- [ ] `MONGODB_URI` points to production database
- [ ] `NODE_ENV=production`

### 2. Razorpay Dashboard Configuration
- [ ] Webhook URL configured: `https://your-domain.com/api/payments/webhook/razorpay`
- [ ] Webhook events enabled:
  - [x] `payment.authorized`
  - [x] `payment.captured`
  - [x] `payment.failed`
  - [x] `order.paid`
  - [x] `refund.created`
  - [x] `refund.processed`
  - [x] `refund.failed`
- [ ] Webhook secret copied to environment
- [ ] Test webhook delivery from Razorpay dashboard

### 3. MongoDB Indexes
Run the following to ensure indexes exist:
```javascript
// Connect to MongoDB and run:
db.payments.createIndex({ razorpayPaymentId: 1 }, { unique: true, sparse: true });
db.payments.createIndex({ razorpayOrderId: 1 });
db.payments.createIndex({ status: 1, createdAt: -1 });
db.payments.createIndex({ recoveryStatus: 1 });
db.payments.createIndex({ 'metadata.source': 1 });
db.payments.createIndex({ 'processedWebhookEvents.eventId': 1 });
db.payments.createIndex({ booking: 1 });
db.payments.createIndex({ user: 1 });
db.payments.createIndex({ host: 1 });
```

### 4. Reconciliation Cron
- [ ] Verify reconciliation runs every 12 minutes (check `server.js`)
- [ ] Verify startup reconciliation runs 30 seconds after server start
- [ ] Test reconciliation manually: `GET /api/payments/admin/debug/reconciliation-stats`

---

## Architecture Verification

### 5. Webhook Hardening
- [x] Signature verification enabled
- [x] Invalid signature logging (SECURITY level)
- [x] Always returns 200 to prevent infinite retries
- [x] Webhook event ID deduplication
- [x] Orphan record creation for missing payments
- [x] Timeline logging for all events

### 6. Payment Failure Handling
- [x] `payment.failed` webhook creates DB record even if payment missing
- [x] Failure details stored (error_code, error_description, etc.)
- [x] Booking cancelled on failure
- [x] Availability reverted safely (checks for other confirmed bookings)
- [x] Timeline entry added

### 7. Recovery Mechanisms
- [x] Orphan payments flagged with `metadata.source = 'webhook_orphan'`
- [x] Captured payments without booking flagged as `recovery_required`
- [x] Recovery queue processed by reconciliation cron
- [x] Manual reconciliation available via admin endpoint
- [x] Abandoned checkouts cleaned up after 2 hours

### 8. Idempotency
- [x] Webhook event IDs tracked in `processedWebhookEvents`
- [x] Duplicate webhooks detected and skipped
- [x] Status transitions are idempotent (won't overwrite completed/refunded)

---

## Testing Checklist

### 9. Success Cases
- [ ] Card payment success → booking confirmed
- [ ] UPI payment success → booking confirmed
- [ ] Delayed UPI capture → reconciliation confirms booking

### 10. Failure Cases
- [ ] Invalid OTP → payment failed, booking cancelled
- [ ] Bank decline → payment failed, availability reverted
- [ ] Insufficient funds → payment failed
- [ ] User closes modal → frontend reports failure
- [ ] Webhook before DB write → orphan record created
- [ ] Duplicate webhook → deduplicated, no double processing

### 11. Recovery Cases
- [ ] Server restart → startup reconciliation runs
- [ ] Delayed webhook → processed correctly
- [ ] Payment captured, booking missing → flagged for recovery

### 12. Admin Debug Endpoints
Test each endpoint:
- [ ] `GET /api/payments/admin/debug/search?razorpayPaymentId=xxx`
- [ ] `GET /api/payments/admin/debug/:paymentId/timeline`
- [ ] `GET /api/payments/admin/debug/orphans`
- [ ] `GET /api/payments/admin/debug/recovery-queue`
- [ ] `GET /api/payments/admin/debug/failed`
- [ ] `GET /api/payments/admin/debug/reconciliation-stats`
- [ ] `POST /api/payments/admin/debug/:paymentId/reconcile`

---

## Monitoring Setup

### 13. Logging
- [ ] Winston logger configured for production
- [ ] Log level set appropriately (info/warn for production)
- [ ] Sensitive data redaction enabled
- [ ] Log aggregation service configured (e.g., CloudWatch, Datadog)

### 14. Alerts (Recommended)
Set up alerts for:
- [ ] `CRITICAL: payment.captured webhook — no DB record found`
- [ ] `CRITICAL: Payment captured but booking not found`
- [ ] `ORPHAN PAYMENT requires manual recovery`
- [ ] `SECURITY: Invalid Razorpay webhook signature`
- [ ] Recovery queue size > 10
- [ ] Failed payments in last 24h > threshold

### 15. Metrics (Recommended)
Track:
- [ ] Payments by status (completed, failed, pending)
- [ ] Reconciliation job duration
- [ ] Orphan payment count
- [ ] Recovery queue size
- [ ] Webhook processing time
- [ ] Failure rate by error code

---

## Post-Deployment Verification

### 16. Smoke Tests
- [ ] Create a test booking with ₹1 payment
- [ ] Verify webhook received and processed
- [ ] Check payment timeline in admin debug
- [ ] Verify booking status is confirmed
- [ ] Test refund flow

### 17. Monitoring Period
For first 24-48 hours:
- [ ] Monitor reconciliation job logs
- [ ] Check for orphan payments
- [ ] Verify no recovery_required payments accumulating
- [ ] Monitor webhook delivery success rate in Razorpay dashboard

---

## Rollback Plan

If issues occur:
1. **Webhook failures**: Razorpay will retry. Check reconciliation is running.
2. **Orphan payments accumulating**: Check webhook signature secret matches.
3. **Bookings not confirming**: Check reconciliation logs, run manual reconciliation.
4. **Database issues**: Reconciliation will retry. Check MongoDB connection.

Emergency contacts:
- Razorpay Support: support@razorpay.com
- Internal: [Add your team contacts]

---

## Summary of Changes Made

### Payment Schema (`models/Payment.js`)
- Added `timeline` array for event logging
- Added `processedWebhookEvents` for webhook deduplication
- Added `recoveryStatus`, `recoveryAttempts`, `recoveredAt` for recovery tracking
- Added `rawWebhookPayload` for orphan records
- Made `booking`, `user`, `host`, `amount` optional for orphan records
- Added unique sparse index on `razorpayPaymentId`

### Webhook Handlers (`controllers/payment.controller.js`)
- `razorpayWebhook`: Added event ID generation, always returns 200
- `handleRazorpayPaymentSuccess`: Creates orphan records, flags recovery_required
- `handleRazorpayPaymentAuthorized`: Creates orphan records
- `handleRazorpayPaymentFailure`: Creates orphan records, safe availability revert

### Reconciliation Service (`services/paymentReconciliation.service.js`)
- Added `processRecoveryQueue` for recovery_required payments
- Added `handleAbandonedCheckouts` for stale orders
- Enhanced `handleCapturedPayment` with recovery flagging
- Enhanced `handleFailedPayment` with safe availability revert
- Added timeline logging throughout

### Admin Debug Endpoints
- `GET /admin/debug/search` - Search by various IDs
- `GET /admin/debug/:paymentId/timeline` - View payment timeline
- `GET /admin/debug/orphans` - List orphan payments
- `GET /admin/debug/recovery-queue` - View recovery queue
- `GET /admin/debug/failed` - List failed payments
- `GET /admin/debug/reconciliation-stats` - Overall stats
- `POST /admin/debug/:paymentId/reconcile` - Manual reconciliation

---

## Sign-off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Developer | | | |
| QA | | | |
| DevOps | | | |
| Product Owner | | | |
