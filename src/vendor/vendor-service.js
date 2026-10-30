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

  // Retrieve all pending or active requests for a vendor
  getIncomingRequests(vendorId, actorContext) {
    if (actorContext && !actorContext.canManageProperty({ vendor_id: vendorId })) {
      throw new AccessControlError('Not authorized to view requests for this vendor');
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
        p.id as property_id,
        p.name as property_name,
        p.city as property_city
      FROM booking_request_recipients r
      JOIN hotel_booking_requests req ON r.request_id = req.id
      JOIN properties p ON r.property_id = p.id
      WHERE r.vendor_id = ?
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
      // Customer PII is strictly anonymized until booking is confirmed
      const maskedGuest = actorContext ? actorContext.sanitizeCustomerForVendor({}, false) : { name: 'Verified Traveler' };

      return {
        ...row,
        guest: maskedGuest,
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
        SELECT r.*, req.status as request_status, req.nights, req.num_rooms, req.total_budget_paise,
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

      // Prevent accept if rejected or expired
      if (recipient.response_status === 'rejected') {
        throw new Error('Cannot accept a request that has already been rejected');
      }
      if (new Date(recipient.expires_at) < new Date()) {
        tx.execute('UPDATE booking_request_recipients SET response_status = "expired" WHERE id = ?', [recipientId]);
        throw new Error('This request has expired and can no longer be accepted');
      }

      // 2. Room Type & Pricing
      const room = tx.queryOne(`
        SELECT rt.*, rr.base_nightly_rate_paise, rr.tax_rate_basis_points
        FROM room_types rt
        JOIN room_rates rr ON rt.id = rr.room_type_id
        WHERE rt.id = ? AND rt.property_id = ?
      `, [roomTypeId, recipient.property_id]);

      if (!room) {
        throw new Error(`Room type ${roomTypeId} does not belong to property ${recipient.property_id}`);
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
        roomTypeId, nightlyBasePaise, recipient.nights, recipient.num_rooms,
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

      // 6. Notify Customer via WhatsApp & Email
      if (this.notifService) {
        const totalINR = pricing.totalPayablePaise / 100;
        const bookingUrl = `/booking?id=${recipient.request_id}`;

        // 6a. WhatsApp alert to Customer
        if (recipient.guest_phone) {
          try {
            this.notifService.send({
              destination: recipient.guest_phone,
              channel: 'whatsapp',
              templateCode: 'hotel_offer_received',
              eventType: 'offer.received',
              payload: {
                guestName: recipient.guest_name,
                propertyName: recipient.prop_name,
                destination: recipient.destination,
                roomTypeName: room.name,
                mealPlan,
                cancellationTerms,
                totalAmountINR: totalINR,
                advancePayableINR: tourPricing.payableNowINR,
                remainingBalanceINR: tourPricing.remainingBalanceINR,
                offerReference,
                bookingUrl: `http://localhost:8080${bookingUrl}`
              }
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
              payload: {
                guestName: recipient.guest_name,
                propertyName: recipient.prop_name,
                destination: recipient.destination,
                roomTypeName: room.name,
                mealPlan,
                cancellationTerms,
                totalAmountINR: totalINR,
                advancePayableINR: tourPricing.payableNowINR,
                remainingBalanceINR: tourPricing.remainingBalanceINR,
                offerReference,
                bookingUrl: `http://localhost:8080${bookingUrl}`
              }
            });
          } catch (_) {}
        }
      }

      return {
        success: true,
        offerId,
        offerReference,
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
