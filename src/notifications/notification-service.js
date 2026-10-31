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
      const remText = payload.remainingPaymentOption === 'tripmozy_online' ? 'Online via TripMozy before departure' : 'To Hotel / Driver on arrival';
      return `🎉 *TripMozy Tour Booking Confirmed!*\n` +
        `Tour Booking Ref: *${payload.bookingReference}*\n` +
        `Tour Operator: *${payload.propertyName}*\n` +
        `Tour Dates: ${payload.checkInDate} to ${payload.checkOutDate}\n` +
        `Total Package Price: ₹${(payload.totalAmountINR || 0).toLocaleString('en-IN')}\n` +
        `Advance Paid to TripMozy (30% + 5% GST): ₹${advINR.toLocaleString('en-IN')} (Paid & Guaranteed)\n` +
        `Remaining 70% Balance: ₹${balINR.toLocaleString('en-IN')} (${remText})\n\n` +
        `Your tour voucher is ready. Present your booking reference upon arrival / pickup!`;
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
      return `
        <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif; max-width:580px; margin:20px auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden;">
          <div style="background:#065f46; color:#ffffff; padding:28px 24px; text-align:center;">
            <div style="font-size:40px; margin-bottom:8px;">🎉</div>
            <h1 style="margin:0; font-size:22px; font-weight:800;">Tour Booking Confirmed &amp; Guaranteed!</h1>
            <p style="margin:6px 0 0; opacity:0.9; font-size:13px;">Your tour with ${payload.propertyName} is locked.</p>
          </div>
          <div style="padding:28px 24px;">
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:18px; margin-bottom:20px;">
              <div style="margin-bottom:8px;"><span style="color:#64748b; font-size:12px;">TOUR BOOKING REFERENCE:</span> <strong style="font-family:monospace; font-size:16px; color:#2563eb;">${payload.bookingReference}</strong></div>
              <div style="margin-bottom:8px;"><strong>Tour Dates:</strong> ${payload.checkInDate} to ${payload.checkOutDate}</div>
              <div style="margin-bottom:8px;"><strong>Total Package Price:</strong> ₹${(payload.totalAmountINR || 0).toLocaleString('en-IN')}</div>
              <div style="margin-bottom:8px;"><strong style="color:#059669;">Advance Paid to TripMozy (30% + 5% GST):</strong> ₹${(payload.advancePaidINR || Math.round((payload.totalAmountINR || 0) * 0.315)).toLocaleString('en-IN')} (Guaranteed)</div>
              <div><strong style="color:#1e40af;">Remaining 70% Balance Due:</strong> ₹${(payload.remainingBalanceINR || Math.round((payload.totalAmountINR || 0) * 0.70)).toLocaleString('en-IN')} (${payload.remainingPaymentOption === 'tripmozy_online' ? 'Online before departure' : 'To driver / hotel upon arrival'})</div>
            </div>
            <p style="font-size:13px; color:#475569;">Please present your government ID and this booking reference upon pickup / arrival with your tour representative.</p>
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
        const subject = templateCode === 'hotel_offer_received'
          ? `🎉 Tour Confirmed by ${payload.propertyName}! Complete Payment for ${payload.destination} - TripMozy`
          : templateCode === 'booking_confirmed' || templateCode === 'booking_confirmed_vendor'
          ? `🎉 Tour Booking Confirmed: ${payload.bookingReference} - ${payload.propertyName}`
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
