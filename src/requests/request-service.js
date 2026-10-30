// ============================================================================
// TripMozy Customer Stay Request Service
// Handles validation, rate limiting, persistence, and state transitions
// ============================================================================

const crypto = require('node:crypto');
const { PricingEngine } = require('../matching/pricing-engine');
const { MatchingEngine } = require('../matching/matching-engine');

class RequestService {
  constructor(db, notifService = null) {
    this.db = db;
    this.notifService = notifService;
    this.matchingEngine = new MatchingEngine(db);
    this.rateLimitMap = new Map(); // In-memory rate limiting map
  }

  // Generate reference like TM-REQ-20261028-A4F9
  static generateReference() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `TM-REQ-${today}-${rand}`;
  }

  // Rate limiter: Max 5 requests per phone/email per 10 minutes
  checkRateLimit(key) {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const timestamps = (this.rateLimitMap.get(key) || []).filter(ts => now - ts < windowMs);

    if (timestamps.length >= 5) {
      throw new Error('Too many requests submitted. Please wait a few minutes before submitting another request.');
    }

    timestamps.push(now);
    this.rateLimitMap.set(key, timestamps);
  }

  // Validate and submit stay request
  submitStayRequest({
    guestName,
    guestEmail,
    guestPhone,
    destination,
    destinationLocality = null,
    targetCoords = null,
    checkInDate,
    checkOutDate,
    numRooms = 1,
    numAdults = 2,
    numChildren = 0,
    childrenAges = [],
    totalBudgetINR,
    propertyTypePreference = null,
    roomPreference = 'any',
    requiredFacilities = [],
    communicationConsent = true,
    termsAccepted = true,
    customerId = null,
    ipAddress = null
  }) {
    // 1. Basic validation
    if (!guestName || guestName.trim().length < 2) {
      throw new Error('Guest full name is required');
    }
    if (!guestEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) {
      throw new Error('Valid email address is required');
    }
    if (!guestPhone || guestPhone.replace(/\D/g, '').length < 10) {
      throw new Error('Valid 10-digit mobile phone number is required');
    }
    if (!destination || destination.trim().length < 2) {
      throw new Error('Destination city or locality is required');
    }
    if (!termsAccepted) {
      throw new Error('You must accept the booking terms to submit a request');
    }

    // 2. Dates & Nights
    const nights = PricingEngine.calculateNights(checkInDate, checkOutDate);
    const todayStr = new Date().toISOString().split('T')[0];
    if (checkInDate < todayStr) {
      throw new Error('Check-in date cannot be in the past');
    }

    // 3. Occupancy & Budget
    if (numRooms < 1 || numRooms > 10) {
      throw new Error('Number of rooms must be between 1 and 10');
    }
    if (numAdults < 1) {
      throw new Error('At least 1 adult guest is required');
    }

    const budgetNum = parseFloat(totalBudgetINR);
    if (isNaN(budgetNum) || budgetNum <= 0) {
      throw new Error('Total stay budget must be a positive amount in INR');
    }
    const totalBudgetPaise = Math.round(budgetNum * 100);

    // 4. Rate Limiting Check
    this.checkRateLimit(guestPhone);

    // 5. Run matching to find candidate hotels
    const matchResult = this.matchingEngine.findMatches({
      destination,
      targetCoords,
      checkInDate,
      checkOutDate,
      numRooms,
      numAdults,
      numChildren,
      totalBudgetPaise,
      propertyType: propertyTypePreference,
      roomPreference,
      requiredFacilities
    });

    const initialStatus = matchResult.totalMatches > 0 ? 'awaiting_responses' : 'no_matches';

    // 6. Persist in database transaction
    return this.db.transaction((tx) => {
      const requestId = tx.uuid();
      const reference = RequestService.generateReference();

      // Ensure customer user profile exists or create guest profile
      let finalCustomerId = customerId;
      if (!finalCustomerId) {
        const existingProfile = tx.queryOne('SELECT id FROM user_profiles WHERE email = ?', [guestEmail]);
        if (existingProfile) {
          finalCustomerId = existingProfile.id;
        } else {
          finalCustomerId = tx.uuid();
          tx.execute(`
            INSERT INTO user_profiles (id, email, phone, role, display_name, status, is_phone_verified, is_email_verified)
            VALUES (?, ?, ?, 'customer', ?, 'active', 0, 0)
          `, [finalCustomerId, guestEmail, guestPhone, guestName]);
        }
      }

      // 2 hours expiry for vendor responses
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

      tx.execute(`
        INSERT INTO hotel_booking_requests (
          id, request_reference, customer_id, guest_name, guest_email, guest_phone,
          destination, destination_locality, check_in_date, check_out_date,
          nights, num_rooms, num_adults, num_children, children_ages,
          total_budget_paise, property_type_preference, room_preference,
          required_facilities, communication_consent, terms_accepted,
          status, max_recipients, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10, ?)
      `, [
        requestId, reference, finalCustomerId, guestName, guestEmail, guestPhone,
        destination, destinationLocality, checkInDate, checkOutDate,
        nights, numRooms, numAdults, numChildren, JSON.stringify(childrenAges),
        totalBudgetPaise, propertyTypePreference, roomPreference,
        JSON.stringify(requiredFacilities), communicationConsent ? 1 : 0, termsAccepted ? 1 : 0,
        initialStatus, expiresAt
      ]);

      // 7. Queue recipients for matched properties and notify each vendor ONCE together
      let topMatches = matchResult.matches.slice(0, 10);

      // If no catalog matches found (e.g. custom unlisted tour destination),
      // dispatch to primary verified tour operator so request is never lost
      if (topMatches.length === 0 && (!matchResult.diagnostics || matchResult.diagnostics.length === 0)) {
        const fallbackProps = tx.query(`
          SELECT p.*, v.id as vendor_id
          FROM properties p
          JOIN vendor_accounts v ON p.vendor_id = v.id
          WHERE p.status = 'active'
          ORDER BY p.star_rating DESC
          LIMIT 5
        `);
        if (fallbackProps.length > 0) {
          topMatches = fallbackProps.map(prop => {
            const room = tx.queryOne('SELECT * FROM room_types WHERE property_id = ? AND is_active = 1 LIMIT 1', [prop.id]);
            return {
              property: {
                id: prop.id,
                vendorId: prop.vendor_id,
                name: prop.name,
                city: prop.city,
                state: prop.state,
                starRating: prop.star_rating
              },
              matchedRoom: {
                id: room ? room.id : prop.id,
                name: room ? room.name : 'Custom Tour Package'
              },
              pricing: {
                totalPayablePaise: totalBudgetPaise
              }
            };
          });
          tx.execute("UPDATE hotel_booking_requests SET status = 'awaiting_responses' WHERE id = ?", [requestId]);
        }
      }

      const notifiedVendors = new Set();

      for (const m of topMatches) {
        const recipientId = tx.uuid();
        const rawToken = crypto.randomBytes(16).toString('hex');
        const actionTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

        tx.execute(`
          INSERT INTO booking_request_recipients (
            id, request_id, property_id, vendor_id, delivery_status, response_status,
            expires_at, action_token_hash
          ) VALUES (?, ?, ?, ?, 'queued', 'pending', ?, ?)
        `, [
          recipientId, requestId, m.property.id, m.property.vendorId, expiresAt, actionTokenHash
        ]);

        // Automated WhatsApp & Email Notification: notify each distinct eligible vendor ONCE together
        if (this.notifService && !notifiedVendors.has(m.property.vendorId)) {
          notifiedVendors.add(m.property.vendorId);
          const vendor = tx.queryOne('SELECT contact_phone, contact_email, contact_person, business_name FROM vendor_accounts WHERE id = ?', [m.property.vendorId]);
          
          // 1. WhatsApp alert to vendor.contact_phone
          const vendorPhone = (vendor && vendor.contact_phone) || '+917478290140';
          this.notifService.send({
            recipientUserId: null,
            destination: vendorPhone,
            channel: 'whatsapp',
            templateCode: 'hotel_request_received',
            eventType: 'request.dispatched',
            payload: {
              recipientId,
              propertyId: m.property.id,
              propertyName: m.property.name,
              requestReference: reference,
              destination,
              checkInDate,
              checkOutDate,
              nights,
              numRooms,
              numAdults,
              totalBudgetINR: budgetNum,
              rawToken,
              actionUrl: `/action?token=${rawToken}`
            }
          });

          // 2. Main Email alert to vendor: ensure both tripmozy@gmail.com and partner inboxes receive it
          const targetEmails = new Set();
          if (vendor && vendor.contact_email) targetEmails.add(vendor.contact_email);
          targetEmails.add('tripmozy@gmail.com');
          targetEmails.add('sujansutradhar2004@gmail.com');

          for (const destEmail of targetEmails) {
            try {
              this.notifService.send({
                recipientUserId: null,
                destination: destEmail,
                channel: 'email',
                templateCode: 'hotel_request_received_vendor',
                eventType: 'request.dispatched',
                payload: {
                  recipientId,
                  vendorId: m.property.vendorId,
                  vendorName: (vendor && (vendor.business_name || vendor.contact_person)) || 'TripMozy Verified Tour Operator',
                  propertyId: m.property.id,
                  propertyName: m.property.name,
                  requestReference: reference,
                  destination,
                  checkInDate,
                  checkOutDate,
                  nights,
                  numRooms,
                  numAdults,
                  totalBudgetINR: budgetNum,
                  rawToken,
                  actionUrl: `http://localhost:8080/action?token=${rawToken}&action=accept`,
                  rejectUrl: `http://localhost:8080/action?token=${rawToken}&action=reject`,
                  dashboardUrl: `http://localhost:8080/partner/dashboard?vendorId=${m.property.vendorId}`
                }
              });
            } catch (err) {
              console.error('[Vendor Dispatch Email Error]', destEmail, err.message);
            }
          }
        }
      }

      // Automated Confirmation to Customer via Email & WhatsApp
      if (this.notifService) {
        const bookingUrl = `http://localhost:8080/booking?id=${requestId}`;
        if (guestEmail) {
          try {
            this.notifService.send({
              destination: guestEmail,
              channel: 'email',
              templateCode: 'hotel_request_received_guest',
              eventType: 'request.created',
              payload: {
                guestName,
                requestReference: reference,
                destination,
                checkInDate,
                checkOutDate,
                nights,
                numRooms,
                numAdults,
                totalBudgetINR: budgetNum,
                bookingUrl
              }
            });
          } catch (_) {}
        }
        if (guestPhone) {
          try {
            this.notifService.send({
              destination: guestPhone,
              channel: 'whatsapp',
              templateCode: 'hotel_request_received_guest',
              eventType: 'request.created',
              payload: {
                guestName,
                requestReference: reference,
                destination,
                checkInDate,
                checkOutDate,
                nights,
                numRooms,
                numAdults,
                totalBudgetINR: budgetNum,
                bookingUrl
              }
            });
          } catch (_) {}
        }
      }

      tx.logAudit({
        actorId: finalCustomerId,
        actorRole: 'customer',
        action: 'request.submit',
        entityType: 'hotel_booking_request',
        entityId: requestId,
        afterState: { reference, destination, nights, numRooms, totalBudgetPaise, matchedHotels: topMatches.length },
        ipAddress
      });

      const finalStatus = topMatches.length > 0 ? 'awaiting_responses' : initialStatus;
      return {
        id: requestId,
        reference,
        status: finalStatus,
        destination,
        nights,
        numRooms,
        totalBudgetINR: budgetNum,
        matchedCount: topMatches.length,
        expiresAt,
        message: `Tour request created successfully! Contacting ${topMatches.length} eligible TripMozy tour operators in ${destination}.`
      };
    });
  }

  // Get request details by ID or reference
  getRequestDetails(requestId) {
    const req = this.db.queryOne('SELECT * FROM hotel_booking_requests WHERE id = ? OR request_reference = ?', [requestId, requestId]);
    if (!req) return null;

    const actualId = req.id;
    const recipients = this.db.query(`
      SELECT r.*, p.name as property_name, p.city as property_city, p.star_rating
      FROM booking_request_recipients r
      JOIN properties p ON r.property_id = p.id
      WHERE r.request_id = ?
    `, [actualId]);

    const offers = this.db.query(`
      SELECT o.*, p.name as property_name, p.city as property_city, p.star_rating,
             rt.name as room_type_name
      FROM hotel_offers o
      JOIN properties p ON o.property_id = p.id
      JOIN room_types rt ON o.room_type_id = rt.id
      WHERE o.request_id = ?
    `, [actualId]);

    const enrichedOffers = offers.map(o => {
      const tourPricing = PricingEngine.calculateTourPricing(o.total_payable_paise);
      return {
        ...o,
        tourPricing
      };
    });

    let booking = null;
    if (req.status === 'booked') {
      const b = this.db.queryOne('SELECT * FROM bookings WHERE request_id = ? ORDER BY created_at DESC LIMIT 1', [actualId]);
      if (b) {
        let terms = {};
        try {
          terms = JSON.parse(b.terms_snapshot || '{}');
        } catch (_) {}
        booking = {
          ...b,
          terms_snapshot: terms
        };
      }
    }

    return {
      request: req,
      recipients,
      offers: enrichedOffers,
      booking
    };
  }
}

module.exports = { RequestService };
