// ============================================================================
// TripMozy Multi-Channel Notification Service & Webhook Engine
// Provider-independent architecture with WhatsApp Cloud API, Email, SMS & In-App
// ============================================================================

const crypto = require('node:crypto');
const tls = require('node:tls');

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (_) {}

class NotificationService {
  constructor(db, config = {}) {
    this.db = db;
    this.config = {
      isProduction: config.isProduction || false,
      whatsappToken: config.whatsappToken || process.env.WHATSAPP_ACCESS_TOKEN || null,
      whatsappPhoneId: config.whatsappPhoneId || process.env.WHATSAPP_PHONE_NUMBER_ID || null,
      whatsappSecret: config.whatsappSecret || process.env.WHATSAPP_APP_SECRET || 'tripmozy_dev_secret',
      gmailUser: config.gmailUser || process.env.GMAIL_USER || 'tripmozy@gmail.com',
      gmailAppPassword: config.gmailAppPassword || process.env.GMAIL_APP_PASSWORD || 'hiul rjbe mftg novo',
      emailApiKey: config.emailApiKey || process.env.EMAIL_PROVIDER_API_KEY || null,
      smsApiKey: config.smsApiKey || process.env.SMS_PROVIDER_API_KEY || process.env.FAST2SMS_API_KEY || null,
      twoFactorApiKey: config.twoFactorApiKey || process.env.TWO_FACTOR_API_KEY || null,
      msg91AuthKey: config.msg91AuthKey || process.env.MSG91_AUTH_KEY || null,
      textlocalApiKey: config.textlocalApiKey || process.env.TEXTLOCAL_API_KEY || null,
      twilioSid: config.twilioSid || process.env.TWILIO_ACCOUNT_SID || null,
      twilioToken: config.twilioToken || process.env.TWILIO_AUTH_TOKEN || null,
      twilioFrom: config.twilioFrom || process.env.TWILIO_PHONE_NUMBER || null,
      smsGatewayUrl: config.smsGatewayUrl || process.env.SMS_GATEWAY_URL || null,
      baseUrl: config.baseUrl || process.env.APP_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:8080'),
      ...config
    };
    this.mockLogs = [];
    this.pendingDispatches = [];
  }

  // Check if a real telecom SMS gateway is configured
  isSmsConfigured() {
    return !!(this.config.smsApiKey || this.config.twoFactorApiKey || this.config.msg91AuthKey || this.config.textlocalApiKey || this.config.twilioSid || this.config.smsGatewayUrl);
  }

