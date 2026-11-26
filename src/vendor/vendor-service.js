// ============================================================================
// TripMozy Vendor Request Management & Offer Service
// Handles vendor actions (Accept, Reject, Custom Quote) and state transitions
// ============================================================================

const crypto = require('node:crypto');
const { PricingEngine } = require('../matching/pricing-engine');
const { AccessControlError } = require('../auth/roles');

class VendorService {
  constructor(db, notifService = null) {
    this.db = db;
    this.notifService = notifService;
  }

  // Guarantee vendor has an active fleet property AND at least one active room_type + room_rate
  ensureVendorActiveFleet(dbOrTx, vendorId) {
    let vendorProp = dbOrTx.queryOne(
      "SELECT id, name, city FROM properties WHERE vendor_id = ? AND status = 'active' LIMIT 1",
      [vendorId]
    );
    if (!vendorProp) {
      const vendorAcc = dbOrTx.queryOne('SELECT id, business_name, contact_person FROM vendor_accounts WHERE id = ?', [vendorId]);
      if (!vendorAcc) return null;

      const newPropId = dbOrTx.uuid();
      dbOrTx.execute(`
        INSERT INTO properties (
          id, vendor_id, name, slug, property_type, star_rating,
          description, address_line, city, state, pincode, country,
          latitude, longitude, timezone, check_in_time, check_out_time,
          status, inventory_mode
        ) VALUES (?, ?, ?, ?, 'hotel', 4.8, ?, 'India Operations', 'All Destinations', 'India', '110001', 'India', 28.6139, 77.2090, 'Asia/Kolkata', '12:00', '11:00', 'active', 'vendor_confirmed')
      `, [
        newPropId,
        vendorId,
        `${vendorAcc.business_name} - Tour Fleet`,
        `fleet-${vendorId.slice(0, 8)}-${Date.now()}`,
        `Verified Tour Operator Partner (${vendorAcc.business_name})`
      ]);
      vendorProp = { id: newPropId, name: `${vendorAcc.business_name} - Tour Fleet`, city: 'All Destinations' };
    }

    let room = dbOrTx.queryOne(
      'SELECT rt.id FROM room_types rt JOIN room_rates rr ON rt.id = rr.room_type_id WHERE rt.property_id = ? AND rt.is_active = 1 AND rr.is_active = 1 LIMIT 1',
      [vendorProp.id]
    );
    if (!room) {
      let existingRoomType = dbOrTx.queryOne('SELECT id FROM room_types WHERE property_id = ? AND is_active = 1 LIMIT 1', [vendorProp.id]);
      const roomTypeId = existingRoomType ? existingRoomType.id : dbOrTx.uuid();
      if (!existingRoomType) {
        dbOrTx.execute(`
          INSERT INTO room_types (id, property_id, name, bed_type, max_adults, max_children, total_inventory, is_ac, is_accessible, is_active)
          VALUES (?, ?, 'Custom Tour Package', 'King', 10, 5, 20, 1, 1, 1)
        `, [roomTypeId, vendorProp.id]);
      }
      const existingRate = dbOrTx.queryOne('SELECT id FROM room_rates WHERE room_type_id = ? AND is_active = 1 LIMIT 1', [roomTypeId]);
      if (!existingRate) {
        const rateId = dbOrTx.uuid();
        dbOrTx.execute(`
          INSERT INTO room_rates (id, room_type_id, rate_plan_name, base_nightly_rate_paise, tax_rate_basis_points, meal_plan, cancellation_rule, is_active)
          VALUES (?, ?, 'Standard Package', 350000, 500, 'Breakfast Included', 'moderate', 1)
        `, [rateId, roomTypeId]);
      }
    }

    return vendorProp;
  }

