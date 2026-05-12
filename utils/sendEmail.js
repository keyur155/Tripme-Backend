const nodemailer = require('nodemailer');
const https = require('https');

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL TRANSPORT STRATEGY
// Railway (and many cloud platforms) BLOCK outbound SMTP (ports 25, 465, 587).
// Solution: use the Resend API (HTTPS port 443) when RESEND_API_KEY is set.
// Fallback: nodemailer SMTP for local development.
// ─────────────────────────────────────────────────────────────────────────────

// Send via Resend REST API (HTTPS, no SMTP port needed)
const sendViaResend = (to, subject, html) =>
  new Promise((resolve, reject) => {
    const from =
      process.env.RESEND_FROM ||
      'TripMe <onboarding@resend.dev>';

    console.log('📧 ═══════════════════════════════════════');
    console.log('📧 RESEND EMAIL ATTEMPT');
    console.log('📧 To:', to);
    console.log('📧 From:', from);
    console.log('📧 Subject:', subject);
    console.log('📧 API Key present:', !!process.env.RESEND_API_KEY);
    console.log('📧 API Key prefix:', process.env.RESEND_API_KEY?.substring(0, 10) + '...');
    console.log('📧 ═══════════════════════════════════════');

    const payload = JSON.stringify({ from, to, subject, html });
    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log('📧 Resend response status:', res.statusCode);
        console.log('📧 Resend response body:', data);
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log('📧 ✅ Email sent successfully via Resend! ID:', parsed.id);
            resolve({ messageId: parsed.id, accepted: [to], rejected: [] });
          } else {
            console.log('📧 ❌ Resend API rejected:', parsed.message || data);
            reject(new Error(`Resend API error ${res.statusCode}: ${data}`));
          }
        } catch (e) {
          console.log('📧 ❌ Failed to parse Resend response:', data);
          reject(new Error('Failed to parse Resend API response'));
        }
      });
    });
    req.on('error', (err) => {
      console.log('📧 ❌ Network error calling Resend:', err.message);
      reject(err);
    });
    req.write(payload);
    req.end();
  });

