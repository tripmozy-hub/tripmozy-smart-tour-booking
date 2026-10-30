// ============================================================================
// TripMozy Multi-Channel Notification Service & Webhook Engine
// Provider-independent architecture with WhatsApp Cloud API, Email, SMS & In-App
// ============================================================================

const crypto = require('node:crypto');
const tls = require('node:tls');

class NotificationService {
  constructor(db, config = {}) {
    this.db = db;
    this.config = {
      isProduction: config.isProduction || false,
      whatsappToken: config.whatsappToken || process.env.WHATSAPP_ACCESS_TOKEN || null,
      whatsappPhoneId: config.whatsappPhoneId || process.env.WHATSAPP_PHONE_NUMBER_ID || null,
      whatsappSecret: config.whatsappSecret || process.env.WHATSAPP_APP_SECRET || 'tripmozy_dev_secret',
      gmailUser: config.gmailUser || process.env.GMAIL_USER || 'tripmozy@gmail.com',
      gmailAppPassword: config.gmailAppPassword || process.env.GMAIL_APP_PASSWORD || null,
      emailApiKey: config.emailApiKey || process.env.EMAIL_PROVIDER_API_KEY || null,
      smsApiKey: config.smsApiKey || process.env.SMS_PROVIDER_API_KEY || null,
      ...config
    };
    this.mockLogs = [];
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
    if (templateCode === 'hotel_request_received') {
      return `🎒 *TripMozy Tour Request Alert!*\n` +
        `Hi Partner, a new tour request matches your package / region *${payload.propertyName || 'Verified Tour Operator'}*!\n\n` +
        `📍 Destination: ${payload.destination || 'India'}\n` +
        `📅 Dates: ${payload.checkInDate} to ${payload.checkOutDate} (${payload.nights}n)\n` +
        `👥 Travelers & Setup: ${payload.numAdults} Adults · ${payload.numRooms} Vehicle\n` +
        `💰 Traveler Budget: ₹${(payload.totalBudgetINR || 0).toLocaleString('en-IN')}\n\n` +
        `⚡ Quick Action (No login required):\n` +
        `👉 Tap to Accept & Send Tour Quote: http://localhost:8080/action?token=${payload.rawToken}&action=accept\n` +
        `👉 Tap to Decline: http://localhost:8080/action?token=${payload.rawToken}&action=reject`;
    }

    if (templateCode === 'hotel_offer_received') {
      const advINR = payload.advancePayableINR || Math.round((payload.totalAmountINR || 0) * 0.315);
      const balINR = payload.remainingBalanceINR || Math.round((payload.totalAmountINR || 0) * 0.70);
      return `🎒 *TripMozy Tour Quote Received!*\n` +
        `Hi ${payload.guestName || 'Traveler'}, great news!\n` +
        `*${payload.propertyName}* in ${payload.destination} has accepted your tour request and sent you an official quote:\n\n` +
        `🎒 Package: ${payload.roomTypeName || 'All-Inclusive Tour Package'}\n` +
        `🍽️ Inclusions: ${payload.mealPlan || 'Sightseeing & Transfers Included'}\n` +
        `💰 Total Tour Price: ₹${(payload.totalAmountINR || 0).toLocaleString('en-IN')}\n` +
        `💳 Payable Now (30% Advance + 5% GST): ₹${advINR.toLocaleString('en-IN')} (to TripMozy Account)\n` +
        `🏨 Remaining 70% Balance: ₹${balINR.toLocaleString('en-IN')} (pay at hotel on arrival or online)\n` +
        `🛡️ Terms: ${payload.cancellationTerms || 'Free cancellation up to 48 hours before departure'}\n\n` +
        `⚡ Review quote and secure your tour:\n` +
        `👉 View & Book Now: ${payload.bookingUrl || 'http://localhost:8080/booking'}`;
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

  // Generate formatted HTML email template
  generateEmailHtml(templateCode, payload) {
    if (templateCode === 'hotel_offer_received') {
      return `
        <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif; max-width:580px; margin:20px auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden; box-shadow:0 10px 25px rgba(0,0,0,0.05);">
          <div style="background:#0f172a; padding:24px; text-align:center;">
            <div style="font-size:24px; font-weight:800; color:#ffffff;">Trip<span style="color:#f59e0b;">Mozy</span></div>
            <div style="color:#94a3b8; font-size:12px; margin-top:4px;">Memories Begin With a Booking</div>
          </div>
          <div style="padding:28px 24px;">
            <div style="display:inline-block; background:#d1fae5; color:#065f46; font-size:12px; font-weight:700; padding:4px 12px; border-radius:20px; margin-bottom:12px;">✓ Verified Partner Tour Quote</div>
            <h2 style="color:#0f172a; margin:0 0 8px; font-size:20px;">New Tour Quote from ${payload.propertyName}!</h2>
            <p style="color:#64748b; font-size:14px; margin:0 0 20px;">Hi ${payload.guestName || 'Traveler'}, a verified tour operator has accepted your tour request and sent you an official quote.</p>
            
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:18px; margin-bottom:24px;">
              <div style="margin-bottom:8px;">
                <span style="color:#64748b; font-size:13px;">Tour Operator / Base:</span>
                <strong style="color:#0f172a; font-size:14px; margin-left:8px;">${payload.propertyName} (${payload.destination})</strong>
              </div>
              <div style="margin-bottom:8px;">
                <span style="color:#64748b; font-size:13px;">Tour Package:</span>
                <strong style="color:#0f172a; font-size:14px; margin-left:8px;">${payload.roomTypeName || 'All-Inclusive Tour Package'}</strong>
              </div>
              <div style="margin-bottom:8px;">
                <span style="color:#64748b; font-size:13px;">Inclusions:</span>
                <strong style="color:#059669; font-size:14px; margin-left:8px;">${payload.mealPlan || 'Sightseeing &amp; Transfers Included'}</strong>
              </div>
              <div style="margin-bottom:8px;">
                <span style="color:#64748b; font-size:13px;">Cancellation:</span>
                <span style="color:#0f172a; font-size:13px; margin-left:8px;">${payload.cancellationTerms || 'Free cancellation up to 48 hours before departure'}</span>
              </div>
              <div style="padding-top:12px; border-top:1.5px solid #e2e8f0; margin-top:10px; display:flex; justify-content:space-between; align-items:center;">
                <span style="color:#0f172a; font-weight:700; font-size:15px;">Total Tour Package:</span>
                <strong style="color:#2563eb; font-size:20px;">₹${(payload.totalAmountINR || 0).toLocaleString('en-IN')}</strong>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; font-size:13px;">
                <span style="color:#065f46; font-weight:700;">Payable Now (30% Advance + 5% GST):</span>
                <strong style="color:#059669;">₹${(payload.advancePayableINR || Math.round((payload.totalAmountINR || 0) * 0.315)).toLocaleString('en-IN')}</strong>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px; font-size:12px; color:#64748b;">
                <span>Remaining 70% Balance Due:</span>
                <span style="font-weight:600;">₹${(payload.remainingBalanceINR || Math.round((payload.totalAmountINR || 0) * 0.70)).toLocaleString('en-IN')} (pay at hotel or online)</span>
              </div>
              <div style="text-align:right; font-size:11px; color:#94a3b8; margin-top:4px;">Advance secured in TripMozy Escrow</div>
            </div>

            <div style="text-align:center; margin-bottom:24px;">
              <a href="${payload.bookingUrl || 'http://localhost:8080/booking'}" style="display:inline-block; background:#2563eb; color:#ffffff; font-weight:700; font-size:15px; padding:14px 32px; border-radius:10px; text-decoration:none; box-shadow:0 4px 14px rgba(37,99,235,0.3);">
                ⚡ View Tour Quote &amp; Book Now
              </a>
            </div>
            
            <p style="color:#94a3b8; font-size:12px; text-align:center; margin:0;">Quotes are limited. Place an exclusive 15-minute hold to lock this tour package tariff.</p>
          </div>
          <div style="background:#f1f5f9; padding:16px; text-align:center; font-size:12px; color:#64748b;">
            TripMozy Marketplace · Powered by tripmozy.com
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

  // Live Email Dispatch (Gmail SMTP or Resend API)
  async sendLiveEmailMessage(destination, subject, htmlContent) {
    // 1. Try Gmail SMTP if configured
    if (this.config.gmailUser && this.config.gmailAppPassword) {
      try {
        console.log(`[TripMozy Email] Sending live email via Gmail SMTP (from: ${this.config.gmailUser} to: ${destination})...`);
        return await NotificationService.sendViaGmailSmtp({
          user: this.config.gmailUser,
          pass: this.config.gmailAppPassword,
          to: destination,
          subject: subject,
          html: htmlContent
        });
      } catch (err) {
        console.error('[Gmail SMTP Send Error]', err.message);
      }
    }

    // 2. Try Resend API if API key provided
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
            from: this.config.emailFrom || `TripMozy <${this.config.gmailUser || 'onboarding@resend.dev'}>`,
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
        if (!this.config.smsApiKey) {
          isMock = true;
          providerMessageId = `mock_sms_${Date.now()}`;
        }
      }

      // In production, do not silently pretend mock delivered
      if (this.config.isProduction && isMock && channel !== 'in_app') {
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

    // If live credentials are provided, dispatch over real network
    if (!result.isMock) {
      if (channel === 'whatsapp') {
        this.sendLiveWhatsAppMessage(destination, payload.messageText).catch(() => {});
      } else if (channel === 'email') {
        const subject = templateCode === 'hotel_offer_received'
          ? `🎒 New Tour Quote: ${payload.propertyName} (${payload.destination}) - TripMozy`
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
        this.sendLiveEmailMessage(destination, subject, html).then((smtpRes) => {
          try {
            if (smtpRes && smtpRes.success) {
              console.log(`[TripMozy Email] Live email delivered to ${destination} (MsgId: ${smtpRes.messageId})`);
              this.db.execute("UPDATE notifications SET status = 'delivered' WHERE id = ?", [result.notificationId]);
            }
          } catch (_) {}
        }).catch((err) => {
          console.error('[Live Email Dispatch Failed]', err.message);
        });
      }
    }

    return result;
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