  // Rehydrate an authenticated partner account on cold serverless containers from signed session data
  rehydrateVendorFromSession(session) {
    if (!session || !session.authenticated || session.role !== 'vendor' || !session.vendorId) {
      return null;
    }
    const vendorId = session.vendorId;
    const existing = this.db.queryOne('SELECT id FROM vendor_accounts WHERE id = ?', [vendorId]);
    if (existing) {
      this.ensureVendorActiveFleet(this.db, vendorId);
      return existing.id;
    }

    return this.db.transaction((tx) => {
      const recheck = tx.queryOne('SELECT id FROM vendor_accounts WHERE id = ?', [vendorId]);
      if (recheck) {
        this.ensureVendorActiveFleet(tx, vendorId);
        return recheck.id;
      }

      const email = (session.user && session.user.email) || `partner_${vendorId.slice(0, 8)}@tripmozy.local`;
      const phone = (session.user && session.user.phone) || '+91 98765 43210';
      const displayName = (session.user && session.user.displayName) || 'Verified Partner';
      const businessName = (session.vendor && session.vendor.businessName) || displayName;

      let user = tx.queryOne('SELECT id FROM user_profiles WHERE id = ? OR LOWER(email) = LOWER(?) LIMIT 1', [
        (session.user && session.user.id) || vendorId,
        email
      ]);
      const userId = user ? user.id : ((session.user && session.user.id) || tx.uuid());
      if (!user) {
        tx.execute(`
          INSERT OR IGNORE INTO user_profiles (id, email, phone, role, display_name, status, is_email_verified, is_phone_verified)
          VALUES (?, ?, ?, 'vendor', ?, 'active', 1, 1)
        `, [userId, email, phone, displayName]);
      }

      tx.execute(`
        INSERT OR IGNORE INTO vendor_accounts (
          id, user_id, business_name, contact_person, contact_phone, contact_email,
          verification_status, commission_rate_basis_points, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'verified', 1500, 'active')
      `, [vendorId, userId, businessName, displayName, phone, email]);

      this.ensureVendorActiveFleet(tx, vendorId);
      return vendorId;
    });
  }