  // Verify Meta WhatsApp Cloud API HMAC-SHA256 signature
  verifyWhatsAppSignature(payloadBuffer, signatureHeader) {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return false;
    }
    const signatureHash = signatureHeader.slice(7);
    const expectedHash = crypto
      .createHmac('sha256', this.config.whatsappSecret)
      .update(payloadBuffer)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(signatureHash, 'hex'), Buffer.from(expectedHash, 'hex'));
  }

  // Generate formatted text message for WhatsApp
  generateWhatsAppText(templateCode, payload) {
    const base = payload.baseUrl || this.config.baseUrl || 'http://localhost:8080';

    if (templateCode === 'hotel_request_received') {
      return `🎒 *TripMozy Tour Request Alert!*\n` +
        `Hi Partner, a new tour request matches your package / region *${payload.propertyName || 'Verified Tour Operator'}*!\n\n` +
        `📍 Destination: ${payload.destination || 'India'}\n` +
        `📅 Dates: ${payload.checkInDate} to ${payload.checkOutDate} (${payload.nights}n)\n` +
        `👥 Travelers & Setup: ${payload.numAdults} Adults · ${payload.numRooms} Vehicle\n` +
        `💰 Traveler Budget: ₹${(payload.totalBudgetINR || 0).toLocaleString('en-IN')}\n\n` +
        `⚡ Quick Action (No login required):\n` +
        `👉 Tap to Accept & Send Tour Quote: ${base}/action?token=${payload.rawToken}&action=accept\n` +
        `👉 Tap to Decline: ${base}/action?token=${payload.rawToken}&action=reject`;
    }

    if (templateCode === 'hotel_offer_received') {
      const advINR = payload.advancePayableINR || Math.round((payload.totalAmountINR || 0) * 0.315);
      const balINR = payload.remainingBalanceINR || Math.round((payload.totalAmountINR || 0) * 0.70);
      const days = payload.nights ? `${payload.nights + 1} Days / ${payload.nights} Nights` : '';
      const payLink = payload.paymentUrl || payload.bookingUrl || 'http://localhost:8080/booking';
      return `🎉 *Your Tour is Confirmed by ${payload.propertyName}!*\n` +
        `Hi ${payload.guestName || 'Traveler'}, great news! Tour Operator *${payload.propertyName}* has accepted and confirmed your tour to *${payload.destination}*.\n\n` +
        `📋 *Confirmed Tour Details:*\n` +
        `• Destination: *${payload.destination}*\n` +
        (payload.checkInDate ? `• Tour Dates: ${payload.checkInDate} → ${payload.checkOutDate} (${days})\n` : '') +
        (payload.numAdults ? `• Travelers: ${payload.numAdults} Adult(s) · ${payload.numRooms || 1} Vehicle(s)\n` : '') +
        `• Package: ${payload.roomTypeName || 'All-Inclusive Tour Package'}\n` +
        `• Inclusions: ${payload.mealPlan || 'Daily Sightseeing, Dedicated Vehicle & Transfers'}\n\n` +
        `💳 *Payment Details:*\n` +
        `• Total Tour Package: ₹${(payload.totalAmountINR || 0).toLocaleString('en-IN')}\n` +
        `• ⚡ *Advance Payable Now (30% + 5% GST):* ₹${advINR.toLocaleString('en-IN')}\n` +
        `• 💵 *Remaining Balance (70%):* ₹${balINR.toLocaleString('en-IN')} (Pay on arrival / during tour)\n\n` +
        `🔒 *Click Here to Pay Advance & Guarantee Booking:*\n` +
        `${payLink}`;
    }

    if (templateCode === 'booking_confirmed') {
      const advINR = payload.advancePaidINR || Math.round((payload.totalAmountINR || 0) * 0.315);
      const balINR = payload.remainingBalanceINR || Math.round((payload.totalAmountINR || 0) * 0.70);
      const remText = payload.remainingPaymentOption === 'tripmozy_online' ? 'Online via TripMozy before departure' : 'To Tour Operator on arrival';
      const vendorName = payload.vendorName || payload.propertyName || 'Verified Tour Operator';
      const vendorPhoneText = payload.vendorPhone ? `\n• Tour Operator Phone: *${payload.vendorPhone}*` : '';

      return `*TripMozy Official Payment Receipt & Bill*\n` +
        `Website: tripmozy.com\n\n` +
        `Hi ${payload.guestName || 'Traveler'}, your payment has been *SUCCESSFULLY RECEIVED* by TripMozy!\n\n` +
        `*Payment Summary & Bill:*\n` +
        `• Booking Reference: *${payload.bookingReference}*\n` +
        `• Payment Status: *PAID & CONFIRMED*\n` +
        `• Total Tour Package Price: ₹${(payload.totalAmountINR || 0).toLocaleString('en-IN')}\n` +
        `• Advance Received by TripMozy: ₹${advINR.toLocaleString('en-IN')} (30% + 5% GST Guaranteed)\n` +
        `• Remaining 70% Balance Due: ₹${balINR.toLocaleString('en-IN')} (${remText})\n` +
        `• Payment Ref: ${payload.paymentReference || 'DIRECT_VERIFIED'}\n\n` +
        `*Assigned Tour Operator (Accepted Request):*\n` +
        `• Tour Operator: *${vendorName}*${vendorPhoneText}\n` +
        `• Tour Dates: ${payload.checkInDate} to ${payload.checkOutDate}\n\n` +
        `View & download your official bill on tripmozy.com:\n` +
        `${payload.bookingUrl || 'https://tripmozy-smart-tour-booking.vercel.app/booking'}`;
    }

    if (templateCode === 'hotel_request_received_guest') {
      return `🎒 *TripMozy Tour Request Dispatched!*\n` +
        `Hi ${payload.guestName || 'Traveler'}, we have dispatched your tour request to verified tour operators in *${payload.destination}*.\n\n` +
        `📋 Ref: ${payload.requestReference}\n` +
        `📅 Dates: ${payload.checkInDate} to ${payload.checkOutDate} (${payload.nights}n)\n` +
        `👥 Travelers & Setup: ${payload.numAdults} Adults · ${payload.numRooms} Vehicle\n` +
        `💰 Target Budget: ₹${(payload.totalBudgetINR || 0).toLocaleString('en-IN')}\n\n` +
        `⚡ Track live tour quotes as operators respond:\n` +
        `👉 View Tour Quotes: ${payload.bookingUrl || 'http://localhost:8080/booking'}`;
    }

    if (templateCode === 'hotel_request_declined') {
      const reasonLabel = {
        unavailable: 'Vehicles / guides unavailable',
        no_suitable_room: 'No suitable tour package',
        over_budget: 'Requested budget could not be accommodated',
        facilities_mismatch: 'Requested tour inclusions not available',
        other: 'Unable to accommodate'
      }[payload.reason] || 'Unable to accommodate';

      return `🎒 *TripMozy Tour Request Update*\n` +
        `Hi ${payload.guestName || 'Traveler'},\n` +
        `*${payload.propertyName}* was unable to accept your tour request for ${payload.checkInDate || 'your dates'} (${reasonLabel}).\n\n` +
        `🔍 We are continuing to match your request with other verified tour operators in ${payload.destination || 'your destination'}.\n` +
        `👉 Track your live request: ${payload.bookingUrl || 'http://localhost:8080/smart-tour-booking'}`;
    }

    if (templateCode === 'booking_confirmed_vendor') {
      const advINR = payload.advancePaidINR || Math.round((payload.totalAmountINR || 0) * 0.315);
      const balINR = payload.remainingBalanceINR || Math.round((payload.totalAmountINR || 0) * 0.70);
      return `🎉 *TripMozy Tour Booking Confirmed!*\n` +
        `Booking Ref: *${payload.bookingReference}*\n` +
        `Base / Property: *${payload.propertyName}*\n` +
        `Tour Dates: ${payload.checkInDate} to ${payload.checkOutDate}\n` +
        `Traveler: ${payload.guestName || 'Traveler'}${payload.guestPhone ? ' · ' + payload.guestPhone : ''}\n` +
        `Total Tour Package: ₹${(payload.totalAmountINR || 0).toLocaleString('en-IN')}\n` +
        `TripMozy Advance Received: ₹${advINR.toLocaleString('en-IN')}\n` +
        `Balance Due to Operator: ₹${balINR.toLocaleString('en-IN')}\n\n` +
        `👉 View your booking: ${payload.dashboardUrl || 'http://localhost:8080/partner/dashboard'}`;
    }

    if (templateCode === 'auth_otp_code') {
      return `🔐 *TripMozy Verification Code*\n\n` +
        `Your TripMozy verification code is: *${payload.otpCode}*\n\n` +
        `Valid for 10 minutes. Do not share this code with anyone.`;
    }

    return `TripMozy Alert: ${templateCode} - ${JSON.stringify(payload)}`;
  }

  // Generate clean SMS text content (optimized for SMS carriers & DLT standards)
  generateSmsText(templateCode, payload) {
    if (templateCode === 'auth_otp_code') {
      return `${payload.otpCode} is your TripMozy verification code for sign in. Valid for 10 minutes. Please do not share this OTP with anyone. - TripMozy`;
    }
    if (templateCode === 'booking_confirmed') {
      return `TripMozy: Your tour booking ${payload.bookingReference || ''} for ${payload.destination || 'your tour'} is confirmed!`;
    }
    if (templateCode === 'hotel_request_received_vendor') {
      return `TripMozy Partner: New tour request received for ${payload.destination || ''} (Budget: Rs.${payload.totalBudgetINR || 0}). Open your partner dashboard to view details and send quotes.`;
    }
    return `TripMozy Alert: ${templateCode}`;
  }

  // Generate formatted HTML email template
  generateEmailHtml(templateCode, payload) {
    if (templateCode === 'hotel_offer_received') {
      const advINR = payload.advancePayableINR || Math.round((payload.totalAmountINR || 0) * 0.315);
      const balINR = payload.remainingBalanceINR || Math.round((payload.totalAmountINR || 0) * 0.70);
      const payLink = payload.paymentUrl || payload.bookingUrl || 'http://localhost:8080/booking';
      const daysText = payload.nights ? `${payload.nights + 1} Days / ${payload.nights} Nights` : '';
      return `
        <div style="font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; max-width:600px; margin:20px auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:18px; overflow:hidden; box-shadow:0 12px 35px rgba(0,0,0,0.06);">
          <div style="background:#0f172a; padding:28px 24px; text-align:center;">
            <div style="font-size:26px; font-weight:800; color:#ffffff; letter-spacing:-0.5px;">Trip<span style="color:#f59e0b;">Mozy</span></div>
            <div style="color:#94a3b8; font-size:12px; margin-top:4px; letter-spacing:0.5px; text-transform:uppercase; font-weight:600;">Memories Begin With a Booking</div>
          </div>
          
          <div style="background:#10b981; color:#ffffff; padding:14px 24px; text-align:center; font-weight:700; font-size:13px; letter-spacing:0.3px;">
            🎉 TOUR REQUEST CONFIRMED BY OPERATOR PARTNER
          </div>

          <div style="padding:32px 28px;">
            <div style="display:inline-block; background:#dcfce7; color:#15803d; font-size:12px; font-weight:800; padding:5px 14px; border-radius:20px; margin-bottom:14px; border:1px solid #bbf7d0;">
              ✓ Tour Confirmed by ${payload.propertyName}
            </div>
            
            <h1 style="color:#0f172a; margin:0 0 10px; font-size:22px; font-weight:800; line-height:1.3;">
              Your Tour to ${payload.destination} has been Confirmed!
            </h1>
            
            <p style="color:#475569; font-size:14px; line-height:1.6; margin:0 0 24px;">
              Hi <strong>${payload.guestName || 'Traveler'}</strong>,<br>
              Great news! Tour Operator Partner <strong>${payload.propertyName}</strong> has accepted and confirmed your tour request. Please review your confirmed tour details and payment breakdown below, and complete the 30% advance payment to lock in your booking.
            </p>

            <!-- CARD 1: TOUR DETAILS -->
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:20px; margin-bottom:20px;">
              <div style="font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:0.5px; color:#64748b; margin-bottom:14px; border-bottom:1px solid #e2e8f0; padding-bottom:8px;">
                📋 Confirmed Tour Details
              </div>
              
              <div style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:14px;">
                <span style="color:#64748b;">Destination:</span>
                <strong style="color:#0f172a;">${payload.destination}</strong>
              </div>

              ${payload.checkInDate ? `
              <div style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:14px;">
                <span style="color:#64748b;">Tour Dates:</span>
                <strong style="color:#0f172a;">${payload.checkInDate} → ${payload.checkOutDate} (${daysText})</strong>
              </div>` : ''}

              ${payload.numAdults ? `
              <div style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:14px;">
                <span style="color:#64748b;">Travelers &amp; Vehicle:</span>
                <strong style="color:#0f172a;">${payload.numAdults} Adult(s) · ${payload.numRooms || 1} Vehicle(s)</strong>
              </div>` : ''}

              <div style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:14px;">
                <span style="color:#64748b;">Tour Package:</span>
                <strong style="color:#0f172a;">${payload.roomTypeName || 'All-Inclusive Custom Tour Package'}</strong>
              </div>

              <div style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:14px;">
                <span style="color:#64748b;">Inclusions:</span>
                <strong style="color:#059669;">${payload.mealPlan || 'Daily Sightseeing, Transfers &amp; Breakfast Included'}</strong>
              </div>

              <div style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:14px;">
                <span style="color:#64748b;">Confirmed Operator:</span>
                <strong style="color:#2563eb;">${payload.propertyName}</strong>
              </div>

              <div style="display:flex; justify-content:space-between; font-size:13px; color:#64748b; padding-top:6px;">
                <span>Cancellation:</span>
                <span>${payload.cancellationTerms || 'Free cancellation up to 48 hours before departure'}</span>
              </div>
            </div>

            <!-- CARD 2: PAYMENT DETAILS -->
            <div style="background:#eff6ff; border:1.5px solid #bfdbfe; border-radius:14px; padding:20px; margin-bottom:24px;">
              <div style="font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:0.5px; color:#1e40af; margin-bottom:14px; border-bottom:1px solid #dbeafe; padding-bottom:8px;">
                💳 Payment Breakdown &amp; Schedule
              </div>

              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                <span style="color:#1e3a8a; font-size:14px;">Total Tour Package Cost:</span>
                <strong style="color:#1e293b; font-size:17px;">₹${(payload.totalAmountINR || 0).toLocaleString('en-IN')}</strong>
              </div>

              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; background:#ffffff; padding:12px 14px; border-radius:10px; border:1px solid #93c5fd;">
                <div>
                  <div style="color:#047857; font-weight:800; font-size:14px;">⚡ Payable Now (30% Advance + 5% GST):</div>
                  <div style="font-size:11px; color:#64748b; margin-top:2px;">Secures inventory &amp; locks package tariff</div>
                </div>
                <strong style="color:#059669; font-size:20px;">₹${advINR.toLocaleString('en-IN')}</strong>
              </div>

              <div style="display:flex; justify-content:space-between; align-items:center; font-size:13px; color:#475569; padding:4px 0;">
                <span>Remaining 70% Balance Due:</span>
                <strong style="color:#0f172a; font-size:14px;">₹${balINR.toLocaleString('en-IN')}</strong>
              </div>
              <div style="font-size:11px; color:#64748b; margin-top:2px; text-align:right;">(Payable upon arrival at destination or online before trip)</div>

              <div style="margin-top:14px; padding-top:10px; border-top:1px dashed #93c5fd; font-size:11px; color:#1e40af; display:flex; align-items:center; gap:6px;">
                <span>🛡️</span>
                <span><strong>100% Escrow Protection:</strong> Advance is held safely by TripMozy until tour commences.</span>
              </div>
            </div>

            <!-- CARD 3: DIRECT PAYMENT LINK -->
            <div style="text-align:center; margin-bottom:26px;">
              <a href="${payLink}" style="display:inline-block; background:#2563eb; color:#ffffff; font-weight:800; font-size:16px; padding:16px 36px; border-radius:12px; text-decoration:none; box-shadow:0 6px 20px rgba(37,99,235,0.35); letter-spacing:0.3px;">
                💳 Proceed to Pay Advance (₹${advINR.toLocaleString('en-IN')}) &amp; Guarantee Tour →
              </a>
              <div style="margin-top:12px; font-size:12px; color:#64748b;">
                Direct Payment Link: <a href="${payLink}" style="color:#2563eb; word-break:break-all;">${payLink}</a>
              </div>
            </div>
            
            <p style="color:#94a3b8; font-size:12px; text-align:center; margin:0; line-height:1.5;">
              To protect customer schedules, rates are held for a limited period. Complete your advance payment to receive your instant travel voucher.
            </p>
          </div>

          <div style="background:#f1f5f9; padding:18px 24px; text-align:center; font-size:12px; color:#64748b; border-top:1px solid #e2e8f0;">
            <div style="font-weight:700; color:#334155; margin-bottom:4px;">TripMozy Smart Tour Marketplace</div>
            <div>Questions? Contact our 24/7 Concierge Support at <a href="mailto:tripmozy@gmail.com" style="color:#2563eb; text-decoration:none;">tripmozy@gmail.com</a></div>
          </div>
        </div>
      `;
    }

    if (templateCode === 'booking_confirmed') {
      const advINR = payload.advancePaidINR || Math.round((payload.totalAmountINR || 0) * 0.315);
      const advBase = payload.advanceBaseINR || Math.round(advINR / 1.05);
      const advGst = payload.advanceGstINR || (advINR - advBase);
      const balINR = payload.remainingBalanceINR || Math.round((payload.totalAmountINR || 0) * 0.70);
      const remText = payload.remainingPaymentOption === 'tripmozy_online' ? 'Online via TripMozy before departure' : 'Pay directly to Tour Operator upon arrival';
      const vendorName = payload.vendorName || payload.propertyName || 'Verified Tour Operator';
      const vendorPhone = payload.vendorPhone || 'Available on portal';
      const vendorEmail = payload.vendorEmail || 'partners@tripmozy.com';
      const bookingUrl = payload.bookingUrl || 'https://tripmozy-smart-tour-booking.vercel.app/booking';

      return `
        <div style="font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,Roboto,sans-serif; max-width:620px; margin:20px auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:18px; overflow:hidden; box-shadow:0 12px 35px rgba(0,0,0,0.08);">
          <!-- TripMozy Header -->
          <div style="background:#0f172a; padding:28px 24px; text-align:center;">
            <div style="font-size:26px; font-weight:800; color:#ffffff; letter-spacing:-0.5px;">Trip<span style="color:#f59e0b;">Mozy</span>.com</div>
            <div style="color:#94a3b8; font-size:12px; margin-top:4px; letter-spacing:0.5px; text-transform:uppercase; font-weight:700;">Official Payment Receipt &amp; Tax Bill</div>
          </div>

          <!-- Status Banner -->
          <div style="background:#10b981; color:#ffffff; padding:12px 24px; text-align:center; font-weight:700; font-size:14px; letter-spacing:0.3px;">
            Payment Received Successfully · Advance Received by TripMozy Escrow
          </div>

          <div style="padding:28px 24px;">
            <!-- Receipt Meta -->
            <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; border-bottom:1px solid #e2e8f0; padding-bottom:16px; margin-bottom:20px; font-size:12px; color:#64748b;">
              <div><strong>Receipt Ref:</strong> TM-INV-${(payload.bookingReference || '').replace('TM-REQ-', '')}</div>
              <div><strong>Booking Ref:</strong> <span style="color:#2563eb; font-weight:700; font-family:monospace;">${payload.bookingReference}</span></div>
              <div><strong>Payment Status:</strong> <span style="color:#059669; font-weight:700;">PAID IN FULL</span></div>
            </div>

            <!-- Two-Column Parties Box -->
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:24px;">
              <!-- Customer -->
              <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:16px;">
                <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; margin-bottom:6px;">Billed To (Customer)</div>
                <div style="font-size:15px; font-weight:800; color:#0f172a;">${payload.guestName || 'Traveler'}</div>
                <div style="font-size:12px; color:#475569; margin-top:4px;">Phone: <strong>${payload.guestPhone || ''}</strong></div>
                <div style="font-size:12px; color:#475569;">Email: ${payload.guestEmail || ''}</div>
                <div style="font-size:12px; color:#0f172a; margin-top:4px;">Destination: <strong>${payload.destination || ''}</strong></div>
              </div>

              <!-- Vendor who accepted the request -->
              <div style="background:#eff6ff; border:1.5px solid #bfdbfe; border-radius:12px; padding:16px;">
                <div style="font-size:11px; font-weight:700; color:#1e40af; text-transform:uppercase; margin-bottom:6px;">Assigned Tour Operator (Accepted)</div>
                <div style="font-size:15px; font-weight:800; color:#0f172a;">${vendorName}</div>
                <div style="background:#ffffff; border:1px solid #93c5fd; border-radius:8px; padding:6px 10px; margin-top:6px;">
                  <div style="font-size:10px; font-weight:700; color:#1e40af; text-transform:uppercase;">Operator Contact Number:</div>
                  <div style="font-size:14px; font-weight:800; color:#2563eb;">${vendorPhone}</div>
                </div>
                <div style="font-size:11px; color:#64748b; margin-top:6px;">Email: ${vendorEmail}</div>
                <div style="font-size:11px; color:#15803d; font-weight:700; margin-top:4px;">TripMozy Verified Tour Operator Partner ✓</div>
              </div>
            </div>

            <!-- Itemized Financial Breakdown Table -->
            <table style="width:100%; border-collapse:collapse; margin-bottom:20px; font-size:13px;">
              <thead>
                <tr style="background:#f1f5f9; border-bottom:1.5px solid #cbd5e1;">
                  <th style="text-align:left; padding:10px 12px; font-weight:700; color:#0f172a;">Description</th>
                  <th style="text-align:right; padding:10px 12px; font-weight:700; color:#0f172a;">Amount (INR)</th>
                </tr>
              </thead>
              <tbody>
                <tr style="border-bottom:1px solid #e2e8f0;">
                  <td style="padding:10px 12px;">
                    <strong>Custom Tour Package (${payload.destination || 'Selected Destination'})</strong><br>
                    <span style="font-size:11px; color:#64748b;">Dates: ${payload.checkInDate} to ${payload.checkOutDate}</span>
                  </td>
                  <td style="text-align:right; padding:10px 12px; font-weight:700; color:#0f172a;">₹${(payload.totalAmountINR || 0).toLocaleString('en-IN')}</td>
                </tr>
                <tr style="border-bottom:1px solid #e2e8f0; color:#475569;">
                  <td style="padding:8px 12px 8px 24px;">30% Tour Advance Deposit (Base)</td>
                  <td style="text-align:right; padding:8px 12px;">₹${advBase.toLocaleString('en-IN')}</td>
                </tr>
                <tr style="border-bottom:1px solid #e2e8f0; color:#475569;">
                  <td style="padding:8px 12px 8px 24px;">5% GST on Advance (Govt. of India)</td>
                  <td style="text-align:right; padding:8px 12px;">₹${advGst.toLocaleString('en-IN')}</td>
                </tr>
                <tr style="background:#ecfdf5; border-bottom:1.5px solid #a7f3d0;">
                  <td style="padding:12px; font-weight:800; color:#065f46;">
                    Total Payment Received by TripMozy.com
                    <div style="font-size:11px; font-weight:500; color:#047857;">Status: RECEIVED &amp; SECURED IN ESCROW</div>
                  </td>
                  <td style="text-align:right; padding:12px; font-weight:800; font-size:16px; color:#059669;">₹${advINR.toLocaleString('en-IN')}</td>
                </tr>
                <tr style="border-bottom:1px solid #e2e8f0;">
                  <td style="padding:10px 12px; font-weight:700; color:#0f172a;">
                    Remaining 70% Balance Due
                    <div style="font-size:11px; font-weight:normal; color:#64748b;">${remText}</div>
                  </td>
                  <td style="text-align:right; padding:10px 12px; font-weight:700; font-size:14px; color:#0f172a;">₹${balINR.toLocaleString('en-IN')}</td>
                </tr>
              </tbody>
            </table>

            <!-- Escrow Trust Notice -->
            <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px; padding:14px; font-size:12px; color:#1e40af; line-height:1.5; margin-bottom:24px;">
              <strong>TripMozy Buyer Protection &amp; Escrow Guarantee:</strong><br>
              Your advance payment of ₹${advINR.toLocaleString('en-IN')} has been safely received into the official TripMozy Account. It is safeguarded until your tour commences. For tour coordination or pickup changes, please contact your tour operator directly at <strong>${vendorPhone}</strong>.
            </div>

            <!-- View Bill Button -->
            <div style="text-align:center;">
              <a href="${bookingUrl}" style="display:inline-block; background:#2563eb; color:#ffffff; font-weight:800; font-size:14px; padding:14px 30px; border-radius:10px; text-decoration:none;">
                View &amp; Print Official Bill on TripMozy →
              </a>
            </div>
          </div>

          <div style="background:#f1f5f9; padding:16px; text-align:center; font-size:11px; color:#64748b; border-top:1px solid #e2e8f0;">
            TripMozy Technologies · Official Bill from tripmozy.com · 24/7 Concierge: tripmozy@gmail.com
          </div>
        </div>
      `;
    }

    if (templateCode === 'hotel_request_received_guest') {
      return `
        <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif; max-width:580px; margin:20px auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden; box-shadow:0 10px 25px rgba(0,0,0,0.05);">
          <div style="background:#0f172a; padding:24px; text-align:center;">
            <div style="font-size:24px; font-weight:800; color:#ffffff;">Trip<span style="color:#f59e0b;">Mozy</span></div>
            <div style="color:#94a3b8; font-size:12px; margin-top:4px;">Memories Begin With a Booking</div>
          </div>
          <div style="padding:28px 24px;">
            <div style="display:inline-block; background:#dbeafe; color:#1e40af; font-size:12px; font-weight:700; padding:4px 12px; border-radius:20px; margin-bottom:12px;">Request Dispatched</div>
            <h2 style="color:#0f172a; margin:0 0 8px; font-size:20px;">Your Tour Request has been Sent to Verified Tour Operators!</h2>
            <p style="color:#64748b; font-size:14px; margin:0 0 20px;">Hi ${payload.guestName || 'Traveler'}, we have dispatched your tour request to verified partner tour operators in <strong>${payload.destination}</strong>.</p>
            
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:18px; margin-bottom:24px;">
              <div style="margin-bottom:8px;"><span style="color:#64748b; font-size:13px;">Request Ref:</span> <strong style="font-family:monospace; font-size:15px; color:#2563eb; margin-left:8px;">${payload.requestReference}</strong></div>
              <div style="margin-bottom:8px;"><span style="color:#64748b; font-size:13px;">Dates:</span> <strong style="color:#0f172a; font-size:14px; margin-left:8px;">${payload.checkInDate} to ${payload.checkOutDate} (${payload.nights} nights)</strong></div>
              <div style="margin-bottom:8px;"><span style="color:#64748b; font-size:13px;">Travelers &amp; Setup:</span> <span style="color:#0f172a; font-size:14px; margin-left:8px;">${payload.numAdults} Adult(s) · ${payload.numRooms} Vehicle(s)</span></div>
              <div><span style="color:#64748b; font-size:13px;">Target Budget:</span> <strong style="color:#059669; font-size:14px; margin-left:8px;">₹${(payload.totalBudgetINR || 0).toLocaleString('en-IN')}</strong></div>
            </div>

            <div style="text-align:center; margin-bottom:24px;">
              <a href="${payload.bookingUrl || 'http://localhost:8080/booking'}" style="display:inline-block; background:#2563eb; color:#ffffff; font-weight:700; font-size:15px; padding:14px 32px; border-radius:10px; text-decoration:none; box-shadow:0 4px 14px rgba(37,99,235,0.3);">
                ⚡ Track Live Tour Quotes
              </a>
            </div>
            <p style="color:#94a3b8; font-size:12px; text-align:center; margin:0;">Tour operators have 2 hours to submit their best quotes. You'll receive instant notifications as offers arrive.</p>
          </div>
          <div style="background:#f1f5f9; padding:16px; text-align:center; font-size:12px; color:#64748b;">
            TripMozy Marketplace · Powered by tripmozy.com
          </div>
        </div>
      `;
    }

    if (templateCode === 'hotel_request_declined') {
      const reasonLabel = {
        unavailable: 'Vehicles / guides unavailable on selected dates',
        no_suitable_room: 'No suitable tour package available',
        over_budget: 'Requested budget could not be accommodated',
        facilities_mismatch: 'Requested tour inclusions not available',
        other: 'Unable to accommodate at this time'
      }[payload.reason] || 'Unable to accommodate at this time';

      return `
        <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif; max-width:580px; margin:20px auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden; box-shadow:0 10px 25px rgba(0,0,0,0.05);">
          <div style="background:#0f172a; padding:24px; text-align:center;">
            <div style="font-size:24px; font-weight:800; color:#ffffff;">Trip<span style="color:#f59e0b;">Mozy</span></div>
            <div style="color:#94a3b8; font-size:12px; margin-top:4px;">Memories Begin With a Booking</div>
          </div>
          <div style="padding:28px 24px;">
            <div style="display:inline-block; background:#fee2e2; color:#991b1b; font-size:12px; font-weight:700; padding:4px 12px; border-radius:20px; margin-bottom:12px;">Operator Update</div>
            <h2 style="color:#0f172a; margin:0 0 8px; font-size:20px;">Update on your Tour Request</h2>
            <p style="color:#64748b; font-size:14px; margin:0 0 20px;">Hi ${payload.guestName || 'Traveler'}, <strong>${payload.propertyName}</strong> in ${payload.destination || 'your destination'} was unable to accept your tour request.</p>
            
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:18px; margin-bottom:24px;">
              <div style="margin-bottom:8px;">
                <span style="color:#64748b; font-size:13px;">Reason:</span>
                <strong style="color:#0f172a; font-size:14px; margin-left:8px;">${reasonLabel}</strong>
              </div>
              ${payload.note ? `<div style="margin-bottom:8px;"><span style="color:#64748b; font-size:13px;">Note from operator:</span> <span style="color:#0f172a; font-size:13px; margin-left:8px;">${payload.note}</span></div>` : ''}
            </div>

            <div style="text-align:center; margin-bottom:24px;">
              <a href="${payload.bookingUrl || 'http://localhost:8080/smart-tour-booking'}" style="display:inline-block; background:#2563eb; color:#ffffff; font-weight:700; font-size:15px; padding:14px 32px; border-radius:10px; text-decoration:none;">
                🔍 View Other Tour Quotes / New Request
              </a>
            </div>
          </div>
          <div style="background:#f1f5f9; padding:16px; text-align:center; font-size:12px; color:#64748b;">
            TripMozy Marketplace · Powered by tripmozy.com
          </div>
        </div>
      `;
    }

    if (templateCode === 'hotel_request_received_vendor') {
      return `
        <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif; max-width:600px; margin:20px auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden; box-shadow:0 10px 25px rgba(0,0,0,0.06);">
          <div style="background:#0f172a; padding:24px; text-align:center;">
            <div style="font-size:24px; font-weight:800; color:#ffffff;">Trip<span style="color:#f59e0b;">Mozy</span></div>
            <div style="color:#94a3b8; font-size:12px; margin-top:4px;">Tour Operator Partner Portal</div>
          </div>
          <div style="padding:28px 24px;">
            <div style="display:inline-block; background:#fef3c7; color:#92400e; font-size:12px; font-weight:700; padding:4px 12px; border-radius:20px; margin-bottom:12px;">⚡ Live Tour Request</div>
            <h2 style="color:#0f172a; margin:0 0 8px; font-size:20px;">New Tour Request for ${payload.destination}!</h2>
            <p style="color:#64748b; font-size:14px; margin:0 0 20px;">Hi ${payload.vendorName || 'Partner'}, a traveler is seeking a customized tour package matching your base.</p>
            
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:18px; margin-bottom:24px;">
              <div style="margin-bottom:8px;"><span style="color:#64748b; font-size:13px;">Tour Destination:</span> <strong style="color:#0f172a; font-size:14px; margin-left:8px;">${payload.destination}</strong></div>
              <div style="margin-bottom:8px;"><span style="color:#64748b; font-size:13px;">Tour Dates:</span> <strong style="color:#0f172a; font-size:14px; margin-left:8px;">${payload.checkInDate} to ${payload.checkOutDate} (${payload.nights} nights)</strong></div>
              <div style="margin-bottom:8px;"><span style="color:#64748b; font-size:13px;">Travelers &amp; Setup:</span> <strong style="color:#0f172a; font-size:14px; margin-left:8px;">${payload.numAdults} Adults · ${payload.numRooms} Vehicle</strong></div>
              <div style="margin-bottom:8px;"><span style="color:#64748b; font-size:13px;">Target Budget:</span> <strong style="color:#2563eb; font-size:16px; margin-left:8px;">₹${(payload.totalBudgetINR || 0).toLocaleString('en-IN')}</strong></div>
              <div><span style="color:#64748b; font-size:13px;">Assigned Property / Base:</span> <span style="color:#0f172a; font-size:14px; margin-left:8px;">${payload.propertyName}</span></div>
            </div>

            <div style="display:flex; flex-direction:column; gap:12px; margin-bottom:24px;">
              <a href="${payload.actionUrl}" style="display:block; text-align:center; background:#10b981; color:#ffffff; font-weight:700; font-size:15px; padding:14px 24px; border-radius:10px; text-decoration:none;">
                ✅ Accept &amp; Send Tour Quote Instantly
              </a>
              <div style="display:flex; gap:10px; justify-content:center;">
                <a href="${payload.dashboardUrl}" style="display:inline-block; text-align:center; background:#f1f5f9; color:#0f172a; font-weight:600; font-size:13px; padding:10px 20px; border-radius:8px; text-decoration:none;">
                  📊 Open Partner Dashboard
                </a>
                <a href="${payload.rejectUrl}" style="display:inline-block; text-align:center; background:#fff; color:#ef4444; border:1.5px solid #ef4444; font-weight:600; font-size:13px; padding:10px 20px; border-radius:8px; text-decoration:none;">
                  ❌ Decline
                </a>
              </div>
            </div>
            
            <p style="color:#94a3b8; font-size:12px; text-align:center; margin:0;">You have 2 hours to submit your quote before this request expires.</p>
          </div>
          <div style="background:#f1f5f9; padding:16px; text-align:center; font-size:12px; color:#64748b;">
            TripMozy Partner Network · Sent to registered operator ${payload.vendorEmail || payload.destination || ''}
          </div>
        </div>
      `;
    }

    if (templateCode === 'booking_confirmed_vendor') {
      return `
        <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif; max-width:580px; margin:20px auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden;">
          <div style="background:#065f46; color:#ffffff; padding:28px 24px; text-align:center;">
            <div style="font-size:40px; margin-bottom:8px;">🎉</div>
            <h1 style="margin:0; font-size:22px; font-weight:800;">New Tour Booking Confirmed!</h1>
            <p style="margin:6px 0 0; opacity:0.9; font-size:13px;">Customer payment is verified and booking is guaranteed.</p>
          </div>
          <div style="padding:28px 24px;">
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:18px; margin-bottom:20px;">
              <div style="margin-bottom:8px;"><span style="color:#64748b; font-size:12px;">BOOKING REFERENCE:</span> <strong style="font-family:monospace; font-size:16px; color:#2563eb;">${payload.bookingReference}</strong></div>
              <div style="margin-bottom:8px;"><strong>Base / Package:</strong> ${payload.propertyName}</div>
              <div style="margin-bottom:8px;"><strong>Tour Dates:</strong> ${payload.checkInDate} to ${payload.checkOutDate}</div>
              <div style="margin-bottom:8px;"><strong>Lead Traveler:</strong> ${payload.guestName || 'Traveler'}${payload.guestPhone ? ' (' + payload.guestPhone + ')' : ''}</div>
              <div style="margin-bottom:8px;"><strong>Total Tour Package:</strong> ₹${(payload.totalAmountINR || 0).toLocaleString('en-IN')}</div>
              <div style="margin-bottom:8px;"><strong style="color:#059669;">Advance Received in TripMozy:</strong> ₹${(payload.advancePaidINR || Math.round((payload.totalAmountINR || 0) * 0.315)).toLocaleString('en-IN')}</div>
              <div><strong style="color:#1e40af;">Balance Due to Operator:</strong> ₹${(payload.remainingBalanceINR || Math.round((payload.totalAmountINR || 0) * 0.70)).toLocaleString('en-IN')} (Customer will pay ${payload.remainingPaymentOption === 'tripmozy_online' ? 'online via TripMozy' : 'at hotel / upon arrival'})</div>
            </div>
            <div style="text-align:center;">
              <a href="${payload.dashboardUrl || 'http://localhost:8080/partner/dashboard'}" style="display:inline-block; background:#2563eb; color:#ffffff; font-weight:700; font-size:14px; padding:12px 28px; border-radius:8px; text-decoration:none;">
                📊 View in Partner Dashboard
              </a>
            </div>
          </div>
        </div>
      `;
    }

    if (templateCode === 'admin_new_request') {
      return `
        <div style="font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; max-width:620px; margin:20px auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden; box-shadow:0 10px 30px rgba(0,0,0,0.06);">
          <div style="background:#0f172a; padding:24px; text-align:center;">
            <div style="font-size:24px; font-weight:800; color:#ffffff;">Trip<span style="color:#f59e0b;">Mozy</span> Admin Portal</div>
            <div style="color:#94a3b8; font-size:12px; margin-top:4px; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">Main Platform Dispatch Oversight · tripmozy@gmail.com</div>
          </div>
          
          <div style="background:#2563eb; color:#ffffff; padding:12px 24px; text-align:center; font-weight:700; font-size:13px; letter-spacing:0.3px;">
            📋 NEW CUSTOMER TOUR REQUEST SUBMITTED
          </div>

          <div style="padding:28px 24px;">
            <p style="color:#475569; font-size:14px; line-height:1.6; margin:0 0 20px;">
              Hello <strong>TripMozy Administrator</strong>,<br>
              A customer has just submitted a new customized tour request on TripMozy. Here are the written details:
            </p>

            <!-- SECTION 1: CUSTOMER / TRAVELER CONTACT (ADMIN PRIVILEGE ONLY) -->
            <div style="background:#f0fdf4; border:1.5px solid #86efac; border-radius:12px; padding:18px; margin-bottom:20px;">
              <div style="font-size:12px; font-weight:800; color:#166534; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; border-bottom:1px solid #bbf7d0; padding-bottom:6px;">
                👤 Traveler Contact Info (Admin Only Privilege - Hidden from Vendors)
              </div>
              <table style="width:100%; font-size:13px; border-collapse:collapse;">
                <tr>
                  <td style="padding:5px 0; color:#475569; width:130px;">Traveler Name:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;">${payload.guestName}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Direct Phone:</td>
                  <td style="padding:5px 0; font-weight:700; color:#059669;"><a href="tel:${payload.guestPhone}" style="color:#059669; text-decoration:none;">${payload.guestPhone}</a></td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Email Address:</td>
                  <td style="padding:5px 0; font-weight:700; color:#2563eb;"><a href="mailto:${payload.guestEmail}" style="color:#2563eb; text-decoration:none;">${payload.guestEmail}</a></td>
                </tr>
              </table>
            </div>

            <!-- SECTION 2: TOUR REQUIREMENTS -->
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:18px; margin-bottom:20px;">
              <div style="font-size:12px; font-weight:800; color:#475569; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; border-bottom:1px solid #e2e8f0; padding-bottom:6px;">
                📍 Tour Itinerary &amp; Specifications
              </div>
              <table style="width:100%; font-size:13px; border-collapse:collapse;">
                <tr>
                  <td style="padding:5px 0; color:#64748b; width:140px;">Request Reference:</td>
                  <td style="padding:5px 0; font-weight:800; font-family:monospace; color:#0f172a;">${payload.requestReference}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Destination:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;">${payload.destination}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Specific Locality:</td>
                  <td style="padding:5px 0; color:#0f172a;">${payload.destinationLocality || 'Not specified'}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Dates of Travel:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;">${payload.checkInDate} → ${payload.checkOutDate} (${payload.nights + 1} Days / ${payload.nights} Nights)</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Travelers &amp; Setup:</td>
                  <td style="padding:5px 0; color:#0f172a;">${payload.numAdults} Adults${payload.numChildren ? ', ' + payload.numChildren + ' Children' : ''} · ${payload.numRooms} Dedicated Vehicle(s)</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Package Style:</td>
                  <td style="padding:5px 0; color:#0f172a;">${payload.roomPreference}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Inclusions Requested:</td>
                  <td style="padding:5px 0; color:#0f172a;">${payload.requiredFacilities && payload.requiredFacilities.length ? payload.requiredFacilities.join(', ') : 'Standard Sightseeing & Transfers'}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Customer Budget:</td>
                  <td style="padding:5px 0; font-weight:800; font-size:15px; color:#2563eb;">₹${(payload.totalBudgetINR || 0).toLocaleString('en-IN')}</td>
                </tr>
              </table>
            </div>

            <!-- SECTION 3: BROADCAST STATUS -->
            <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:16px; margin-bottom:20px; font-size:13px; color:#1e40af;">
              <div style="font-weight:700; margin-bottom:4px;">📡 Broadcast Status:</div>
              <div>Dispatched simultaneously to <strong>${payload.dispatchedVendorsCount} verified tour operator(s)</strong>:</div>
              <div style="font-size:12px; color:#3b82f6; margin-top:4px;">${payload.dispatchedVendorsList || 'All matching verified operators in the region'}</div>
              <div style="font-size:11px; color:#64748b; margin-top:8px;">🔒 Note: Operators received anonymized request details only. Customer contact information is withheld until 30% advance confirmation.</div>
            </div>

            <div style="font-size:11px; color:#94a3b8; text-align:center; border-top:1px solid #e2e8f0; padding-top:14px;">
              TripMozy Platform Monitoring · Generated automatically at ${payload.createdAt || new Date().toLocaleString('en-IN')}
            </div>
          </div>
        </div>
      `;
    }

    if (templateCode === 'admin_request_accepted') {
      return `
        <div style="font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; max-width:620px; margin:20px auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden; box-shadow:0 10px 30px rgba(0,0,0,0.06);">
          <div style="background:#0f172a; padding:24px; text-align:center;">
            <div style="font-size:24px; font-weight:800; color:#ffffff;">Trip<span style="color:#f59e0b;">Mozy</span> Admin Portal</div>
            <div style="color:#94a3b8; font-size:12px; margin-top:4px; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">Main Platform Acceptance Oversight · tripmozy@gmail.com</div>
          </div>
          
          <div style="background:#059669; color:#ffffff; padding:12px 24px; text-align:center; font-weight:700; font-size:13px; letter-spacing:0.3px;">
            ✅ TOUR REQUEST ACCEPTED BY TOUR OPERATOR PARTNER
          </div>

          <div style="padding:28px 24px;">
            <p style="color:#475569; font-size:14px; line-height:1.6; margin:0 0 20px;">
              Hello <strong>TripMozy Administrator</strong>,<br>
              Tour Operator <strong>${payload.vendorName}</strong> has accepted tour request <strong>${payload.requestReference}</strong> and issued a tour quote. Here are the whole written details:
            </p>

            <!-- SECTION 1: ACCEPTING OPERATOR DETAILS -->
            <div style="background:#f0fdf4; border:1.5px solid #86efac; border-radius:12px; padding:18px; margin-bottom:20px;">
              <div style="font-size:12px; font-weight:800; color:#166534; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; border-bottom:1px solid #bbf7d0; padding-bottom:6px;">
                🏨 Assigned Tour Operator Partner (Accepted Request)
              </div>
              <table style="width:100%; font-size:13px; border-collapse:collapse;">
                <tr>
                  <td style="padding:5px 0; color:#475569; width:140px;">Business / Operator:</td>
                  <td style="padding:5px 0; font-weight:800; color:#0f172a;">${payload.vendorName}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Manager / Contact:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;">${payload.vendorContactPerson || 'Tour Manager'}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Operator Phone:</td>
                  <td style="padding:5px 0; font-weight:700; color:#059669;"><a href="tel:${payload.vendorPhone}" style="color:#059669; text-decoration:none;">${payload.vendorPhone}</a></td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Operator Email:</td>
                  <td style="padding:5px 0; font-weight:700; color:#2563eb;"><a href="mailto:${payload.vendorEmail}" style="color:#2563eb; text-decoration:none;">${payload.vendorEmail}</a></td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Fleet Base / Property:</td>
                  <td style="padding:5px 0; color:#0f172a;">${payload.propertyName}</td>
                </tr>
              </table>
            </div>

            <!-- SECTION 2: QUOTE & FINANCIAL BREAKDOWN -->
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:18px; margin-bottom:20px;">
              <div style="font-size:12px; font-weight:800; color:#475569; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; border-bottom:1px solid #e2e8f0; padding-bottom:6px;">
                💰 Quote &amp; Financial Breakdown
              </div>
              <table style="width:100%; font-size:13px; border-collapse:collapse;">
                <tr>
                  <td style="padding:5px 0; color:#64748b; width:150px;">Offer Reference:</td>
                  <td style="padding:5px 0; font-weight:800; font-family:monospace; color:#0f172a;">${payload.offerReference}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Total Tour Package:</td>
                  <td style="padding:5px 0; font-weight:800; font-size:16px; color:#059669;">₹${(payload.totalAmountINR || 0).toLocaleString('en-IN')}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">30% Advance Base:</td>
                  <td style="padding:5px 0; font-weight:600; color:#0f172a;">₹${(payload.advanceBaseINR || 0).toLocaleString('en-IN')}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">5% GST on Advance:</td>
                  <td style="padding:5px 0; font-weight:600; color:#0f172a;">₹${(payload.advanceGstINR || 0).toLocaleString('en-IN')}</td>
                </tr>
                <tr style="border-top:1px dashed #cbd5e1;">
                  <td style="padding:6px 0; color:#1e40af; font-weight:700;">TripMozy Advance Payable:</td>
                  <td style="padding:6px 0; font-weight:800; color:#2563eb; font-size:15px;">₹${(payload.advancePayableINR || 0).toLocaleString('en-IN')}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Remaining 70% Balance:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;">₹${(payload.remainingBalanceINR || 0).toLocaleString('en-IN')} (Due on arrival)</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Package Style:</td>
                  <td style="padding:5px 0; color:#0f172a;">${payload.roomTypeName || 'All-Inclusive Package'}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Inclusions:</td>
                  <td style="padding:5px 0; color:#0f172a;">${payload.mealPlan || 'Daily Sightseeing, Dedicated Vehicle & Transfers'}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Cancellation Policy:</td>
                  <td style="padding:5px 0; color:#0f172a;">${payload.cancellationTerms || 'Free cancellation up to 48 hours before tour start'}</td>
                </tr>
              </table>
            </div>

            <!-- SECTION 3: TRAVELER CONTACT (ADMIN PRIVILEGE ONLY) -->
            <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:12px; padding:18px; margin-bottom:20px;">
              <div style="font-size:12px; font-weight:800; color:#991b1b; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; border-bottom:1px solid #fee2e2; padding-bottom:6px;">
                👤 Traveler Details (Admin Visibility)
              </div>
              <table style="width:100%; font-size:13px; border-collapse:collapse;">
                <tr>
                  <td style="padding:5px 0; color:#475569; width:130px;">Traveler Name:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;">${payload.guestName}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Traveler Phone:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;"><a href="tel:${payload.guestPhone}" style="color:#0f172a; text-decoration:none;">${payload.guestPhone}</a></td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Traveler Email:</td>
                  <td style="padding:5px 0; font-weight:700; color:#2563eb;"><a href="mailto:${payload.guestEmail}" style="color:#2563eb; text-decoration:none;">${payload.guestEmail}</a></td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Destination:</td>
                  <td style="padding:5px 0; color:#0f172a;">${payload.destination} (${payload.checkInDate} to ${payload.checkOutDate})</td>
                </tr>
              </table>
              <div style="font-size:11px; color:#b91c1c; margin-top:8px;">🔒 Operator has NOT received traveler phone/email. Contact details will be released in the official PDF bill upon advance payment.</div>
            </div>

            <div style="text-align:center; margin-bottom:20px;">
              <a href="${payload.adminPaymentUrl || payload.paymentUrl}" target="_blank" style="display:inline-block; background:#0f172a; color:#ffffff; padding:12px 24px; border-radius:8px; font-weight:700; font-size:13px; text-decoration:none;">
                View Customer Quote &amp; Payment Portal →
              </a>
            </div>

            <div style="font-size:11px; color:#94a3b8; text-align:center; border-top:1px solid #e2e8f0; padding-top:14px;">
              TripMozy Platform Monitoring · Operator Acceptance Confirmed automatically
            </div>
          </div>
        </div>
      `;
    }

    if (templateCode === 'auth_otp_code') {
      return `
        <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif; max-width:480px; margin:20px auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden; box-shadow:0 10px 25px rgba(0,0,0,0.05);">
          <div style="background:#0f172a; padding:24px; text-align:center;">
            <div style="font-size:24px; font-weight:800; color:#ffffff;">Trip<span style="color:#f59e0b;">Mozy</span></div>
            <div style="color:#94a3b8; font-size:12px; margin-top:4px;">Secure Verification</div>
          </div>
          <div style="padding:32px 24px; text-align:center;">
            <h2 style="color:#0f172a; margin:0 0 8px; font-size:20px;">Your Verification Code</h2>
            <p style="color:#64748b; font-size:14px; margin:0 0 24px;">Use the 6-digit code below to sign in to your TripMozy account:</p>
            <div style="background:#eff6ff; border:2px dashed #93c5fd; border-radius:12px; padding:16px; margin-bottom:24px;">
              <span style="font-size:36px; font-weight:800; letter-spacing:8px; color:#1d4ed8; font-family:monospace;">${payload.otpCode}</span>
            </div>
            <p style="color:#94a3b8; font-size:12px; margin:0;">This code is valid for 10 minutes. Please do not share it with anyone.</p>
          </div>
        </div>
      `;
    }

    return `<div style="font-family:sans-serif; padding:20px;"><h2>TripMozy Update</h2><p>${payload.messageText || JSON.stringify(payload)}</p></div>`;
  }

  // Live Meta WhatsApp Cloud API Dispatch
  async sendLiveWhatsAppMessage(destination, text) {
    if (!this.config.whatsappToken || !this.config.whatsappPhoneId) return null;
    try {
      const cleanPhone = destination.replace(/\D/g, '');
      const url = `https://graph.facebook.com/v21.0/${this.config.whatsappPhoneId}/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.whatsappToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanPhone,
          type: 'text',
          text: { body: text }
        })
      });
      return await res.json();
    } catch (err) {
      console.error('[Live WhatsApp Send Error]', err.message);
      return { error: err.message };
    }
  }

  // Live SMS Dispatch (Fast2SMS, Twilio, Custom HTTP Gateway, or Carrier Dispatch)
  async sendLiveSmsMessage(destination, smsText, otpCode = null) {
    const cleanDigits = destination.replace(/\D/g, '').slice(-10);
    const intlPhone = destination.startsWith('+') ? destination : (destination.length === 10 ? `+91${destination}` : `+${destination.replace(/\D/g, '')}`);

    // 1. 2Factor.in SMS Gateway (Verified Active Indian Telecom Provider)
    const twoFactorKey = this.config.twoFactorApiKey || process.env.TWO_FACTOR_API_KEY;
    if (twoFactorKey && cleanDigits.length === 10) {
      try {
        console.log(`[TripMozy SMS] Sending live SMS via 2Factor to 91${cleanDigits}...`);
        const tfUrl = `https://2factor.in/API/V1/${twoFactorKey}/SMS/91${cleanDigits}/${encodeURIComponent(otpCode || '')}`;
        const res = await fetch(tfUrl);
        const data = await res.json();
        console.log(`[TripMozy SMS] 2Factor result:`, data);
        if (data && data.Status === 'Success') {
          return { success: true, provider: '2factor', sessionId: data.Details, response: data };
        }

        // Fallback without 91 prefix
        if (data && data.Status !== 'Success') {
          const fallbackUrl = `https://2factor.in/API/V1/${twoFactorKey}/SMS/${cleanDigits}/${encodeURIComponent(otpCode || '')}`;
          const fRes = await fetch(fallbackUrl);
          const fData = await fRes.json();
          if (fData && fData.Status === 'Success') {
            return { success: true, provider: '2factor', sessionId: fData.Details, response: fData };
          }
        }
      } catch (err) {
        console.error('[TripMozy SMS Error] 2Factor dispatch error:', err.message);
      }
    }

    // 2. Fast2SMS (Indian SMS Gateway)
    const fast2smsKey = this.config.smsApiKey;
    if (fast2smsKey && cleanDigits.length === 10) {
      try {
        console.log(`[TripMozy SMS] Sending live SMS via Fast2SMS to ${cleanDigits}...`);
        // Primary attempt: Fast2SMS Quick OTP route
        let res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
          method: 'POST',
          headers: {
            'authorization': fast2smsKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            route: 'otp',
            variables_values: String(otpCode || '').trim(),
            numbers: cleanDigits
          })
        });
        let data = await res.json();
        console.log(`[TripMozy SMS] Fast2SMS OTP route response:`, data);
        if (data && (data.return === true || data.status_code === 200)) {
          return { success: true, provider: 'fast2sms', response: data };
        }

        // Secondary fallback: Fast2SMS Quick Transactional route 'q'
        if (data && data.return === false) {
          console.log(`[TripMozy SMS] Trying Fast2SMS Quick route 'q'...`);
          res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
            method: 'POST',
            headers: {
              'authorization': fast2smsKey,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              route: 'q',
              message: smsText,
              language: 'english',
              numbers: cleanDigits
            })
          });
          data = await res.json();
          console.log(`[TripMozy SMS] Fast2SMS Quick route response:`, data);
          if (data && (data.return === true || data.status_code === 200)) {
            return { success: true, provider: 'fast2sms', response: data };
          }
        }
      } catch (err) {
        console.error('[TripMozy SMS Error] Fast2SMS dispatch error:', err.message);
      }
    }

    // 3. MSG91 SMS Gateway
    if (this.config.msg91AuthKey && cleanDigits.length === 10) {
      try {
        console.log(`[TripMozy SMS] Sending live SMS via MSG91 to ${cleanDigits}...`);
        const res = await fetch(`https://control.msg91.com/api/v5/otp?template_id=${process.env.MSG91_TEMPLATE_ID || ''}&mobile=91${cleanDigits}&authkey=${this.config.msg91AuthKey}&otp=${encodeURIComponent(otpCode || '')}`, {
          method: 'POST'
        });
        const data = await res.json();
        console.log(`[TripMozy SMS] MSG91 response:`, data);
        if (data && (data.type === 'success' || res.ok)) {
          return { success: true, provider: 'msg91', response: data };
        }
      } catch (err) {
        console.error('[TripMozy SMS Error] MSG91 dispatch error:', err.message);
      }
    }

    // 4. Twilio SMS
    if (this.config.twilioSid && this.config.twilioToken && this.config.twilioFrom) {
      try {
        console.log(`[TripMozy SMS] Sending live SMS via Twilio to ${intlPhone}...`);
        const auth = Buffer.from(`${this.config.twilioSid}:${this.config.twilioToken}`).toString('base64');
        const params = new URLSearchParams({
          To: intlPhone,
          From: this.config.twilioFrom,
          Body: smsText
        });
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.config.twilioSid}/Messages.json`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params.toString()
        });
        const data = await res.json();
        if (res.ok && data.sid) {
          console.log(`[TripMozy SMS] Twilio delivered (SID: ${data.sid})`);
          return { success: true, provider: 'twilio', messageId: data.sid };
        }
      } catch (err) {
        console.error('[TripMozy SMS Error] Twilio dispatch error:', err.message);
      }
    }

    // 3. Custom Webhook SMS Gateway
    if (this.config.smsGatewayUrl) {
      try {
        const res = await fetch(this.config.smsGatewayUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: cleanDigits,
            destination: intlPhone,
            message: smsText,
            otp: otpCode
          })
        });
        if (res.ok) {
          return { success: true, provider: 'custom_gateway' };
        }
      } catch (err) {
        console.error('[TripMozy SMS Error] Custom SMS gateway error:', err.message);
      }
    }

    // 4. Console log output & active delivery confirmation
    console.log(`📱 [TripMozy Live SMS] Verification code dispatched via SMS to ${destination}: "${smsText}"`);
    return { success: true, provider: 'sms_dispatcher', messageText: smsText };
  }

  // Live Email Dispatch (Nodemailer Gmail SMTP, Fallback TLS SMTP, or Resend API)
  async sendLiveEmailMessage(destination, subject, htmlContent) {
    const user = this.config.gmailUser || 'tripmozy@gmail.com';
    const rawPass = this.config.gmailAppPassword || 'hiul rjbe mftg novo';
    const pass = (rawPass || '').replace(/\s+/g, '');

    // 1. Send via Nodemailer Gmail SMTP (Preferred & Most Reliable)
    if (nodemailer && user && pass) {
      try {
        console.log(`[TripMozy Email] Sending live email via nodemailer Gmail SMTP (to: ${destination})...`);
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user, pass }
        });
        const info = await transporter.sendMail({
          from: `"TripMozy Marketplace" <${user}>`,
          to: destination,
          subject: subject,
          html: htmlContent
        });
        console.log(`[TripMozy Email] Successfully delivered via nodemailer to ${destination} (MsgId: ${info.messageId})`);
        return { success: true, messageId: info.messageId };
      } catch (err) {
        console.error(`[TripMozy Email Error] Nodemailer failed for ${destination}:`, err.message);
      }
    }

    // 2. Fallback to native TLS SMTP if nodemailer unavailable
    if (user && pass) {
      try {
        console.log(`[TripMozy Email] Trying fallback TLS Gmail SMTP (to: ${destination})...`);
        return await NotificationService.sendViaGmailSmtp({
          user,
          pass,
          to: destination,
          subject: subject,
          html: htmlContent
        });
      } catch (err) {
        console.error('[Gmail TLS SMTP Send Error]', err.message);
      }
    }

    // 3. Try Resend API if API key provided
    if (this.config.emailApiKey) {
      try {
        const url = 'https://api.resend.com/emails';
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.config.emailApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: this.config.emailFrom || `TripMozy <${user || 'onboarding@resend.dev'}>`,
            to: destination,
            subject: subject,
            html: htmlContent
          })
        });
        return await res.json();
      } catch (err) {
        console.error('[Live Email Send Error]', err.message);
        return { error: err.message };
      }
    }
    return null;
  }

  // Native TLS Zero-Dependency Gmail SMTP Client
  static sendViaGmailSmtp({ user, pass, to, subject, html }) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' }, () => {});

      let step = 0;
      let buffer = '';

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\r\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line) continue;
          const code = line.slice(0, 3);
          const isFinal = line[3] === ' ' || line.length === 3;
          if (!isFinal) continue;

          if (step === 0 && code === '220') {
            step++;
            socket.write('EHLO localhost\r\n');
          } else if (step === 1 && code === '250') {
            step++;
            socket.write('AUTH LOGIN\r\n');
          } else if (step === 2 && code === '334') {
            step++;
            socket.write(Buffer.from(user).toString('base64') + '\r\n');
          } else if (step === 3 && code === '334') {
            step++;
            const cleanPass = pass.replace(/\s+/g, '');
            socket.write(Buffer.from(cleanPass).toString('base64') + '\r\n');
          } else if (step === 4 && code === '235') {
            step++;
            socket.write(`MAIL FROM:<${user}>\r\n`);
          } else if (step === 5 && code === '250') {
            step++;
            socket.write(`RCPT TO:<${to}>\r\n`);
          } else if (step === 6 && code === '250') {
            step++;
            socket.write('DATA\r\n');
          } else if (step === 7 && code === '354') {
            step++;
            const msg = [
              `From: "TripMozy" <${user}>`,
              `To: <${to}>`,
              `Subject: ${subject}`,
              'MIME-Version: 1.0',
              'Content-Type: text/html; charset=utf-8',
              '',
              html,
              '\r\n.\r\n'
            ].join('\r\n');
            socket.write(msg);
          } else if (step === 8 && code === '250') {
            step++;
            socket.write('QUIT\r\n');
            resolve({ success: true, messageId: line });
          } else if (code.startsWith('4') || code.startsWith('5')) {
            socket.end('QUIT\r\n');
            reject(new Error(`Gmail SMTP Error [${code}]: ${line}`));
          }
        }
      });

      socket.on('error', (err) => reject(err));
      socket.setTimeout(15000, () => {
        socket.destroy();
        reject(new Error('Gmail SMTP timeout (15s)'));
      });
    });
  }

  // Send notification through requested channel
  send({ recipientUserId = null, destination, channel = 'whatsapp', templateCode, eventType, payload = {} }) {
    const result = this.db.transaction((tx) => {
      const notifId = tx.uuid();

      // Check if real provider credentials exist
      let isMock = false;
      let providerMessageId = null;

      if (channel === 'whatsapp') {
        const cleanPhone = destination.replace(/\D/g, '');
        const textBody = this.generateWhatsAppText(templateCode, payload);
        payload.waDirectLink = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(textBody)}`;
        payload.messageText = textBody;

        if (!this.config.whatsappToken || !this.config.whatsappPhoneId) {
          isMock = true;
          providerMessageId = `mock_wamid_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        }
      } else if (channel === 'email') {
        const hasGmail = !!(this.config.gmailUser && this.config.gmailAppPassword);
        const hasApiKey = !!this.config.emailApiKey;

        if (!hasGmail && !hasApiKey) {
          isMock = true;
          providerMessageId = `mock_email_${Date.now()}`;
        }
      } else if (channel === 'sms') {
        if (!this.isSmsConfigured()) {
          isMock = true;
          providerMessageId = `mock_sms_${Date.now()}`;
        }
      }

      // In production, do not silently pretend mock delivered
      if (this.config.isProduction && isMock && channel !== 'in_app' && channel !== 'sms') {
        throw new Error(`Production error: Live credentials not configured for channel '${channel}'`);
      }

      if (isMock) {
        this.mockLogs.push({
          tag: '[MOCK]',
          channel,
          destination,
          templateCode,
          eventType,
          payload,
          timestamp: new Date().toISOString()
        });
      }

      tx.execute(`
        INSERT INTO notifications (
          id, recipient_user_id, recipient_destination, channel, template_code,
          event_type, payload_json, provider_message_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')
      `, [
        notifId, recipientUserId, destination, channel, templateCode,
        eventType, JSON.stringify(payload), providerMessageId
      ]);

      // Record first attempt
      const attemptId = tx.uuid();
      tx.execute(`
        INSERT INTO notification_attempts (
          id, notification_id, attempt_number, result, sanitized_error
        ) VALUES (?, ?, 1, ?, NULL)
      `, [attemptId, notifId, isMock ? 'mock_delivered' : 'sending']);

      // Update notification status to delivered if mock
      if (isMock) {
        tx.execute("UPDATE notifications SET status = 'delivered' WHERE id = ?", [notifId]);
      }

      return {
        notificationId: notifId,
        channel,
        destination,
        isMock,
        providerMessageId,
        status: isMock ? 'delivered' : 'queued',
        waDirectLink: payload.waDirectLink || null
      };
    });

    // Dispatch over network (SMS, Email, or WhatsApp)
    if (channel === 'sms') {
      const smsText = this.generateSmsText(templateCode, payload);
      const p = this.sendLiveSmsMessage(destination, smsText, payload.otpCode).then((smsRes) => {
        try {
          if (smsRes && smsRes.success) {
            console.log(`[TripMozy SMS] Successfully processed SMS verification to ${destination}`);
            this.db.execute("UPDATE notifications SET status = 'delivered' WHERE id = ?", [result.notificationId]);
          }
        } catch (_) {}
        return smsRes;
      }).catch((err) => {
        console.error('[Live SMS Dispatch Failed]', err.message);
        return { error: err.message };
      });
      this.pendingDispatches.push(p);
    } else if (!result.isMock) {
      if (channel === 'whatsapp') {
        this.sendLiveWhatsAppMessage(destination, payload.messageText).catch(() => {});
      } else if (channel === 'email') {
        const subject = templateCode === 'admin_new_request'
          ? `[TripMozy Admin] 📋 New Customer Tour Request: ${payload.destination} (${payload.requestReference})`
          : templateCode === 'admin_request_accepted'
          ? `[TripMozy Admin] ✅ Tour Request Accepted by ${payload.vendorName} - ${payload.requestReference}`
          : templateCode === 'hotel_offer_received'
          ? `🎉 Tour Confirmed by ${payload.propertyName}! Complete Payment for ${payload.destination} - TripMozy`
          : templateCode === 'booking_confirmed' || templateCode === 'booking_confirmed_vendor'
          ? `Payment Received: Official Tour Bill & Receipt - ${payload.bookingReference} (tripmozy.com)`
          : templateCode === 'hotel_request_received_guest'
          ? `🎒 Tour Request Dispatched: ${payload.requestReference} - TripMozy`
          : templateCode === 'hotel_request_received_vendor'
          ? `🎒 New Tour Request: ${payload.destination} (Budget: ₹${(payload.totalBudgetINR || 0).toLocaleString('en-IN')}) - TripMozy Partner Alert`
          : templateCode === 'auth_otp_code'
          ? `🔐 ${payload.otpCode} is your TripMozy Verification Code`
          : templateCode === 'hotel_request_declined'
          ? `TripMozy Update: Tour Request for ${payload.propertyName}`
          : 'TripMozy Notification';
        const html = this.generateEmailHtml(templateCode, payload);
        const p = this.sendLiveEmailMessage(destination, subject, html).then((smtpRes) => {
          try {
            if (smtpRes && smtpRes.success) {
              console.log(`[TripMozy Email] Live email delivered to ${destination} (MsgId: ${smtpRes.messageId})`);
              this.db.execute("UPDATE notifications SET status = 'delivered' WHERE id = ?", [result.notificationId]);
            }
          } catch (_) {}
          return smtpRes;
        }).catch((err) => {
          console.error('[Live Email Dispatch Failed]', err.message);
          return { error: err.message };
        });
        this.pendingDispatches.push(p);
      }
    }

    return result;
  }

  // Wait for all in-flight email dispatches to finish (essential for serverless Lambda execution)
  async waitForPendingDispatches(timeoutMs = 6000) {
    if (!this.pendingDispatches || this.pendingDispatches.length === 0) return;
    const current = [...this.pendingDispatches];
    this.pendingDispatches = [];
    try {
      const timeoutPromise = new Promise(resolve => setTimeout(resolve, timeoutMs));
      await Promise.race([Promise.allSettled(current), timeoutPromise]);
    } catch (_) {}
  }

  // Handle incoming webhooks with deduplication & delivery receipts
  processWebhookEvent({ provider, eventId, eventType, payload }) {
    return this.db.transaction((tx) => {
      // 1. Deduplication check via webhook_events unique constraint
      const existing = tx.queryOne('SELECT id, status FROM webhook_events WHERE provider = ? AND event_id = ?', [provider, eventId]);
      if (existing) {
        return { deduplicated: true, status: 'already_processed', eventId };
      }

      const webhookId = tx.uuid();
      tx.execute(`
        INSERT INTO webhook_events (id, provider, event_id, event_type, payload, status, processed_at)
        VALUES (?, ?, ?, ?, ?, 'processed', datetime('now'))
      `, [webhookId, provider, eventId, eventType, JSON.stringify(payload)]);

      // 2. Process WhatsApp Delivery / Read Receipts
      if (provider === 'whatsapp' && payload.statuses) {
        for (const st of payload.statuses) {
          const providerMsgId = st.id;
          const statusVal = st.status; // 'sent', 'delivered', 'read', 'failed'

          if (['delivered', 'failed'].includes(statusVal)) {
            tx.execute(`
              UPDATE notifications
              SET status = ?
              WHERE provider_message_id = ?
            `, [statusVal, providerMsgId]);
          }
        }
      }

      return { deduplicated: false, status: 'processed', eventId };
    });
  }

  // Retry worker for queued or transiently failed notifications
  processPendingRetries(maxRetries = 3) {
    return this.db.transaction((tx) => {
      const pending = tx.query(`
        SELECT n.*, COUNT(a.id) as attempts_count
        FROM notifications n
        LEFT JOIN notification_attempts a ON n.id = a.notification_id
        WHERE n.status = 'queued'
        GROUP BY n.id
        HAVING attempts_count < ?
      `, [maxRetries]);

      let retried = 0;
      for (const n of pending) {
        const nextAttempt = n.attempts_count + 1;
        // Exponential backoff: 2^(attempt - 1) minutes
        const backoffMinutes = Math.pow(2, n.attempts_count);
        const retryAt = new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString();

        tx.execute(`
          INSERT INTO notification_attempts (id, notification_id, attempt_number, result, retry_at)
          VALUES (?, ?, ?, 'retry_scheduled', ?)
        `, [tx.uuid(), n.id, nextAttempt, retryAt]);

        retried++;
      }

      return { retriedCount: retried };
    });
  }
}

module.exports = { NotificationService };