// Create nodemailer SMTP transporter (for local dev)
const createTransporter = () => {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    tls: {
      rejectUnauthorized: false
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// SHARED LAYOUT — wraps every email for consistent branding
// ─────────────────────────────────────────────────────────────────────────────

const BRAND = {
  name: 'TripMe',
  color: '#4F46E5',       // indigo-600
  colorDark: '#3730A3',   // indigo-800
  colorLight: '#EEF2FF',  // indigo-50
  accent: '#10B981',      // emerald-500
  warning: '#F59E0B',     // amber-500
  danger: '#EF4444',      // red-500
  text: '#1F2937',        // gray-800
  textMuted: '#6B7280',   // gray-500
  bg: '#F9FAFB',          // gray-50
  cardBg: '#FFFFFF',
  border: '#E5E7EB',      // gray-200
  year: new Date().getFullYear(),
};

const wrapLayout = (headerBg, headerIcon, headerTitle, headerSub, bodyHtml) => `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${BRAND.cardBg};border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr><td style="background:${headerBg};padding:36px 32px;text-align:center;">
          <div style="font-size:40px;margin-bottom:12px;">${headerIcon}</div>
          <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;letter-spacing:-0.3px;">${headerTitle}</h1>
          ${headerSub ? `<p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:15px;">${headerSub}</p>` : ''}
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:36px 32px;">
          ${bodyHtml}
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:${BRAND.bg};padding:24px 32px;text-align:center;border-top:1px solid ${BRAND.border};">
          <p style="color:${BRAND.textMuted};margin:0 0 6px;font-size:13px;">This is an automated email from <strong>${BRAND.name}</strong></p>
          <p style="color:${BRAND.textMuted};margin:0;font-size:12px;">&copy; ${BRAND.year} TripMe Global. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

// Reusable components
const greeting = (name) => `<h2 style="color:${BRAND.text};margin:0 0 16px;font-size:20px;font-weight:600;">Hello ${name},</h2>`;

const paragraph = (text) => `<p style="color:${BRAND.text};font-size:15px;line-height:1.7;margin:0 0 16px;">${text}</p>`;

const ctaButton = (url, label, bg = BRAND.color) => `
<div style="text-align:center;margin:28px 0;">
  <a href="${url}" style="background:${bg};color:#ffffff;padding:14px 36px;text-decoration:none;border-radius:8px;display:inline-block;font-size:15px;font-weight:600;">${label}</a>
</div>`;

const infoCard = (borderColor, rows) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};border-radius:12px;border-left:4px solid ${borderColor};margin:20px 0;">
  <tr><td style="padding:20px 24px;">
    ${rows.map(([label, value]) => `
      <div style="margin-bottom:12px;">
        <span style="color:${BRAND.textMuted};font-size:12px;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:2px;">${label}</span>
        <span style="color:${BRAND.text};font-size:15px;font-weight:500;">${value}</span>
      </div>`).join('')}
  </td></tr>
</table>`;

const alertBox = (bg, borderColor, textColor, icon, title, message) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border:1px solid ${borderColor};border-radius:10px;margin:20px 0;">
  <tr><td style="padding:18px 22px;">
    <p style="color:${textColor};font-size:15px;font-weight:600;margin:0 0 6px;">${icon} ${title}</p>
    <p style="color:${textColor};font-size:14px;line-height:1.6;margin:0;">${message}</p>
  </td></tr>
</table>`;

const divider = () => `<hr style="border:none;border-top:1px solid ${BRAND.border};margin:24px 0;">`;

const formatCurrency = (amount) => `₹${Number(amount).toLocaleString('en-IN')}`;

const formatDate = (date) => {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
};

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

const emailTemplates = {

  // ── 1. Welcome / Email Verification ──────────────────────────────────────
  welcome: (userName, verificationLink) => ({
    subject: 'Welcome to TripMe — Verify Your Email',
    html: wrapLayout(
      BRAND.color, '✨', 'Welcome to TripMe!', 'Your adventure begins here',
      greeting(userName) +
      paragraph('Thank you for joining our community! We\'re thrilled to have you. To unlock all features and start exploring amazing stays, please verify your email address.') +
      ctaButton(verificationLink, 'Verify My Email') +
      alertBox('#FEF3C7', '#FDE68A', '#92400E', '⏳', 'Link expires in 24 hours',
        'If the button doesn\'t work, copy and paste this URL into your browser:') +
      `<p style="word-break:break-all;color:${BRAND.color};font-size:13px;font-family:monospace;background:${BRAND.colorLight};padding:12px;border-radius:8px;margin:0 0 20px;">${verificationLink}</p>` +
      divider() +
      paragraph('If you didn\'t create this account, please ignore this email.')
    )
  }),

  // ── 2. Password Reset ───────────────────────────────────────────────────
  passwordReset: (userName, resetLink) => ({
    subject: 'Reset Your TripMe Password',
    html: wrapLayout(
      BRAND.danger, '🔐', 'Password Reset Request', 'Secure your account',
      greeting(userName) +
      paragraph('We received a request to reset your password. Click the button below to create a new secure password.') +
      ctaButton(resetLink, 'Reset My Password', BRAND.danger) +
      alertBox('#FEF2F2', '#FECACA', '#991B1B', '🔒', 'Security Notice',
        'This link expires in 1 hour. If you didn\'t request this, your password remains unchanged — no action needed.') +
      `<p style="word-break:break-all;color:${BRAND.textMuted};font-size:13px;font-family:monospace;background:${BRAND.bg};padding:12px;border-radius:8px;margin:0 0 20px;">${resetLink}</p>` +
      divider() +
      paragraph('If you suspect unauthorized access, contact support immediately.')
    )
  }),

  // ── 3. Email Verified Successfully ──────────────────────────────────────
  emailVerified: (userName) => ({
    subject: 'Email Verified — Welcome Aboard!',
    html: wrapLayout(
      BRAND.accent, '✅', 'Email Verified!', 'You\'re all set',
      greeting(userName) +
      paragraph('Your email has been successfully verified. You now have full access to TripMe — browse properties, book stays, and explore experiences.') +
      alertBox('#ECFDF5', '#A7F3D0', '#065F46', '🚀', 'What\'s Next?',
        'Explore trending destinations, book your dream stay, or become a host and start earning.') +
      ctaButton(`${process.env.FRONTEND_URL?.split(',')[0] || 'https://tripmeglobal.com'}`, 'Explore TripMe', BRAND.accent)
    )
  }),

  // ── 4. Booking Confirmation (to Guest) ──────────────────────────────────
  bookingConfirmation: (userName, details) => ({
    subject: `Booking Request Submitted — ${details.propertyName}`,
    html: wrapLayout(
      BRAND.color, '🎉', 'Booking Request Submitted!', 'Your adventure awaits',
      greeting(userName) +
      paragraph('Your booking request has been submitted and payment processed. The host will review and confirm your booking shortly.') +
      infoCard(BRAND.color, [
        ['Property', details.propertyName],
        ['Booking ID', `<code style="background:${BRAND.colorLight};padding:2px 8px;border-radius:4px;font-size:13px;">${details.bookingId}</code>`],
        ['Check-in', `${details.checkIn}${details.checkInTime ? ` at ${details.checkInTime}` : ''}`],
        ['Check-out', `${details.checkOut}${details.checkOutTime ? ` at ${details.checkOutTime}` : ''}`],
        ...(details.hourlyExtension ? [['Hourly Extension', `+${details.hourlyExtension} hours`]] : []),
        ['Guests', details.guests],
        ['Total Amount', `<strong style="color:${BRAND.accent};font-size:18px;">${details.currency === 'INR' ? '₹' : details.currency || '₹'}${details.totalAmount}</strong>`],
      ]) +
      alertBox('#FEF3C7', '#FDE68A', '#92400E', '⏳', 'Pending Host Approval',
        'We\'ll notify you via email once the host accepts your booking. You can also check the status in your dashboard.')
    )
  }),

  // ── 5. New Booking Notification (to Host) ───────────────────────────────
  newBookingNotification: (userName, details) => ({
    subject: `New Booking Request — ${details.propertyName}`,
    html: wrapLayout(
      BRAND.accent, '🏠', 'New Booking Request!', 'A guest wants to book your property',
      greeting(userName) +
      paragraph(`<strong>${details.guestName}</strong> has requested to book your property. Please review and respond within 24 hours.`) +
      infoCard(BRAND.accent, [
        ['Property', details.propertyName],
        ['Guest', details.guestName],
        ['Booking ID', `<code style="background:#ECFDF5;padding:2px 8px;border-radius:4px;font-size:13px;">${details.bookingId}</code>`],
        ['Check-in', `${details.checkIn}${details.checkInTime ? ` at ${details.checkInTime}` : ''}`],
        ['Check-out', `${details.checkOut}${details.checkOutTime ? ` at ${details.checkOutTime}` : ''}`],
        ...(details.hourlyExtension ? [['Hourly Extension', `+${details.hourlyExtension} hours`]] : []),
        ['Guests', details.guests],
        ['Total Amount', `<strong style="color:${BRAND.accent};font-size:18px;">${details.currency === 'INR' ? '₹' : details.currency || '₹'}${details.totalAmount}</strong>`],
        ...(details.specialRequests ? [['Special Requests', details.specialRequests]] : []),
      ]) +
      alertBox('#ECFDF5', '#A7F3D0', '#065F46', '⚡', 'Action Required',
        'Log in to your host dashboard to accept or decline this booking. If no action is taken within 24 hours, the booking will expire.') +
      ctaButton(`${process.env.FRONTEND_URL?.split(',')[0] || 'https://tripmeglobal.com'}/host/bookings`, 'View in Dashboard', BRAND.accent)
    )
  }),

  // ── 6. Host Confirmed Booking ───────────────────────────────────────────
  hostConfirmedBooking: (userName, details) => ({
    subject: `Booking Confirmed — ${details.propertyName}`,
    html: wrapLayout(
      BRAND.accent, '✅', 'Booking Confirmed!', 'Your host has accepted your booking',
      greeting(userName) +
      paragraph('Great news! Your host has confirmed your booking. Your stay is now officially reserved.') +
      infoCard(BRAND.accent, [
        ['Property', details.propertyName],
        ['Booking ID', details.bookingId],
        ['Check-in', `${details.checkIn}${details.checkInTime ? ` at ${details.checkInTime}` : ''}`],
        ['Check-out', `${details.checkOut}${details.checkOutTime ? ` at ${details.checkOutTime}` : ''}`],
        ['Total Amount', `<strong style="color:${BRAND.accent};">₹${details.totalAmount}</strong>`],
      ]) +
      alertBox('#ECFDF5', '#A7F3D0', '#065F46', '📋', 'Preparation Tips',
        'Arrive at the check-in time specified. Contact your host directly for any special arrangements. Keep your booking ID handy.')
    )
  }),

  // ── 7. Host Cancelled Booking ───────────────────────────────────────────
  hostCancelledBooking: (userName, details) => ({
    subject: `Booking Cancelled by Host — ${details.propertyName}`,
    html: wrapLayout(
      BRAND.danger, '⚠️', 'Booking Cancelled by Host', 'We\'re sorry about this',
      greeting(userName) +
      paragraph('Unfortunately, your host has cancelled this booking. We apologize for the inconvenience.') +
      infoCard(BRAND.danger, [
        ['Property', details.propertyName],
        ['Booking ID', details.bookingId],
        ['Check-in', formatDate(details.checkIn)],
        ['Check-out', formatDate(details.checkOut)],
        ...(details.reason ? [['Cancellation Reason', details.reason]] : []),
      ]) +
      (details.refundAmount > 0
        ? alertBox('#ECFDF5', '#A7F3D0', '#065F46', '💰', `Refund: ₹${details.refundAmount} (${details.refundPercentage}%)`,
            'The refund will be processed to your original payment method within 5-7 business days.')
        : alertBox('#FEF2F2', '#FECACA', '#991B1B', '💳', 'No Refund Applicable',
            'Based on the cancellation policy, no refund is available for this booking.')) +
      paragraph('Need help finding an alternative? Contact our support team — we\'re here to assist.')
    )
  }),

  // ── 8. Guest Cancellation ───────────────────────────────────────────────
  bookingCancellation: (userName, details) => ({
    subject: `Booking Cancelled — ${details.propertyName}`,
    html: wrapLayout(
      '#6B7280', '🚫', 'Booking Cancelled', 'Your booking has been cancelled',
      greeting(userName) +
      paragraph('Your booking has been successfully cancelled as requested.') +
      infoCard('#6B7280', [
        ['Property', details.propertyName],
        ['Booking ID', details.bookingId],
        ['Check-in', formatDate(details.checkIn)],
        ['Check-out', formatDate(details.checkOut)],
      ]) +
      (details.refundAmount > 0
        ? alertBox('#ECFDF5', '#A7F3D0', '#065F46', '💰', `Refund: ₹${details.refundAmount} (${details.refundPercentage}%)`,
            'The refund will be processed to your original payment method within 5-7 business days.')
        : alertBox('#FEF3C7', '#FDE68A', '#92400E', '💳', 'No Refund Available',
            'Based on the cancellation policy, no refund is applicable for this cancellation.')) +
      paragraph('We hope to see you again soon! Explore other amazing stays on TripMe.')
    )
  }),

  // ── 9. Host Completed Booking ───────────────────────────────────────────
  hostCompletedBooking: (userName, details) => ({
    subject: `Stay Completed — ${details.propertyName}`,
    html: wrapLayout(
      BRAND.color, '🏁', 'Stay Completed!', 'We hope you had a wonderful time',
      greeting(userName) +
      paragraph('Your host has marked your stay as completed. We hope you had an amazing experience!') +
      infoCard(BRAND.color, [
        ['Property', details.propertyName],
        ['Booking ID', details.bookingId],
        ['Check-in', formatDate(details.checkIn)],
        ['Check-out', formatDate(details.checkOut)],
      ]) +
      alertBox(BRAND.colorLight, '#C7D2FE', BRAND.colorDark, '⭐', 'Share Your Experience',
        'Your review helps other travelers and supports your host. It only takes a minute!') +
      ctaButton(`${process.env.FRONTEND_URL?.split(',')[0] || 'https://tripmeglobal.com'}/bookings/${details.bookingId}`, 'Leave a Review')
    )
  }),

  // ── 10. Host Check-in Guest ─────────────────────────────────────────────
  hostCheckInGuest: (userName, details) => ({
    subject: `Checked In — ${details.propertyName}`,
    html: wrapLayout(
      BRAND.accent, '🏠', 'You\'re Checked In!', 'Enjoy your stay',
      greeting(userName) +
      paragraph('Your host has confirmed your check-in. Welcome to your stay!') +
      infoCard(BRAND.accent, [
        ['Property', details.propertyName],
        ['Booking ID', details.bookingId],
        ['Check-in Date', formatDate(details.checkInDate)],
        ...(details.checkInTime ? [['Check-in Time', details.checkInTime]] : []),
        ...(details.notes ? [['Host Notes', details.notes]] : []),
      ]) +
      alertBox('#ECFDF5', '#A7F3D0', '#065F46', '🎯', 'Enjoy Your Stay!',
        'If you need anything during your stay, don\'t hesitate to contact your host. Have a wonderful time!')
    )
  }),

  // ── 11. Host Status Update ──────────────────────────────────────────────
  hostStatusUpdate: (userName, details) => ({
    subject: `Booking Status Updated — ${details.propertyName}`,
    html: wrapLayout(
      BRAND.warning, '🔄', 'Booking Status Updated', 'Your host made a change',
      greeting(userName) +
      paragraph('Your host has updated the status of your booking.') +
      infoCard(BRAND.warning, [
        ['Property', details.propertyName],
        ['Booking ID', details.bookingId],
        ['Previous Status', `<span style="text-transform:capitalize;">${details.previousStatus}</span>`],
        ['New Status', `<strong style="color:${BRAND.warning};text-transform:capitalize;">${details.newStatus}</strong>`],
        ...(details.reason ? [['Reason', details.reason]] : []),
      ]) +
      paragraph('If you have questions about this update, contact your host or our support team.')
    )
  }),

  // ── 12. Payment Success ─────────────────────────────────────────────────
  paymentSuccess: (userName, details) => ({
    subject: `Payment Successful — ${formatCurrency(details.amount)}`,
    html: wrapLayout(
      BRAND.accent, '💳', 'Payment Successful!', 'Transaction confirmed',
      greeting(userName) +
      paragraph('Your payment has been processed successfully. Here\'s your transaction summary.') +
      infoCard(BRAND.accent, [
        ['Amount Paid', `<strong style="color:${BRAND.accent};font-size:18px;">${formatCurrency(details.amount)}</strong>`],
        ['Transaction ID', `<code style="background:#ECFDF5;padding:2px 8px;border-radius:4px;font-size:13px;">${details.transactionId}</code>`],
        ['Payment Method', details.paymentMethod],
        ['Date', details.date || formatDate(new Date())],
        ...(details.bookingId ? [['Booking ID', details.bookingId]] : []),
      ]) +
      paragraph('A detailed receipt is available in your account dashboard. If you have any concerns about this transaction, please reach out to support.')
    )
  }),

  // ── 13. Refund Initiated ────────────────────────────────────────────────
  refundInitiated: (userName, details) => ({
    subject: `Refund Initiated — ${formatCurrency(details.amount)}`,
    html: wrapLayout(
      BRAND.color, '💸', 'Refund Initiated', 'Your refund is being processed',
      greeting(userName) +
      paragraph('We\'ve initiated a refund for your booking. Here are the details.') +
      infoCard(BRAND.color, [
        ['Refund Amount', `<strong style="color:${BRAND.color};font-size:18px;">${formatCurrency(details.amount)}</strong>`],
        ['Booking ID', details.bookingId],
        ['Reason', details.reason || 'Cancellation'],
        ['Refund Reference', details.refundReference || 'N/A'],
        ['Estimated Processing', '5-7 business days'],
      ]) +
      alertBox('#FEF3C7', '#FDE68A', '#92400E', '⏳', 'Processing Time',
        'Refunds typically take 5-7 business days to reflect in your account, depending on your bank or payment provider.')
    )
  }),

  // ── 14. Refund Completed ────────────────────────────────────────────────
  refundCompleted: (userName, details) => ({
    subject: `Refund Completed — ${formatCurrency(details.amount)}`,
    html: wrapLayout(
      BRAND.accent, '✅', 'Refund Completed!', 'Your money is on its way',
      greeting(userName) +
      paragraph('Your refund has been successfully processed. The amount should reflect in your account shortly.') +
      infoCard(BRAND.accent, [
        ['Refund Amount', `<strong style="color:${BRAND.accent};font-size:18px;">${formatCurrency(details.amount)}</strong>`],
        ['Booking ID', details.bookingId],
        ['Refund Reference', details.refundReference || 'N/A'],
      ]) +
      paragraph('If the amount doesn\'t reflect within 7 business days, please contact your bank or our support team.')
    )
  }),

  // ── 15. Payout Completed (to Host) ──────────────────────────────────────
  payoutCompleted: (userName, details) => ({
    subject: `Payout Processed — ${formatCurrency(details.amount)}`,
    html: wrapLayout(
      BRAND.accent, '🏦', 'Payout Processed!', 'Your earnings have been transferred',
      greeting(userName) +
      paragraph('Your host payout has been processed successfully.') +
      infoCard(BRAND.accent, [
        ['Payout Amount', `<strong style="color:${BRAND.accent};font-size:18px;">${formatCurrency(details.amount)}</strong>`],
        ...(details.bookingId ? [['Booking ID', details.bookingId]] : []),
        ...(details.utrNumber ? [['UTR / Transaction ID', details.utrNumber]] : []),
        ['Processed Date', formatDate(details.processedDate || new Date())],
      ]) +
      paragraph('The amount will reflect in your bank account within 1-2 business days. You can view payout details in your host dashboard.')
    )
  }),

  // ── 16. KYC Submitted ───────────────────────────────────────────────────
  kycSubmitted: (userName) => ({
    subject: 'KYC Documents Received — Under Review',
    html: wrapLayout(
      BRAND.color, '📄', 'KYC Documents Received', 'We\'re reviewing your documents',
      greeting(userName) +
      paragraph('We\'ve received your KYC documents and they are now under review. Our team typically completes verification within 24-48 hours.') +
      alertBox(BRAND.colorLight, '#C7D2FE', BRAND.colorDark, '⏳', 'What to Expect',
        'You\'ll receive an email notification once your documents are verified. In the meantime, you can continue using TripMe with limited features.') +
      divider() +
      paragraph('If we need additional information, we\'ll reach out to you via email.')
    )
  }),

  // ── 17. KYC Approved ────────────────────────────────────────────────────
  kycApproved: (userName) => ({
    subject: 'KYC Verified — You\'re All Set!',
    html: wrapLayout(
      BRAND.accent, '✅', 'KYC Verified!', 'Your identity has been confirmed',
      greeting(userName) +
      paragraph('Congratulations! Your KYC has been successfully verified. You now have full access to all TripMe features including becoming a host.') +
      alertBox('#ECFDF5', '#A7F3D0', '#065F46', '🚀', 'Unlocked Features',
        'You can now create property listings, offer services, and start earning as a host on TripMe.') +
      ctaButton(`${process.env.FRONTEND_URL?.split(',')[0] || 'https://tripmeglobal.com'}/become-host/onboarding/step-1`, 'Start Hosting', BRAND.accent)
    )
  }),

  // ── 18. KYC Rejected ────────────────────────────────────────────────────
  kycRejected: (userName, details) => ({
    subject: 'KYC Verification Unsuccessful',
    html: wrapLayout(
      BRAND.danger, '❌', 'KYC Verification Unsuccessful', 'Action required',
      greeting(userName) +
      paragraph('Unfortunately, your KYC verification was not successful. Please review the details below and resubmit.') +
      alertBox('#FEF2F2', '#FECACA', '#991B1B', '📋', 'Reason for Rejection',
        details.rejectionReason || 'Documents could not be verified. Please ensure all documents are clear, valid, and match your profile information.') +
      ctaButton(`${process.env.FRONTEND_URL?.split(',')[0] || 'https://tripmeglobal.com'}/user/kyc`, 'Resubmit Documents', BRAND.danger) +
      divider() +
      paragraph('If you believe this was a mistake, please contact our support team with your details.')
    )
  }),

  // ── 19. New Review Received (to Host) ───────────────────────────────────
  newReview: (userName, details) => ({
    subject: `New ${details.rating}★ Review — ${details.propertyName}`,
    html: wrapLayout(
      '#F59E0B', '⭐', 'New Review Received!', 'See what your guest said',
      greeting(userName) +
      paragraph('You\'ve received a new review for your property. Guest feedback helps you grow as a host!') +
      infoCard('#F59E0B', [
        ['Property', details.propertyName],
        ['Rating', `${'★'.repeat(Math.round(details.rating))}${'☆'.repeat(5 - Math.round(details.rating))} (${details.rating}/5)`],
        ['Review', `"${details.comment}"`],
        ['Reviewer', details.reviewerName],
      ]) +
      paragraph('You can respond to this review from your host dashboard.') +
      ctaButton(`${process.env.FRONTEND_URL?.split(',')[0] || 'https://tripmeglobal.com'}/hosting`, 'View Review')
    )
  }),

  // ── 20. Support Ticket Confirmation ─────────────────────────────────────
  supportTicket: (userName, details) => ({
    subject: `Support Ticket #${details.ticketId} — Received`,
    html: wrapLayout(
      '#6366F1', '🎧', 'Support Ticket Received', 'We\'re on it',
      greeting(userName) +
      paragraph('We\'ve received your support request and our team is looking into it. You\'ll receive updates as we work on your case.') +
      infoCard('#6366F1', [
        ['Ticket ID', `<code style="background:${BRAND.colorLight};padding:2px 8px;border-radius:4px;">${details.ticketId}</code>`],
        ['Subject', details.subject],
        ['Priority', `<span style="text-transform:capitalize;">${details.priority}</span>`],
        ['Status', details.status || 'Open'],
      ]) +
      alertBox(BRAND.colorLight, '#C7D2FE', BRAND.colorDark, '⏱️', 'Response Time',
        'We typically respond within 24 hours. For urgent issues, please mention it in your ticket.')
    )
  }),

  // ── 21. Account Suspended ───────────────────────────────────────────────
  accountSuspended: (userName, details) => ({
    subject: 'Account Suspended — TripMe',
    html: wrapLayout(
      BRAND.danger, '🚫', 'Account Suspended', 'Action required',
      greeting(userName) +
      paragraph('Your TripMe account has been suspended by our administration team.') +
      infoCard(BRAND.danger, [
        ['Reason', details.reason || 'Policy violation'],
        ['Date', formatDate(new Date())],
        ['Status', '<strong style="color:#EF4444;">Suspended</strong>'],
      ]) +
      alertBox('#FEF2F2', '#FECACA', '#991B1B', '⚠️', 'What This Means',
        'You cannot make bookings, list properties, or access certain platform features during the suspension period.') +
      divider() +
      paragraph('If you believe this was a mistake, please contact our support team.')
    )
  }),

  // ── 22. Account Activated ───────────────────────────────────────────────
  accountActivated: (userName) => ({
    subject: 'Account Reactivated — Welcome Back!',
    html: wrapLayout(
      BRAND.accent, '🎉', 'Account Reactivated!', 'Welcome back to TripMe',
      greeting(userName) +
      paragraph('Great news! Your TripMe account has been reactivated. You now have full access to all platform features.') +
      alertBox('#ECFDF5', '#A7F3D0', '#065F46', '✅', 'Full Access Restored',
        'You can make bookings, list properties, and access all TripMe features again.') +
      ctaButton(`${process.env.FRONTEND_URL?.split(',')[0] || 'https://tripmeglobal.com'}`, 'Back to TripMe', BRAND.accent)
    )
  }),

  // ── 23. Email Subscription (Admin Notification) ─────────────────────────
  emailSubscription: (subscriberEmail, subscriberName, userDetails) => ({
    subject: `New Email Subscriber — ${subscriberEmail}`,
    html: wrapLayout(
      BRAND.color, '📬', 'New Email Subscriber', 'Someone joined the mailing list',
      `<h2 style="color:${BRAND.text};margin:0 0 16px;font-size:20px;">Subscription Details</h2>` +
      infoCard(BRAND.color, [
        ['Email', subscriberEmail],
        ['Name', subscriberName || 'Not provided'],
        ['Date', formatDate(new Date())],
        ...(userDetails ? [
          ['Registered User', 'Yes'],
          ['User ID', userDetails._id],
          ['User Name', userDetails.name],
        ] : [['Registered User', 'No (guest visitor)']]),
      ])
    )
  }),

  // ── 24. Newsletter ──────────────────────────────────────────────────────
  newsletter: (userName, content) => ({
    subject: 'TripMe Newsletter',
    html: wrapLayout(
      BRAND.color, '📰', 'TripMe Newsletter', 'Your travel digest',
      greeting(userName) +
      `<div style="color:${BRAND.text};font-size:15px;line-height:1.7;">${content}</div>`
    )
  }),

  // ── 25. Booking Rejected by Host ────────────────────────────────────────
  bookingRejected: (userName, details) => ({
    subject: `Booking Declined — ${details.propertyName}`,
    html: wrapLayout(
      '#6B7280', '😔', 'Booking Request Declined', 'The host couldn\'t accommodate your request',
      greeting(userName) +
      paragraph('Unfortunately, the host has declined your booking request. Don\'t worry — there are plenty of other amazing stays available!') +
      infoCard('#6B7280', [
        ['Property', details.propertyName],
        ['Booking ID', details.bookingId],
        ['Check-in', formatDate(details.checkIn)],
        ['Check-out', formatDate(details.checkOut)],
        ...(details.reason ? [['Reason', details.reason]] : []),
      ]) +
      (details.refundAmount > 0
        ? alertBox('#ECFDF5', '#A7F3D0', '#065F46', '💰', `Refund: ₹${details.refundAmount}`,
            'The full refund will be processed to your original payment method within 5-7 business days.')
        : '') +
      ctaButton(`${process.env.FRONTEND_URL?.split(',')[0] || 'https://tripmeglobal.com'}/search`, 'Explore Other Stays')
    )
  }),

  // ── 26. Host Became Approved ────────────────────────────────────────────
  hostApproved: (userName) => ({
    subject: 'You\'re Now a TripMe Host!',
    html: wrapLayout(
      BRAND.accent, '🏡', 'Congratulations, Host!', 'You\'re approved to host on TripMe',
      greeting(userName) +
      paragraph('Your host application has been approved! You can now create property listings, offer services, and start earning on TripMe.') +
      alertBox('#ECFDF5', '#A7F3D0', '#065F46', '🎯', 'Get Started',
        'Create your first listing, set your availability and pricing, and welcome your first guests!') +
      ctaButton(`${process.env.FRONTEND_URL?.split(',')[0] || 'https://tripmeglobal.com'}/host/property/new/about-your-place`, 'Create Your First Listing', BRAND.accent)
    )
  }),

  // ── 27. Host Application Rejected ───────────────────────────────────────
  hostRejected: (userName, details) => ({
    subject: 'Host Application Update',
    html: wrapLayout(
      BRAND.danger, '📋', 'Host Application Update', 'Additional steps needed',
      greeting(userName) +
      paragraph('We\'ve reviewed your host application and unfortunately cannot approve it at this time.') +
      alertBox('#FEF2F2', '#FECACA', '#991B1B', '📋', 'Reason',
        details.reason || 'Please ensure all required documents and information are submitted correctly.') +
      divider() +
      paragraph('You can update your information and re-apply. If you have questions, our support team is happy to help.')
    )
  }),
};

// ─────────────────────────────────────────────────────────────────────────────
// SEND EMAIL — core dispatcher
// ─────────────────────────────────────────────────────────────────────────────

const sendEmail = async (to, template, data = {}) => {
  try {
    if (!emailTemplates[template]) {
      console.error(`Email template '${template}' not found. Available:`, Object.keys(emailTemplates));
      throw new Error(`Email template '${template}' not found`);
    }

    let emailContent;
    if (template === 'welcome') {
      emailContent = emailTemplates[template](data.userName || 'User', data.link);
    } else if (template === 'passwordReset') {
      emailContent = emailTemplates[template](data.userName || 'User', data.link);
    } else if (template === 'emailVerified' || template === 'kycSubmitted' || template === 'kycApproved' || template === 'accountActivated') {
      emailContent = emailTemplates[template](data.userName || 'User');
    } else if (template === 'emailSubscription') {
      emailContent = emailTemplates[template](data.subscriberEmail || data.email, data.subscriberName || data.name, data.userDetails);
    } else if (template === 'hostApproved') {
      emailContent = emailTemplates[template](data.userName || 'User');
    } else {
      emailContent = emailTemplates[template](data.userName || 'User', data);
    }

    // ── Priority 1: Resend API ──────────────────────────────────────────
    if (process.env.RESEND_API_KEY) {
      console.log(`Sending email via Resend API to: ${to} [${template}]`);
      return await sendViaResend(to, emailContent.subject, emailContent.html);
    }

    // ── Priority 2: nodemailer SMTP ─────────────────────────────────────
    const transporter = createTransporter();
    if (!transporter) {
      console.warn(`No email transport configured. Email skipped: [${template}] -> ${to}`);
      return { messageId: `skipped-${Date.now()}`, accepted: [to], rejected: [] };
    }

    const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@tripme.com';
    const mailOptions = {
      from: `"TripMe" <${fromAddress}>`,
      to,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.html.replace(/<[^>]*>/g, ''),
    };

    const result = await transporter.sendMail(mailOptions);
    return result;
  } catch (error) {
    console.error(`Error sending email [${template}] to ${to}:`, error.message);
    return { messageId: `error-${Date.now()}`, accepted: [], rejected: [to], error: error.message };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CONVENIENCE WRAPPERS
// ─────────────────────────────────────────────────────────────────────────────

const sendWelcomeEmail = async (email, userName, verificationLink) =>
  sendEmail(email, 'welcome', { userName, link: verificationLink });

const sendPasswordResetEmail = async (email, userName, resetLink) =>
  sendEmail(email, 'passwordReset', { userName, link: resetLink });

const sendEmailVerifiedEmail = async (email, userName) =>
  sendEmail(email, 'emailVerified', { userName });

const sendBookingConfirmationEmail = async (email, userName, bookingDetails) =>
  sendEmail(email, 'bookingConfirmation', { userName, ...bookingDetails });

const sendNewBookingNotificationEmail = async (email, userName, bookingDetails) =>
  sendEmail(email, 'newBookingNotification', { userName, ...bookingDetails });

const sendBookingCancellationEmail = async (email, userName, bookingDetails) =>
  sendEmail(email, 'bookingCancellation', { userName, ...bookingDetails });

const sendBookingRejectedEmail = async (email, userName, bookingDetails) =>
  sendEmail(email, 'bookingRejected', { userName, ...bookingDetails });

const sendHostConfirmedBookingEmail = async (email, userName, confirmationDetails) =>
  sendEmail(email, 'hostConfirmedBooking', { userName, ...confirmationDetails });

const sendHostCancelledBookingEmail = async (email, userName, cancellationDetails) =>
  sendEmail(email, 'hostCancelledBooking', { userName, ...cancellationDetails });

const sendHostCompletedBookingEmail = async (email, userName, completionDetails) =>
  sendEmail(email, 'hostCompletedBooking', { userName, ...completionDetails });

const sendHostCheckInGuestEmail = async (email, userName, checkInDetails) =>
  sendEmail(email, 'hostCheckInGuest', { userName, ...checkInDetails });

const sendHostStatusUpdateEmail = async (email, userName, statusDetails) =>
  sendEmail(email, 'hostStatusUpdate', { userName, ...statusDetails });

const sendPaymentSuccessEmail = async (email, userName, paymentDetails) =>
  sendEmail(email, 'paymentSuccess', { userName, ...paymentDetails });

const sendRefundInitiatedEmail = async (email, userName, refundDetails) =>
  sendEmail(email, 'refundInitiated', { userName, ...refundDetails });

const sendRefundCompletedEmail = async (email, userName, refundDetails) =>
  sendEmail(email, 'refundCompleted', { userName, ...refundDetails });

const sendPayoutCompletedEmail = async (email, userName, payoutDetails) =>
  sendEmail(email, 'payoutCompleted', { userName, ...payoutDetails });

const sendKycSubmittedEmail = async (email, userName) =>
  sendEmail(email, 'kycSubmitted', { userName });

const sendKycApprovedEmail = async (email, userName) =>
  sendEmail(email, 'kycApproved', { userName });

const sendKycRejectedEmail = async (email, userName, details) =>
  sendEmail(email, 'kycRejected', { userName, ...details });

const sendNewReviewEmail = async (email, userName, reviewDetails) =>
  sendEmail(email, 'newReview', { userName, ...reviewDetails });

const sendSupportTicketEmail = async (email, userName, ticketDetails) =>
  sendEmail(email, 'supportTicket', { userName, ...ticketDetails });

const sendAccountSuspendedEmail = async (email, userName, suspensionDetails) =>
  sendEmail(email, 'accountSuspended', { userName, ...suspensionDetails });

const sendAccountActivatedEmail = async (email, userName) =>
  sendEmail(email, 'accountActivated', { userName });

const sendHostApprovedEmail = async (email, userName) =>
  sendEmail(email, 'hostApproved', { userName });

const sendHostRejectedEmail = async (email, userName, details) =>
  sendEmail(email, 'hostRejected', { userName, ...details });

const sendNewsletterEmail = async (email, userName, content) =>
  sendEmail(email, 'newsletter', { userName, content });

const sendCustomEmail = async (to, subject, htmlContent, textContent = null) => {
  try {
    if (process.env.RESEND_API_KEY) {
      return await sendViaResend(to, subject, htmlContent);
    }

    const transporter = createTransporter();
    if (!transporter) {
      return { messageId: `skipped-custom-${Date.now()}`, accepted: [to], rejected: [] };
    }

    const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@tripme.com';
    const result = await transporter.sendMail({
      from: `"TripMe" <${fromAddress}>`,
      to,
      subject,
      html: htmlContent,
      text: textContent || htmlContent.replace(/<[^>]*>/g, ''),
    });
    return result;
  } catch (error) {
    console.error('Error sending custom email:', error);
    return { messageId: `error-custom-${Date.now()}`, accepted: [], rejected: [to], error: error.message };
  }
};

const sendBulkEmails = async (recipients, template, data = {}) => {
  for (const recipient of recipients) {
    try {
      await sendEmail(recipient.email, template, {
        ...data,
        userName: recipient.name || 'User'
      });
    } catch (error) {
      console.error('Error sending bulk email:', error);
    }
  }
};

const verifyEmailConfig = async () => {
  try {
    const transporter = createTransporter();
    if (!transporter) return true;
    await transporter.verify();
    return true;
  } catch (error) {
    console.error('Error verifying email config:', error);
    return false;
  }
};

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendEmailVerifiedEmail,
  sendBookingConfirmationEmail,
  sendNewBookingNotificationEmail,
  sendBookingCancellationEmail,
  sendBookingRejectedEmail,
  sendHostConfirmedBookingEmail,
  sendHostCancelledBookingEmail,
  sendHostCompletedBookingEmail,
  sendHostCheckInGuestEmail,
  sendHostStatusUpdateEmail,
  sendPaymentSuccessEmail,
  sendRefundInitiatedEmail,
  sendRefundCompletedEmail,
  sendPayoutCompletedEmail,
  sendKycSubmittedEmail,
  sendKycApprovedEmail,
  sendKycRejectedEmail,
  sendNewReviewEmail,
  sendSupportTicketEmail,
  sendAccountSuspendedEmail,
  sendAccountActivatedEmail,
  sendHostApprovedEmail,
  sendHostRejectedEmail,
  sendNewsletterEmail,
  sendCustomEmail,
  sendBulkEmails,
  verifyEmailConfig,
  emailTemplates,
};