  // Retrieve all pending or active requests for a vendor
  getIncomingRequests(vendorId, actorContext) {
    if (actorContext && !actorContext.canManageProperty({ vendor_id: vendorId })) {
      throw new AccessControlError('Not authorized to view requests for this vendor');
    }

    // 1. Ensure vendor has an active property, room type, and rate so requests can always be quoted
    const vendorProp = this.ensureVendorActiveFleet(this.db, vendorId);

    // 2. Dynamic backfill: Ensure all active unassigned requests are delivered to this vendor's dashboard
    if (vendorProp) {
      const ACTION_SECRET = process.env.ACTION_SECRET || 'tripmozy_action_secure_key_2026';
      const pendingReqs = this.db.query(`
        SELECT req.id, req.expires_at, req.destination, req.request_reference, req.check_in_date, req.check_out_date,
               req.nights, req.num_rooms, req.num_adults, req.total_budget_paise, req.guest_name, req.guest_email, req.guest_phone, req.customer_id
        FROM hotel_booking_requests req
        WHERE req.status IN ('awaiting_responses', 'matching', 'dispatching', 'pending')
          AND NOT EXISTS (
            SELECT 1 FROM booking_request_recipients r WHERE r.request_id = req.id AND r.vendor_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM booking_request_recipients other_r 
            WHERE other_r.request_id = req.id AND other_r.response_status = 'accepted'
          )
          AND NOT EXISTS (
            SELECT 1 FROM hotel_offers o 
            WHERE o.request_id = req.id AND o.status = 'valid'
          )
      `, [vendorId]);

      for (const pr of pendingReqs) {
        const recipientId = this.db.uuid();
        const minPayload = {
          recId: recipientId,
          reqId: pr.id,
          propId: vendorProp.id,
          venId: vendorId,
          ref: pr.request_reference,
          dst: pr.destination,
          cin: pr.check_in_date,
          cout: pr.check_out_date,
          nts: pr.nights,
          rms: pr.num_rooms,
          adt: pr.num_adults,
          bgt: pr.total_budget_paise,
          pnm: vendorProp.name,
          cid: pr.customer_id,
          gnm: pr.guest_name,
          gem: pr.guest_email,
          gph: pr.guest_phone,
          exp: pr.expires_at ? new Date(pr.expires_at).getTime() : (Date.now() + 2 * 3600 * 1000)
        };
        const pStr = Buffer.from(JSON.stringify(minPayload)).toString('base64url');
        const sig = crypto.createHmac('sha256', ACTION_SECRET).update(pStr).digest('hex');
        const signedToken = `${pStr}.${sig}`;
        const actionTokenHash = crypto.createHash('sha256').update(signedToken).digest('hex');

        this.db.execute(`
          INSERT INTO booking_request_recipients (
            id, request_id, property_id, vendor_id, delivery_status, response_status,
            expires_at, action_token_hash
          ) VALUES (?, ?, ?, ?, 'delivered', 'pending', ?, ?)
        `, [recipientId, pr.id, vendorProp.id, vendorId, pr.expires_at, actionTokenHash]);
      }
    }

    const recipients = this.db.query(`
      SELECT 
        r.id as recipient_id,
        r.delivery_status,
        r.response_status,
        r.expires_at as recipient_expires_at,
        r.rejection_reason,
        req.id as request_id,
        req.request_reference,
        req.destination,
        req.destination_locality,
        req.check_in_date,
        req.check_out_date,
        req.nights,
        req.num_rooms,
        req.num_adults,
        req.num_children,
        req.total_budget_paise,
        req.room_preference,
        req.required_facilities,
        req.status as request_status,
        req.guest_name,
        req.guest_phone,
        req.guest_email,
        p.id as property_id,
        p.name as property_name,
        p.city as property_city
      FROM booking_request_recipients r
      JOIN hotel_booking_requests req ON r.request_id = req.id
      JOIN properties p ON r.property_id = p.id
      WHERE r.vendor_id = ?
        AND (r.rejection_reason IS NULL OR r.rejection_reason != 'accepted_by_other')
        AND r.response_status != 'accepted_by_other'
        AND NOT (
          r.response_status != 'accepted' AND (
            r.response_status = 'cancelled'
            OR req.status IN ('offers_available', 'booked', 'customer_selecting')
            OR EXISTS (
              SELECT 1 FROM booking_request_recipients other_r
              WHERE other_r.request_id = r.request_id 
                AND other_r.vendor_id != r.vendor_id 
                AND other_r.response_status = 'accepted'
            )
            OR EXISTS (
              SELECT 1 FROM hotel_offers o
              JOIN properties op ON o.property_id = op.id
              WHERE o.request_id = r.request_id
                AND op.vendor_id != r.vendor_id
            )
          )
        )
      ORDER BY r.created_at DESC
    `, [vendorId]);

    // Deduplicate by request_id so each distinct customer stay request appears ONCE per vendor
    const requestMap = new Map();
    for (const row of recipients) {
      if (!requestMap.has(row.request_id)) {
        requestMap.set(row.request_id, row);
      } else {
        const existing = requestMap.get(row.request_id);
        // If any property was already responded to (accepted/rejected), reflect that resolved status
        if (existing.response_status === 'pending' && row.response_status !== 'pending') {
          requestMap.set(row.request_id, row);
        }
      }
    }
    const deduplicatedRows = Array.from(requestMap.values());

    return deduplicatedRows.map(row => {
      // Customer PII is revealed to the operator who accepted the request once booking is confirmed (30% advance paid)
      const revealPII = row.request_status === 'booked' || (actorContext && actorContext.role === 'admin');
      
      const guestInfo = revealPII
        ? {
            name: row.guest_name || 'Verified Traveler',
            phone: row.guest_phone || null,
            email: row.guest_email || null
          }
        : (actorContext ? actorContext.sanitizeCustomerForVendor({}, false) : { name: 'Verified Traveler' });

      // Also fetch booking details if booked
      let bookingInfo = null;
      if (row.request_status === 'booked') {
        const b = this.db.queryOne('SELECT * FROM bookings WHERE request_id = ? ORDER BY created_at DESC LIMIT 1', [row.request_id]);
        if (b) {
          let terms = {};
          try { terms = JSON.parse(b.terms_snapshot || '{}'); } catch (_) {}
          bookingInfo = {
            id: b.id,
            bookingReference: b.booking_reference,
            totalAmountINR: b.total_amount_paise / 100,
            advancePaidINR: terms.advancePaidINR || Math.round((b.total_amount_paise / 100) * 0.315),
            remainingBalanceINR: terms.remainingBalanceINR || ((b.total_amount_paise / 100) - Math.round((b.total_amount_paise / 100) * 0.30)),
            remainingPaymentOption: terms.remainingPaymentOption || 'hotel_arrival',
            confirmedAt: b.confirmed_at
          };
        }
      }

      return {
        ...row,
        guest: guestInfo,
        guest_name: revealPII ? row.guest_name : 'Verified Traveler',
        guest_phone: revealPII ? row.guest_phone : null,
        guest_email: revealPII ? row.guest_email : null,
        booking: bookingInfo,
        required_facilities: JSON.parse(row.required_facilities || '[]'),
        total_budget_inr: row.total_budget_paise / 100,
        is_expired: new Date(row.recipient_expires_at) < new Date()
      };
    });
  }

