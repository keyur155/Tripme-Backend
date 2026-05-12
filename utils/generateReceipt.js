const generateReceipt = (booking, payment = null, showCommission = false) => {
  const formatCurrency = (amount, currency = 'INR') => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency
    }).format(amount);
  };

  const formatDate = (date) => {
    return new Date(date).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  };

  const formatTime = (timeStr) => {
    if (!timeStr) return null;
    try {
      const [hours, minutes] = timeStr.split(':');
      const h = parseInt(hours);
      const ampm = h >= 12 ? 'PM' : 'AM';
      const formattedHours = h % 12 || 12;
      return `${formattedHours}:${minutes} ${ampm}`;
    } catch (e) {
      return timeStr;
    }
  };

  const receipt = {
    receiptId: booking.receiptId,
    bookingId: booking._id,
    generatedAt: new Date(),
    showCommission,
    
    // Booking Details
    bookingDetails: {
      type: booking.bookingType,
      status: booking.status,
      checkIn: booking.checkIn ? formatDate(booking.checkIn) : null,
      checkOut: booking.checkOut ? formatDate(booking.checkOut) : null,
      checkInTime: formatTime(booking.checkInTime),
      checkOutTime: formatTime(booking.checkOutTime),
      timeSlot: booking.timeSlot ? {
        startTime: new Date(booking.timeSlot.startTime).toLocaleString('en-IN'),
        endTime: new Date(booking.timeSlot.endTime).toLocaleString('en-IN')
      } : null,
      guests: booking.guests,
      specialRequests: booking.specialRequests
    },

    // Property/Service Details
    itemDetails: {
      title: booking.listing?.title || booking.service?.title,
      type: booking.bookingType === 'property' ? 'Property' : 'Service',
      location: booking.listing?.location || booking.service?.location
    },

    // User Details
    userDetails: {
      name: booking.user?.name,
      email: booking.user?.email,
      phone: booking.user?.phone
    },

    // Host Details
    hostDetails: {
      name: booking.host?.name,
      email: booking.host?.email,
      phone: booking.host?.phone
    },

    // Payment Breakdown
    paymentBreakdown: {
      baseAmount: booking.totalAmount + (booking.discountAmount || 0),
      serviceFee: booking.serviceFee || 0,
      cleaningFee: booking.cleaningFee || 0,
      securityDeposit: booking.securityDeposit || 0,
      platformFee: booking.platformFee || 0,
      discountAmount: booking.discountAmount || 0,
      totalAmount: booking.totalAmount,
      currency: booking.currency || 'INR'
    },

    // Commission Breakdown (for hosts)
    commissionBreakdown: {
      hostEarning: booking.hostFee || 0,
      platformCommission: booking.platformFee || 0,
      percentage: {
        host: 85,
        platform: 15
      }
    },

    // Payment Information
    paymentInfo: payment ? {
      status: payment.status,
      method: payment.paymentMethod,
      transactionId: payment.paymentDetails?.transactionId,
      paidAt: payment.createdAt
    } : null,

    // Coupon Information
    couponInfo: booking.couponApplied ? {
      code: booking.couponApplied.code,
      discountType: booking.couponApplied.discountType,
      amount: booking.couponApplied.amount
    } : null,

    // Cancellation Policy
    cancellationPolicy: booking.cancellationPolicy
  };

  return receipt;
};

