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

    // 5. Run matching to find candidate hotels/fleet bases
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

    // In a nationwide tour marketplace, all active tour operators quote custom tour packages for any destination
    const initialStatus = 'awaiting_responses';

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

      // 7. BROADCAST TO ALL ACTIVE TOUR OPERATOR VENDORS SIMULTANEOUSLY
      // Guarantees every active tour operator receives the customer's tour request in their dashboard.
      const activeVendors = tx.query("SELECT id, business_name, contact_phone, contact_email FROM vendor_accounts WHERE status = 'active'");

      // Map any catalog properties matching the requested destination
      const matchedPropByVendor = new Map();
      if (matchResult && matchResult.matches && matchResult.matches.length > 0) {
        for (const m of matchResult.matches) {
          if (!matchedPropByVendor.has(m.property.vendorId)) {
            matchedPropByVendor.set(m.property.vendorId, m.property);
          }
        }
      }

      const notifiedVendors = new Set();
      let dispatchedCount = 0;

      for (const vendor of activeVendors) {
        // Choose best property for this vendor:
        // 1. Direct destination-matched property if found
        // 2. Or the vendor's primary active property
        let chosenProp = matchedPropByVendor.get(vendor.id);
        if (!chosenProp) {
          chosenProp = tx.queryOne(
            "SELECT id, name, city, state, star_rating FROM properties WHERE vendor_id = ? AND status = 'active' ORDER BY star_rating DESC LIMIT 1",
            [vendor.id]
          );
        }

        if (!chosenProp) {
          // Auto-generate tour fleet profile for vendor if missing
          const newPropId = tx.uuid();
          tx.execute(`
            INSERT INTO properties (
              id, vendor_id, name, slug, property_type, star_rating,
              description, address_line, city, state, pincode, country,
              latitude, longitude, timezone, check_in_time, check_out_time,
              status, inventory_mode
            ) VALUES (?, ?, ?, ?, 'hotel', 4.8, ?, 'India Operations', 'All Destinations', 'India', '110001', 'India', 28.6139, 77.2090, 'Asia/Kolkata', '12:00', '11:00', 'active', 'vendor_confirmed')
          `, [
            newPropId,
            vendor.id,
            `${vendor.business_name} - Tour Fleet`,
            `fleet-${vendor.id.slice(0, 8)}-${Date.now()}`,
            `Verified Tour Operator Partner (${vendor.business_name})`
          ]);
          chosenProp = { id: newPropId, name: `${vendor.business_name} - Tour Fleet` };
        }

        // Ensure this property has at least one active room_type and rate so the vendor can accept quotes instantly
        let room = tx.queryOne('SELECT id FROM room_types WHERE property_id = ? AND is_active = 1 LIMIT 1', [chosenProp.id]);
        if (!room) {
          const roomTypeId = tx.uuid();
          tx.execute(`
            INSERT INTO room_types (id, property_id, name, bed_type, max_adults, max_children, total_inventory, is_ac, is_active)
            VALUES (?, ?, 'Custom Tour Package', 'King', 4, 2, 20, 1, 1)
          `, [roomTypeId, chosenProp.id]);
          const rateId = tx.uuid();
          tx.execute(`
            INSERT INTO room_rates (id, room_type_id, rate_plan_name, base_nightly_rate_paise, tax_rate_basis_points, meal_plan, is_active)
            VALUES (?, ?, 'Standard Package', 350000, 500, 'Breakfast Included', 1)
          `, [rateId, roomTypeId]);
        }

        const recipientId = tx.uuid();
        const rawToken = crypto.randomBytes(16).toString('hex');
        const actionTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

        tx.execute(`
          INSERT INTO booking_request_recipients (
            id, request_id, property_id, vendor_id, delivery_status, response_status,
            expires_at, action_token_hash
          ) VALUES (?, ?, ?, ?, 'queued', 'pending', ?, ?)
        `, [
          recipientId, requestId, chosenProp.id, vendor.id, expiresAt, actionTokenHash
        ]);

        dispatchedCount++;

        // Automated WhatsApp & Email Notification: notify each distinct vendor ONCE together
        if (this.notifService && !notifiedVendors.has(vendor.id)) {
          notifiedVendors.add(vendor.id);
          
          // 1. WhatsApp alert to vendor.contact_phone
          const vendorPhone = vendor.contact_phone;
          if (vendorPhone) {
            this.notifService.send({
              recipientUserId: null,
              destination: vendorPhone,
              channel: 'whatsapp',
              templateCode: 'hotel_request_received',
              eventType: 'request.dispatched',
              payload: {
                recipientId,
                propertyId: chosenProp.id,
                propertyName: chosenProp.name,
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
          }

          // 2. Email alert to vendor: to verified vendor contact email
          const baseUrl = process.env.APP_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:8080');
          const targetEmails = new Set();
          if (vendor.contact_email && vendor.contact_email.trim().toLowerCase() !== 'tripmozy@gmail.com') {
            targetEmails.add(vendor.contact_email.trim());
          }

          // CRITICAL: Ensure the customer/traveler NEVER receives vendor dispatch alerts or vendor action links!
          if (guestEmail) {
            targetEmails.delete(guestEmail.trim().toLowerCase());
          }

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
                  vendorId: vendor.id,
                  vendorName: vendor.business_name || 'TripMozy Verified Tour Operator',
                  propertyId: chosenProp.id,
                  propertyName: chosenProp.name,
                  requestReference: reference,
                  destination,
                  checkInDate,
                  checkOutDate,
                  nights,
                  numRooms,
                  numAdults,
                  totalBudgetINR: budgetNum,
                  rawToken,
                  actionUrl: `${baseUrl}/action?token=${rawToken}&action=accept`,
                  rejectUrl: `${baseUrl}/action?token=${rawToken}&action=reject`,
                  dashboardUrl: `${baseUrl}/partner/dashboard?vendorId=${vendor.id}`
                }
              });
            } catch (err) {
              console.error('[Vendor Dispatch Email Error]', destEmail, err.message);
            }
          }
        }
      }

      // Guarantee request status is 'awaiting_responses'
      tx.execute("UPDATE hotel_booking_requests SET status = 'awaiting_responses' WHERE id = ?", [requestId]);

      // NOTE: Customer only receives an email when the tour operator partner CONFIRMS their tour
      // (per requirements: no premature dispatch email to the customer; customer gets confirmation + payment link upon vendor acceptance).

      // Automated Written Details Email to Main Admin (tripmozy@gmail.com)
      if (this.notifService) {
        try {
          const notifiedVendorsList = activeVendors
            .map(v => v.business_name || 'Verified Partner')
            .join(', ');

          this.notifService.send({
            recipientUserId: null,
            destination: 'tripmozy@gmail.com',
            channel: 'email',
            templateCode: 'admin_new_request',
            eventType: 'admin.request_created',
            payload: {
              requestId,
              requestReference: reference,
              guestName,
              guestPhone,
              guestEmail,
              destination,
              destinationLocality: destinationLocality || 'Not specified',
              checkInDate,
              checkOutDate,
              nights,
              numRooms,
              numAdults,
              numChildren: numChildren || 0,
              roomPreference: roomPreference || 'standard',
              requiredFacilities: Array.isArray(requiredFacilities) ? requiredFacilities : [],
              totalBudgetINR: budgetNum,
              dispatchedVendorsCount: dispatchedCount,
              dispatchedVendorsList: notifiedVendorsList,
              createdAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
            }
          });
        } catch (adminErr) {
          console.error('[Admin Request Email Dispatch Error]', adminErr.message);
        }
      }

      tx.logAudit({
        actorId: finalCustomerId,
        actorRole: 'customer',
        action: 'request.submit',
        entityType: 'hotel_booking_request',
        entityId: requestId,
        afterState: { reference, destination, nights, numRooms, totalBudgetPaise, matchedVendors: dispatchedCount },
        ipAddress
      });

      return {
        id: requestId,
        reference,
        status: 'awaiting_responses',
        destination,
        nights,
        numRooms,
        totalBudgetINR: budgetNum,
        matchedCount: dispatchedCount,
        expiresAt,
        message: `Tour request created successfully! Dispatched to ${dispatchedCount} verified TripMozy tour operators.`
      };
    });
  }

  // Get request details by ID or reference (supports admin oversight mode)
  getRequestDetails(requestId, isAdmin = false) {
    const req = this.db.queryOne('SELECT * FROM hotel_booking_requests WHERE id = ? OR request_reference = ?', [requestId, requestId]);
    if (!req) return null;

    const actualId = req.id;
    const isBooked = req.status === 'booked';
    const revealVendorContact = isAdmin || isBooked;

    const recipients = this.db.query(`
      SELECT r.*, p.name as property_name, p.city as property_city, p.star_rating,
             v.business_name as vendor_business_name, v.contact_person as vendor_contact_person,
             v.contact_phone as vendor_contact_phone, v.contact_email as vendor_contact_email
      FROM booking_request_recipients r
      JOIN properties p ON r.property_id = p.id
      JOIN vendor_accounts v ON p.vendor_id = v.id
      WHERE r.request_id = ?
    `, [actualId]);

    const sanitizedRecipients = recipients.map(r => {
      if (revealVendorContact) return r;
      return {
        ...r,
        vendor_contact_phone: null,
        vendor_contact_email: null,
        vendor_contact_person: 'Verified Tour Partner'
      };
    });

    const offers = this.db.query(`
      SELECT o.*, p.name as property_name, p.city as property_city, p.star_rating,
             rt.name as room_type_name,
             v.business_name as vendor_business_name, v.contact_person as vendor_contact_person,
             v.contact_phone as vendor_contact_phone, v.contact_email as vendor_contact_email
      FROM hotel_offers o
      JOIN properties p ON o.property_id = p.id
      JOIN room_types rt ON o.room_type_id = rt.id
      JOIN vendor_accounts v ON p.vendor_id = v.id
      WHERE o.request_id = ?
    `, [actualId]);

    const enrichedOffers = offers.map(o => {
      const tourPricing = PricingEngine.calculateTourPricing(o.total_payable_paise);
      return {
        ...o,
        tourPricing,
        vendor: {
          businessName: o.vendor_business_name || o.property_name,
          contactPerson: revealVendorContact ? (o.vendor_contact_person || 'Tour Manager') : 'Verified Tour Partner',
          contactPhone: revealVendorContact ? (o.vendor_contact_phone || '') : null,
          contactEmail: revealVendorContact ? (o.vendor_contact_email || '') : null
        }
      };
    });

    let booking = null;
    if (req.status === 'booked') {
      const b = this.db.queryOne(`
        SELECT b.*,
               p.name as property_name, p.city as property_city, p.address_line,
               v.business_name as vendor_business_name,
               v.contact_person as vendor_contact_person,
               v.contact_phone as vendor_contact_phone,
               v.contact_email as vendor_contact_email
        FROM bookings b
        JOIN properties p ON b.property_id = p.id
        JOIN vendor_accounts v ON p.vendor_id = v.id
        WHERE b.request_id = ?
        ORDER BY b.created_at DESC LIMIT 1
      `, [actualId]);
      if (b) {
        let terms = {};
        try {
          terms = JSON.parse(b.terms_snapshot || '{}');
        } catch (_) {}
        booking = {
          ...b,
          guest: {
            name: req.guest_name,
            phone: req.guest_phone,
            email: req.guest_email
          },
          guest_name: req.guest_name,
          guest_phone: req.guest_phone,
          guest_email: req.guest_email,
          terms_snapshot: terms,
          vendor: {
            businessName: b.vendor_business_name || b.property_name,
            contactPerson: b.vendor_contact_person || 'Tour Manager',
            contactPhone: b.vendor_contact_phone || '',
            contactEmail: b.vendor_contact_email || ''
          }
        };
      }
    }

    return {
      request: req,
      recipients: sanitizedRecipients,
      offers: enrichedOffers,
      booking,
      isAdmin: !!isAdmin
    };
  }

  // Cancel tour request by Customer
  cancelRequest({ requestId, reason = 'customer_requested', notes = null, customerId = null }) {
    if (!requestId) throw new Error('Request ID is required');

    const req = this.db.queryOne(
      'SELECT * FROM hotel_booking_requests WHERE id = ? OR request_reference = ?',
      [requestId, requestId]
    );

    if (!req) {
      throw new Error(`Tour request '${requestId}' not found`);
    }

    if (req.status === 'booked') {
      throw new Error('Cannot cancel a tour request that has already been confirmed and booked');
    }

    if (req.status === 'cancelled') {
      return {
        success: true,
        message: 'This tour request is already cancelled.',
        id: req.id,
        reference: req.request_reference,
        status: 'cancelled'
      };
    }

    return this.db.transaction((tx) => {
      // 1. Update request status to cancelled
      tx.execute(`
        UPDATE hotel_booking_requests
        SET status = 'cancelled', updated_at = datetime('now')
        WHERE id = ?
      `, [req.id]);

      // 2. Mark pending recipients as cancelled so operators know not to respond
      tx.execute(`
        UPDATE booking_request_recipients
        SET response_status = 'cancelled'
        WHERE request_id = ? AND response_status = 'pending'
      `, [req.id]);

      // 3. Release any active room/tour inventory holds
      tx.execute(`
        UPDATE inventory_holds
        SET status = 'released'
        WHERE offer_id IN (SELECT id FROM hotel_offers WHERE request_id = ?) AND status = 'active'
      `, [req.id]);

      // 4. Mark active offers as withdrawn
      tx.execute(`
        UPDATE hotel_offers
        SET status = 'withdrawn'
        WHERE request_id = ? AND status = 'valid'
      `, [req.id]);

      // 5. Log audit trail
      tx.logAudit({
        actorId: customerId || req.customer_id,
        actorRole: 'customer',
        action: 'request.cancel',
        entityType: 'hotel_booking_request',
        entityId: req.id,
        afterState: { status: 'cancelled', reason, notes }
      });

      return {
        success: true,
        message: 'Tour request has been successfully cancelled.',
        id: req.id,
        reference: req.request_reference,
        status: 'cancelled'
      };
    });
  }
}

module.exports = { RequestService };