  // Accept a stay request and generate an official time-limited hotel offer
  acceptRequest({
    recipientId,
    roomTypeId,
    customNightlyRatePaise = null,
    customTotalPaise = null,
    mealPlan = 'Breakfast Included',
    cancellationTerms = 'Free cancellation up to 48 hours before check-in',
    specialInclusions = [],
    validHours = 4,
    actorContext
  }) {
    return this.db.transaction((tx) => {
      // 1. Fetch recipient and request
      const recipient = tx.queryOne(`
        SELECT r.*, req.status as request_status, req.nights, req.num_rooms, req.num_adults,
               req.check_in_date, req.check_out_date, req.request_reference, req.total_budget_paise,
               req.guest_name, req.guest_phone, req.guest_email, req.destination,
               p.id as prop_id, p.vendor_id as prop_vendor_id, p.name as prop_name
        FROM booking_request_recipients r
        JOIN hotel_booking_requests req ON r.request_id = req.id
        JOIN properties p ON r.property_id = p.id
        WHERE r.id = ?
      `, [recipientId]);

      if (!recipient) {
        throw new Error(`Recipient record ${recipientId} not found`);
      }

      // Authorization check
      if (actorContext && !actorContext.canRespondToRecipient(recipient)) {
        throw new AccessControlError('Not authorized to respond for this property');
      }

      // Idempotency: if already accepted, return existing offer
      if (recipient.response_status === 'accepted') {
        const existingOffer = tx.queryOne('SELECT * FROM hotel_offers WHERE recipient_id = ?', [recipientId]);
        if (existingOffer) return { idempotent: true, offer: existingOffer };
      }

      // 1b. Check if already accepted by any other partner or marked as accepted_by_other
      const otherWinner = tx.queryOne(`
        SELECT v.business_name, r.vendor_id
        FROM booking_request_recipients r
        JOIN vendor_accounts v ON r.vendor_id = v.id
        WHERE r.request_id = ? AND r.vendor_id != ? AND r.response_status = 'accepted'
        LIMIT 1
      `, [recipient.request_id, recipient.vendor_id]) || tx.queryOne(`
        SELECT v.business_name, p.vendor_id
        FROM hotel_offers o
        JOIN properties p ON o.property_id = p.id
        JOIN vendor_accounts v ON p.vendor_id = v.id
        WHERE o.request_id = ? AND p.vendor_id != ?
        LIMIT 1
      `, [recipient.request_id, recipient.vendor_id]);

      if (otherWinner || recipient.rejection_reason === 'accepted_by_other' || recipient.response_status === 'accepted_by_other') {
        const partnerName = otherWinner?.business_name || 'Another Partner';
        const err = new Error(`Sorry, this tour request has already been accepted by other partner (${partnerName})`);
        err.acceptedByOther = true;
        err.acceptedByName = partnerName;
        throw err;
      }

      // Prevent accept if rejected, cancelled, or expired
      if (recipient.response_status === 'rejected') {
        throw new Error('Cannot accept a request that has already been rejected');
      }
      if (recipient.response_status === 'cancelled') {
        if (recipient.rejection_reason === 'accepted_by_other' || otherWinner) {
          const partnerName = otherWinner?.business_name || 'Another Partner';
          const err = new Error(`Sorry, this tour request has already been accepted by other partner (${partnerName})`);
          err.acceptedByOther = true;
          err.acceptedByName = partnerName;
          throw err;
        }
        throw new Error('This tour request has been cancelled by the customer');
      }
      if (recipient.req_status === 'cancelled') {
        throw new Error('This tour request has been cancelled by the customer');
      }
      if (recipient.req_status === 'offers_available' || recipient.req_status === 'booked') {
        const partnerName = otherWinner?.business_name || 'Another Partner';
        const err = new Error(`Sorry, this tour request has already been accepted by other partner (${partnerName})`);
        err.acceptedByOther = true;
        err.acceptedByName = partnerName;
        throw err;
      }
      if (new Date(recipient.expires_at) < new Date()) {
        tx.execute('UPDATE booking_request_recipients SET response_status = "expired" WHERE id = ?', [recipientId]);
        throw new Error('This request has expired and can no longer be accepted');
      }

      // 2. Room Type & Pricing
      let targetRoomTypeId = roomTypeId;
      if (!targetRoomTypeId) {
        const defaultRoom = tx.queryOne('SELECT id FROM room_types WHERE property_id = ? AND is_active = 1 LIMIT 1', [recipient.property_id]);
        if (defaultRoom) targetRoomTypeId = defaultRoom.id;
      }

      const room = tx.queryOne(`
        SELECT rt.*, rr.base_nightly_rate_paise, rr.tax_rate_basis_points
        FROM room_types rt
        JOIN room_rates rr ON rt.id = rr.room_type_id
        WHERE rt.id = ? AND rt.property_id = ?
      `, [targetRoomTypeId, recipient.property_id]);

      if (!room) {
        throw new Error(`Room type ${targetRoomTypeId} does not belong to property ${recipient.property_id}`);
      }

      let pricing;
      let nightlyBasePaise;

      if (customTotalPaise !== null && customTotalPaise > 0) {
        const totalPayablePaise = Math.round(Number(customTotalPaise));
        const tourPricing = PricingEngine.calculateTourPricing(totalPayablePaise);
        const subtotalPaise = totalPayablePaise;
        const taxPaise = tourPricing.advanceGstPaise;
        nightlyBasePaise = Math.round(subtotalPaise / (Math.max(1, recipient.nights) * Math.max(1, recipient.num_rooms)));

        pricing = {
          baseNightlyRatePaise: nightlyBasePaise,
          nights: recipient.nights,
          numRooms: recipient.num_rooms,
          subtotalPaise,
          taxBps: 500,
          taxPaise,
          totalPayablePaise,
          tourPricing
        };
      } else {
        nightlyBasePaise = customNightlyRatePaise !== null ? customNightlyRatePaise : room.base_nightly_rate_paise;
        const basePricing = PricingEngine.calculateStayPrice({
          baseNightlyRatePaise: nightlyBasePaise,
          nights: recipient.nights,
          numRooms: recipient.num_rooms,
          taxBps: room.tax_rate_basis_points
        });
        const tourPricing = PricingEngine.calculateTourPricing(basePricing.totalPayablePaise);
        pricing = {
          ...basePricing,
          tourPricing
        };
      }

      const isBudgetMatch = PricingEngine.isWithinBudget(pricing.totalPayablePaise, recipient.total_budget_paise);
      const tourPricing = pricing.tourPricing;

      // 3. Create Hotel Offer record
      const offerId = tx.uuid();
      const randHex = crypto.randomBytes(2).toString('hex').toUpperCase();
      const offerReference = `TM-OFF-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randHex}`;
      const validUntil = new Date(Date.now() + validHours * 60 * 60 * 1000).toISOString();

      const inclusionsData = {
        inclusions: Array.isArray(specialInclusions) ? specialInclusions : [specialInclusions],
        tourPricing
      };

      tx.execute(`
        INSERT INTO hotel_offers (
          id, offer_reference, request_id, property_id, recipient_id, room_type_id,
          nightly_base_paise, total_nights, total_rooms, subtotal_paise, tax_paise,
          total_payable_paise, is_budget_match, meal_plan, cancellation_terms,
          special_inclusions, status, valid_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?)
      `, [
        offerId, offerReference, recipient.request_id, recipient.property_id, recipientId,
        targetRoomTypeId, nightlyBasePaise, recipient.nights, recipient.num_rooms,
        pricing.subtotalPaise, pricing.taxPaise, pricing.totalPayablePaise,
        isBudgetMatch ? 1 : 0, mealPlan, cancellationTerms,
        JSON.stringify(inclusionsData), validUntil
      ]);

      // 4. Update recipient status to 'accepted' for all recipient rows for this vendor & request
      tx.execute(`
        UPDATE booking_request_recipients
        SET response_status = 'accepted', responded_at = datetime('now')
        WHERE id = ? OR (request_id = ? AND vendor_id = ?)
      `, [recipientId, recipient.request_id, recipient.vendor_id]);

      // 4b. Disappear automatically from all other vendors who received this request
      tx.execute(`
        UPDATE booking_request_recipients
        SET response_status = 'cancelled',
            rejection_reason = 'accepted_by_other',
            rejection_note = 'Accepted by another tour operator',
            responded_at = datetime('now')
        WHERE request_id = ? AND vendor_id != ? AND response_status != 'accepted'
      `, [recipient.request_id, recipient.vendor_id]);

      // 5. Update request status to 'offers_available'
      tx.execute(`
        UPDATE hotel_booking_requests
        SET status = 'offers_available', updated_at = datetime('now')
        WHERE id = ? AND status IN ('matching', 'dispatching', 'awaiting_responses')
      `, [recipient.request_id]);

      tx.logAudit({
        actorId: actorContext ? actorContext.user?.id : null,
        actorRole: 'vendor',
        action: 'vendor.accept_request',
        entityType: 'hotel_offer',
        entityId: offerId,
        afterState: { offerReference, totalPayablePaise: pricing.totalPayablePaise, isBudgetMatch }
      });

      // 6. Generate cryptographically signed offer token (resilient across serverless instances)
      let offerToken = '';
      try {
        const { RequestService } = require('../requests/request-service');
        offerToken = RequestService.generateSignedOfferToken({
          requestId: recipient.request_id,
          requestReference: recipient.request_reference,
          destination: recipient.destination,
          checkInDate: recipient.check_in_date,
          checkOutDate: recipient.check_out_date,
          nights: recipient.nights,
          numRooms: recipient.num_rooms,
          numAdults: recipient.num_adults,
          totalBudgetPaise: recipient.total_budget_paise,
          guestName: recipient.guest_name,
          guestEmail: recipient.guest_email,
          guestPhone: recipient.guest_phone,
          offerId,
          offerReference,
          vendorId: recipient.vendor_id,
          vendorBusinessName: recipient.vendor_business_name || recipient.prop_name,
          propertyId: recipient.property_id,
          propertyName: recipient.prop_name,
          totalPayablePaise: pricing.totalPayablePaise,
          validUntil
        });
      } catch (_) {}

      // 7. Notify Customer via WhatsApp & Email (Vendor Confirmation & Payment Link)
      if (this.notifService) {
        const totalINR = pricing.totalPayablePaise / 100;
        const baseUrl = process.env.APP_BASE_URL || (process.env.NODE_ENV === 'development' && !process.env.VERCEL ? 'http://localhost:8080' : 'https://tripmozy-smart-tour-booking.vercel.app');
        const tokenSuffix = offerToken ? `&token=${encodeURIComponent(offerToken)}` : '';
        const paymentUrl = `${baseUrl}/booking?id=${recipient.request_id}&payNow=1${tokenSuffix}`;
        const adminPaymentUrl = `${baseUrl}/booking?id=${recipient.request_id}&admin=1${tokenSuffix}`;

        const notifPayload = {
          guestName: recipient.guest_name,
          propertyName: recipient.prop_name,
          destination: recipient.destination,
          checkInDate: recipient.check_in_date,
          checkOutDate: recipient.check_out_date,
          nights: recipient.nights,
          numAdults: recipient.num_adults,
          numRooms: recipient.num_rooms,
          requestReference: recipient.request_reference,
          roomTypeName: room.name,
          mealPlan,
          cancellationTerms,
          totalAmountINR: totalINR,
          advanceBaseINR: tourPricing.advanceBaseINR,
          advanceGstINR: tourPricing.advanceGstINR,
          advancePayableINR: tourPricing.payableNowINR,
          remainingBalanceINR: tourPricing.remainingBalanceINR,
          offerReference,
          offerId,
          requestId: recipient.request_id,
          bookingUrl: paymentUrl,
          paymentUrl
        };

        // 6a. WhatsApp alert to Customer
        if (recipient.guest_phone) {
          try {
            this.notifService.send({
              destination: recipient.guest_phone,
              channel: 'whatsapp',
              templateCode: 'hotel_offer_received',
              eventType: 'offer.received',
              payload: notifPayload
            });
          } catch (_) {}
        }

        // 6b. Email alert to Customer
        if (recipient.guest_email) {
          try {
            this.notifService.send({
              destination: recipient.guest_email,
              channel: 'email',
              templateCode: 'hotel_offer_received',
              eventType: 'offer.received',
              payload: notifPayload
            });
          } catch (_) {}
        }

        // 6c. Notification to Main Admin (tripmozy@gmail.com) with whole written details
        try {
          const vendorAccount = tx.queryOne('SELECT * FROM vendor_accounts WHERE id = ?', [recipient.vendor_id]);

          this.notifService.send({
            recipientUserId: null,
            destination: 'tripmozy@gmail.com',
            channel: 'email',
            templateCode: 'admin_request_accepted',
            eventType: 'admin.offer_created',
            payload: {
              requestReference: recipient.request_reference,
              offerReference,
              offerId,
              destination: recipient.destination,
              checkInDate: recipient.check_in_date,
              checkOutDate: recipient.check_out_date,
              nights: recipient.nights,
              numAdults: recipient.num_adults,
              numRooms: recipient.num_rooms,
              guestName: recipient.guest_name,
              guestPhone: recipient.guest_phone,
              guestEmail: recipient.guest_email,
              vendorName: vendorAccount ? vendorAccount.business_name : recipient.prop_name,
              vendorContactPerson: vendorAccount ? vendorAccount.contact_person : 'Tour Manager',
              vendorPhone: vendorAccount ? vendorAccount.contact_phone : 'Not provided',
              vendorEmail: vendorAccount ? vendorAccount.contact_email : 'Not provided',
              propertyName: recipient.prop_name,
              roomTypeName: room.name,
              mealPlan,
              cancellationTerms,
              totalAmountINR: totalINR,
              advanceBaseINR: tourPricing.advanceBaseINR,
              advanceGstINR: tourPricing.advanceGstINR,
              advancePayableINR: tourPricing.payableNowINR,
              remainingBalanceINR: tourPricing.remainingBalanceINR,
              validUntil,
              paymentUrl: adminPaymentUrl,
              adminPaymentUrl
            }
          });
        } catch (adminErr) {
          console.error('[Admin Offer Email Dispatch Error]', adminErr.message);
        }
      }

      return {
        success: true,
        offerId,
        offerReference,
        offerToken: typeof offerToken !== 'undefined' ? offerToken : null,
        totalPayableINR: pricing.totalPayablePaise / 100,
        advancePaidINR: tourPricing.payableNowINR,
        remainingBalanceINR: tourPricing.remainingBalanceINR,
        tourPricing,
        isBudgetMatch,
        validUntil
      };
    });
  }