const generateReceiptHTML = (receipt) => {
  const formatCurrency = (amount, currency = 'INR') => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency
    }).format(amount);
  };

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Receipt - ${receipt.receiptId}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .receipt { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .header { text-align: center; border-bottom: 2px solid #6366f1; padding-bottom: 20px; margin-bottom: 30px; }
        .logo { font-size: 24px; font-weight: bold; color: #6366f1; }
        .receipt-id { font-size: 14px; color: #666; margin-top: 5px; }
        .section { margin-bottom: 25px; }
        .section-title { font-size: 18px; font-weight: bold; color: #333; margin-bottom: 15px; border-bottom: 1px solid #eee; padding-bottom: 5px; }
        .row { display: flex; justify-content: space-between; margin-bottom: 8px; }
        .label { color: #666; }
        .value { font-weight: 600; color: #333; }
        .total { font-size: 18px; font-weight: bold; border-top: 2px solid #eee; padding-top: 15px; margin-top: 15px; }
        .host-earning { background: #f0fdf4; padding: 15px; border-radius: 8px; border-left: 4px solid #22c55e; }
        .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #666; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="receipt">
        <div class="header">
          <div class="logo">TripMe</div>
          <div class="receipt-id">Receipt #${receipt.receiptId}</div>
        </div>

        <div class="section">
          <div class="section-title">Booking Details</div>
          <div class="row">
            <span class="label">Booking ID:</span>
            <span class="value">${receipt.bookingId}</span>
          </div>
          <div class="row">
            <span class="label">Type:</span>
            <span class="value">${receipt.bookingDetails.type}</span>
          </div>
          <div class="row">
            <span class="label">Status:</span>
            <span class="value">${receipt.bookingDetails.status}</span>
          </div>
          ${receipt.bookingDetails.checkIn ? `
          <div class="row">
            <span class="label">Check-in:</span>
            <span class="value">${receipt.bookingDetails.checkIn} ${receipt.bookingDetails.type === 'property' && receipt.bookingDetails.checkInTime ? `(${receipt.bookingDetails.checkInTime})` : ''}</span>
          </div>
          <div class="row">
            <span class="label">Check-out:</span>
            <span class="value">${receipt.bookingDetails.checkOut} ${receipt.bookingDetails.type === 'property' && receipt.bookingDetails.checkOutTime ? `(${receipt.bookingDetails.checkOutTime})` : ''}</span>
          </div>
          ` : ''}
          ${receipt.bookingDetails.type !== 'property' && receipt.bookingDetails.timeSlot ? `
          <div class="row">
            <span class="label">Time Slot:</span>
            <span class="value">${receipt.bookingDetails.timeSlot.startTime} - ${receipt.bookingDetails.timeSlot.endTime}</span>
          </div>
          ` : ''}
          <div class="row">
            <span class="label">Guests:</span>
            <span class="value">${receipt.bookingDetails.guests.adults} adults, ${receipt.bookingDetails.guests.children} children, ${receipt.bookingDetails.guests.infants} infants</span>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Item Details</div>
          <div class="row">
            <span class="label">Title:</span>
            <span class="value">${receipt.itemDetails.title}</span>
          </div>
          <div class="row">
            <span class="label">Type:</span>
            <span class="value">${receipt.itemDetails.type}</span>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Payment Breakdown</div>
          <div class="row">
            <span class="label">Base Amount:</span>
            <span class="value">${formatCurrency(receipt.paymentBreakdown.baseAmount, receipt.paymentBreakdown.currency)}</span>
          </div>
          ${receipt.paymentBreakdown.serviceFee > 0 ? `
          <div class="row">
            <span class="label">Service Fee:</span>
            <span class="value">${formatCurrency(receipt.paymentBreakdown.serviceFee, receipt.paymentBreakdown.currency)}</span>
          </div>
          ` : ''}
          ${receipt.paymentBreakdown.cleaningFee > 0 ? `
          <div class="row">
            <span class="label">Cleaning Fee:</span>
            <span class="value">${formatCurrency(receipt.paymentBreakdown.cleaningFee, receipt.paymentBreakdown.currency)}</span>
          </div>
          ` : ''}
          ${receipt.paymentBreakdown.securityDeposit > 0 ? `
          <div class="row">
            <span class="label">Security Deposit:</span>
            <span class="value">${formatCurrency(receipt.paymentBreakdown.securityDeposit, receipt.paymentBreakdown.currency)}</span>
          </div>
          ` : ''}
          ${receipt.showCommission && receipt.paymentBreakdown.platformFee > 0 ? `
          <div class="row">
            <span class="label">Platform Fee (15%):</span>
            <span class="value">${formatCurrency(receipt.paymentBreakdown.platformFee, receipt.paymentBreakdown.currency)}</span>
          </div>
          ` : ''}
          ${receipt.paymentBreakdown.discountAmount > 0 ? `
          <div class="row">
            <span class="label">Discount:</span>
            <span class="value" style="color: #22c55e;">-${formatCurrency(receipt.paymentBreakdown.discountAmount, receipt.paymentBreakdown.currency)}</span>
          </div>
          ` : ''}
          <div class="row total">
            <span class="label">Total Amount:</span>
            <span class="value">${formatCurrency(receipt.paymentBreakdown.totalAmount, receipt.paymentBreakdown.currency)}</span>
          </div>
        </div>

        ${receipt.showCommission && receipt.commissionBreakdown.hostEarning > 0 ? `
        <div class="section">
          <div class="section-title">Host Earning</div>
          <div class="host-earning">
            <div class="row">
              <span class="label">Your Earning (85%):</span>
              <span class="value" style="color: #22c55e;">${formatCurrency(receipt.commissionBreakdown.hostEarning, receipt.paymentBreakdown.currency)}</span>
            </div>
            <div class="row">
              <span class="label">Platform Commission (15%):</span>
              <span class="value">${formatCurrency(receipt.commissionBreakdown.platformCommission, receipt.paymentBreakdown.currency)}</span>
            </div>
          </div>
        </div>
        ` : ''}

        <div class="footer">
          <p>Thank you for choosing TripMe!</p>
          <p>Generated on ${new Date(receipt.generatedAt).toLocaleString('en-IN')}</p>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = {
  generateReceipt,
  generateReceiptHTML
}; 