  // Reject a stay request with mandatory standardized reason
  rejectRequest({ recipientId, reason, note = '', actorContext }) {
    const validReasons = ['unavailable', 'no_suitable_room', 'over_budget', 'facilities_mismatch', 'other'];
    if (!validReasons.includes(reason)) {
      throw new Error(`Invalid rejection reason. Allowed: ${validReasons.join(', ')}`);
    }

    return this.db.transaction((tx) => {
      const recipient = tx.queryOne(`
        SELECT r.*, req.guest_name, req.guest_email, req.guest_phone, req.destination,
               req.check_in_date, req.check_out_date, p.name as prop_name
        FROM booking_request_recipients r
        JOIN hotel_booking_requests req ON r.request_id = req.id
        JOIN properties p ON r.property_id = p.id
        WHERE r.id = ?
      `, [recipientId]);
      if (!recipient) {
        throw new Error(`Recipient record ${recipientId} not found`);
      }

      if (actorContext && !actorContext.canRespondToRecipient(recipient)) {
        throw new AccessControlError('Not authorized to respond for this property');
      }

      if (recipient.response_status === 'accepted') {
        throw new Error('Cannot reject an offer that has already been accepted');
      }

      // Idempotency: if already rejected with same reason
      if (recipient.response_status === 'rejected') {
        return { idempotent: true, status: 'rejected' };
      }

      tx.execute(`
        UPDATE booking_request_recipients
        SET response_status = 'rejected', rejection_reason = ?, rejection_note = ?, responded_at = datetime('now')
        WHERE id = ? OR (request_id = ? AND vendor_id = ?)
      `, [reason, note, recipientId, recipient.request_id, recipient.vendor_id]);

      tx.logAudit({
        actorId: actorContext ? actorContext.user?.id : null,
        actorRole: 'vendor',
        action: 'vendor.reject_request',
        entityType: 'booking_request_recipient',
        entityId: recipientId,
        afterState: { reason, note }
      });

      // Notify Customer via WhatsApp & Email about property status update
      if (this.notifService) {
        const bookingUrl = `/booking?id=${recipient.request_id}`;
        if (recipient.guest_phone) {
          try {
            this.notifService.send({
              destination: recipient.guest_phone,
              channel: 'whatsapp',
              templateCode: 'hotel_request_declined',
              eventType: 'request.declined',
              payload: {
                guestName: recipient.guest_name,
                propertyName: recipient.prop_name,
                destination: recipient.destination,
                checkInDate: recipient.check_in_date,
                checkOutDate: recipient.check_out_date,
                reason,
                note,
                bookingUrl: `http://localhost:8080${bookingUrl}`
              }
            });
          } catch (_) {}
        }
        if (recipient.guest_email) {
          try {
            this.notifService.send({
              destination: recipient.guest_email,
              channel: 'email',
              templateCode: 'hotel_request_declined',
              eventType: 'request.declined',
              payload: {
                guestName: recipient.guest_name,
                propertyName: recipient.prop_name,
                destination: recipient.destination,
                checkInDate: recipient.check_in_date,
                checkOutDate: recipient.check_out_date,
                reason,
                note,
                bookingUrl: `http://localhost:8080${bookingUrl}`
              }
            });
          } catch (_) {}
        }
      }

      return { success: true, status: 'rejected', reason };
    });
  }
}

module.exports = { VendorService };
