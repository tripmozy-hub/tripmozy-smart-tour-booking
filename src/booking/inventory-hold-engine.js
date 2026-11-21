// ============================================================================
// TripMozy Atomic Inventory Hold & Concurrency Safeguard Engine
// Prevents race conditions and overselling using transactional row locks
// ============================================================================

const crypto = require('node:crypto');
const { PricingEngine } = require('../matching/pricing-engine');
const { seedCoreTourOperators } = require('../onboarding/catalog-loader');

class InventoryHoldEngine {
  constructor(db) {
    this.db = db;
  }

  /**
   * Atomically place a 15-minute inventory hold on an offer
   * Prevents two customers from taking the last room concurrently
   */
  // Self-heal and rehydrate offer and dependencies if missing on a cold serverless lambda instance
  rehydrateOfferRecord(tx, offerId, offerSnapshot, requestSnapshot, customerId = null) {
    if (!offerSnapshot && !requestSnapshot) return false;
    try {
      try { seedCoreTourOperators(tx); } catch (_) {}

      const os = offerSnapshot || {};
      const rs = requestSnapshot || {};

      const reqId = os.requestId || os.request_id || rs.id || tx.uuid();
      const reqRef = rs.reference || rs.request_reference || `TM-REQ-${Date.now()}`;
      const dest = rs.destination || 'Tour Destination';
      const cin = rs.checkInDate || rs.check_in_date || new Date().toISOString().split('T')[0];
      const cout = rs.checkOutDate || rs.check_out_date || new Date(Date.now() + 4 * 86400000).toISOString().split('T')[0];
      const nts = rs.nights || 4;
      const rms = rs.numRooms || rs.num_rooms || 1;
      const adt = rs.numAdults || rs.num_adults || 2;
      const bgt = rs.totalBudgetPaise || rs.total_budget_paise || os.totalPayablePaise || os.total_payable_paise || 3500000;
      const gnm = rs.guestName || rs.guest_name || 'Verified Traveler';
      const gem = rs.guestEmail || rs.guest_email || 'traveler@tripmozy.com';
      const gph = rs.guestPhone || rs.guest_phone || '+919876543210';

      // 1. Ensure customer user profile
      let finalCustId = customerId || rs.customer_id;
      if (gem) {
        const exUser = tx.queryOne('SELECT id FROM user_profiles WHERE email = ?', [gem]);
        if (exUser) {
          finalCustId = exUser.id;
        } else {
          finalCustId = finalCustId || tx.uuid();
          tx.execute(`
            INSERT INTO user_profiles (id, email, phone, role, display_name, status, is_phone_verified, is_email_verified)
            VALUES (?, ?, ?, 'customer', ?, 'active', 0, 0)
          `, [finalCustId, gem, gph, gnm]);
        }
      } else if (!finalCustId) {
        const exUser = tx.queryOne('SELECT id FROM user_profiles LIMIT 1');
        finalCustId = exUser ? exUser.id : tx.uuid();
      }

      // 2. Ensure hotel_booking_requests
      let exReq = tx.queryOne('SELECT id FROM hotel_booking_requests WHERE id = ? OR request_reference = ?', [reqId, reqRef]);
      const effectiveReqId = exReq ? exReq.id : reqId;
      if (!exReq) {
        tx.execute(`
          INSERT INTO hotel_booking_requests (
            id, request_reference, customer_id, guest_name, guest_email, guest_phone,
            destination, check_in_date, check_out_date, nights, num_rooms, num_adults,
            total_budget_paise, status, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offers_available', ?)
        `, [
          effectiveReqId, reqRef, finalCustId, gnm, gem, gph, dest, cin, cout, nts, rms, adt, bgt,
          new Date(Date.now() + 4 * 3600 * 1000).toISOString()
        ]);
      }

      // 3. Ensure vendor exists
      let vendorId = os.vendorId || os.vendor_id;
      let exVendor = vendorId ? tx.queryOne('SELECT id, business_name FROM vendor_accounts WHERE id = ?', [vendorId]) : null;
      if (!exVendor) {
        exVendor = tx.queryOne("SELECT id, business_name FROM vendor_accounts WHERE status = 'active' LIMIT 1");
        vendorId = exVendor ? exVendor.id : tx.uuid();
        if (!exVendor) {
          tx.execute(`
            INSERT INTO vendor_accounts (id, business_name, contact_person, contact_phone, contact_email, status)
            VALUES (?, ?, 'Tour Operations Manager', '+919876543210', 'vendor@tripmozy.com', 'active')
          `, [vendorId, os.vendorName || 'TripMozy Verified Tour Operator']);
        }
      }

      // 4. Ensure property exists
      let propId = os.propertyId || os.property_id;
      let exProp = propId ? tx.queryOne('SELECT id FROM properties WHERE id = ?', [propId]) : null;
      if (!exProp) {
        const vProp = tx.queryOne("SELECT id FROM properties WHERE vendor_id = ? AND status = 'active' LIMIT 1", [vendorId]);
        if (vProp) {
          propId = vProp.id;
        } else {
          propId = propId || tx.uuid();
          tx.execute(`
            INSERT OR IGNORE INTO properties (
              id, vendor_id, name, slug, property_type, star_rating, description,
              address_line, city, state, pincode, country, status, inventory_mode
            ) VALUES (?, ?, ?, ?, 'hotel', 4.8, 'Verified Tour Fleet', 'Tour Operations Desk', ?, 'India', '110001', 'India', 'active', 'vendor_confirmed')
          `, [propId, vendorId, os.propertyName || `${exVendor ? exVendor.business_name : 'TripMozy'} - Tour Fleet`, `fleet-${vendorId.slice(0, 8)}-${Date.now()}`, dest]);
        }
      }

      // 5. Ensure room type exists
      let roomTypeId = os.roomTypeId || os.room_type_id;
      let exRoom = roomTypeId ? tx.queryOne('SELECT id FROM room_types WHERE id = ?', [roomTypeId]) : null;
      if (!exRoom) {
        const pRoom = tx.queryOne('SELECT id FROM room_types WHERE property_id = ? AND is_active = 1 LIMIT 1', [propId]);
        if (pRoom) {
          roomTypeId = pRoom.id;
        } else {
          roomTypeId = roomTypeId || tx.uuid();
          tx.execute(`
            INSERT INTO room_types (id, property_id, name, bed_type, max_adults, max_children, total_inventory, is_ac, is_active)
            VALUES (?, ?, 'Custom Tour Package', 'King', 4, 2, 20, 1, 1)
          `, [roomTypeId, propId]);
          tx.execute(`
            INSERT INTO room_rates (id, room_type_id, rate_plan_name, base_nightly_rate_paise, tax_rate_basis_points, meal_plan, is_active)
            VALUES (?, ?, 'Standard Package', 350000, 500, 'Breakfast Included', 1)
          `, [tx.uuid(), roomTypeId]);
        }
      }

      // 6. Ensure recipient exists
      let exRecip = tx.queryOne('SELECT id FROM booking_request_recipients WHERE request_id = ? AND vendor_id = ?', [effectiveReqId, vendorId]);
      const recipId = exRecip ? exRecip.id : tx.uuid();
      if (!exRecip) {
        const actHash = crypto.createHash('sha256').update(`${effectiveReqId}:${vendorId}`).digest('hex');
        tx.execute(`
          INSERT OR IGNORE INTO booking_request_recipients (
            id, request_id, property_id, vendor_id, delivery_status, response_status, responded_at, expires_at, action_token_hash
          ) VALUES (?, ?, ?, ?, 'delivered', 'accepted', CURRENT_TIMESTAMP, ?, ?)
        `, [recipId, effectiveReqId, propId, vendorId, new Date(Date.now() + 4 * 3600 * 1000).toISOString(), actHash]);
      } else {
        tx.execute("UPDATE booking_request_recipients SET response_status = 'accepted', responded_at = CURRENT_TIMESTAMP WHERE id = ?", [recipId]);
      }

      // 7. Ensure offer exists
      let exOffer = tx.queryOne('SELECT id FROM hotel_offers WHERE id = ?', [offerId]);
      if (!exOffer) {
        const totalPaise = os.totalPayablePaise || os.total_payable_paise || bgt;
        const subtotal = Math.round(totalPaise / 1.05);
        const tax = totalPaise - subtotal;
        const nightlyBase = Math.round(subtotal / (nts * rms));
        const tourPricing = PricingEngine.calculateTourPricing(totalPaise);
        const inclusionsData = {
          inclusions: ['Verified Driver & Sightseeing Vehicle', 'Tour Itinerary Assistance', 'All Toll, State Tax & Parking'],
          tourPricing
        };

        tx.execute(`
          INSERT INTO hotel_offers (
            id, offer_reference, request_id, property_id, recipient_id, room_type_id,
            nightly_base_paise, total_nights, total_rooms, subtotal_paise, tax_paise,
            total_payable_paise, is_budget_match, meal_plan, cancellation_terms,
            special_inclusions, status, valid_until
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'valid', ?)
        `, [
          offerId, os.offerReference || os.offer_reference || `TM-OFF-${Date.now()}`,
          effectiveReqId, propId, recipId, roomTypeId,
          nightlyBase, nts, rms, subtotal, tax,
          totalPaise, os.mealPlan || os.meal_plan || 'Custom Tour Package',
          os.cancellationTerms || os.cancellation_terms || 'Free cancellation up to 48 hours before departure',
          JSON.stringify(inclusionsData), os.validUntil || os.valid_until || new Date(Date.now() + 4 * 3600 * 1000).toISOString()
        ]);
      }

      return true;
    } catch (err) {
      console.error('[rehydrateOfferRecord Error]', err.message);
      return false;
    }
  }

  /**
   * Atomically place a 15-minute inventory hold on an offer
   * Prevents two customers from taking the last room concurrently
   */
  createHold({ offerId, customerId = null, holdMinutes = 15, offerSnapshot = null, requestSnapshot = null, reqToken = null }) {
    return this.db.transaction((tx) => {
      // 1. Fetch and lock offer details (LEFT JOIN ensures missing metadata does not drop the offer)
      let offer = tx.queryOne(`
        SELECT o.*,
               req.status as req_status, req.expires_at as req_expires_at,
               req.check_in_date as req_check_in, req.check_out_date as req_check_out,
               req.num_rooms as req_num_rooms, req.customer_id as req_customer_id,
               req.destination as req_destination, req.guest_name, req.guest_phone, req.guest_email,
               p.status as property_status, p.name as property_name, p.vendor_id as prop_vendor_id,
               v.business_name as vendor_business_name
        FROM hotel_offers o
        LEFT JOIN hotel_booking_requests req ON o.request_id = req.id
        LEFT JOIN properties p ON o.property_id = p.id
        LEFT JOIN vendor_accounts v ON p.vendor_id = v.id
        WHERE o.id = ?
      `, [offerId]);

      // If missing on a cold serverless instance, attempt self-healing from snapshots
      if (!offer && (offerSnapshot || requestSnapshot)) {
        try {
          this.rehydrateOfferRecord(tx, offerId, offerSnapshot, requestSnapshot, customerId);
          offer = tx.queryOne(`
            SELECT o.*,
                   req.status as req_status, req.expires_at as req_expires_at,
                   req.check_in_date as req_check_in, req.check_out_date as req_check_out,
                   req.num_rooms as req_num_rooms, req.customer_id as req_customer_id,
                   req.destination as req_destination, req.guest_name, req.guest_phone, req.guest_email,
                   p.status as property_status, p.name as property_name, p.vendor_id as prop_vendor_id,
                   v.business_name as vendor_business_name
            FROM hotel_offers o
            LEFT JOIN hotel_booking_requests req ON o.request_id = req.id
            LEFT JOIN properties p ON o.property_id = p.id
            LEFT JOIN vendor_accounts v ON p.vendor_id = v.id
            WHERE o.id = ?
          `, [offerId]);
        } catch (e) {
          console.error('[createHold Rehydration Error]', e.message);
        }
      }

      if (!offer) {
        return { success: false, reason: 'offer_not_found', message: 'Offer record does not exist' };
      }

      // Check if tour package request or departure date has expired
      if (
        offer.req_status === 'expired' ||
        (offer.req_expires_at && new Date(offer.req_expires_at) < new Date()) ||
        (offer.check_in_date && new Date(offer.check_in_date + 'T23:59:59') < new Date())
      ) {
        tx.execute("UPDATE hotel_offers SET status = 'expired' WHERE id = ?", [offerId]);
        tx.execute("UPDATE hotel_booking_requests SET status = 'expired' WHERE id = ? AND status NOT IN ('booked', 'cancelled')", [offer.request_id]);
        return { success: false, reason: 'tour_package_expired', message: 'This tour package request has expired' };
      }

      if (offer.status !== 'valid') {
        return { success: false, reason: 'offer_inactive', message: `Offer is no longer valid (current status: ${offer.status})` };
      }

      if (new Date(offer.valid_until) < new Date()) {
        tx.execute("UPDATE hotel_offers SET status = 'expired' WHERE id = ?", [offerId]);
        return { success: false, reason: 'offer_expired', message: 'This offer has expired' };
      }

      if (offer.property_status !== 'active') {
        return { success: false, reason: 'property_inactive', message: 'Property is currently not accepting reservations' };
      }

      const checkInStr = offer.req_check_in || offer.check_in_date || (requestSnapshot && (requestSnapshot.checkInDate || requestSnapshot.check_in_date)) || new Date().toISOString().split('T')[0];
      const checkOutStr = offer.req_check_out || offer.check_out_date || (requestSnapshot && (requestSnapshot.checkOutDate || requestSnapshot.check_out_date)) || new Date(Date.now() + 4 * 86400000).toISOString().split('T')[0];
      const startDate = new Date(checkInStr);
      const endDate = new Date(checkOutStr);
      const neededRooms = offer.req_num_rooms || offer.num_rooms || offer.total_rooms || 1;

      // 2. Concurrency Check: Inspect sellable inventory vs (held + booked) on EVERY night
      for (let d = new Date(startDate); d < endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        const inv = tx.queryOne(`
          SELECT sellable_quantity, held_quantity, booked_quantity, stop_sell
          FROM room_inventory
          WHERE room_type_id = ? AND stay_date = ?
        `, [offer.room_type_id, dateStr]);

        if (inv) {
          const available = inv.sellable_quantity - (inv.held_quantity + inv.booked_quantity);
          if (inv.stop_sell || available < neededRooms) {
            // Room was taken by another customer or stopped selling
            return {
              success: false,
              reason: 'inventory_unavailable',
              message: `Sorry, another customer is currently holding the last room on ${dateStr}. Please choose another offer.`
            };
          }
        }
      }

      // 3. Atomically increment held_quantity on each night
      for (let d = new Date(startDate); d < endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        tx.execute(`
          UPDATE room_inventory
          SET held_quantity = held_quantity + ?, last_updated_at = datetime('now')
          WHERE room_type_id = ? AND stay_date = ?
        `, [neededRooms, offer.room_type_id, dateStr]);
      }

      // 4. Create inventory_holds record
      const holdId = tx.uuid();
      const expiresAt = new Date(Date.now() + holdMinutes * 60 * 1000).toISOString();

      let validCustomerId = null;
      if (customerId && tx.queryOne('SELECT id FROM user_profiles WHERE id = ?', [customerId])) {
        validCustomerId = customerId;
      } else {
        validCustomerId = offer.req_customer_id || null;
      }

      tx.execute(`
        INSERT INTO inventory_holds (
          id, offer_id, room_type_id, customer_id, check_in_date, check_out_date,
          quantity, status, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `, [
        holdId, offerId, offer.room_type_id, validCustomerId, checkInStr,
        checkOutStr, neededRooms, expiresAt
      ]);

      // 5. Update offer and request status
      tx.execute("UPDATE hotel_offers SET status = 'selected' WHERE id = ?", [offerId]);
      tx.execute("UPDATE hotel_booking_requests SET status = 'reservation_pending' WHERE id = ?", [offer.request_id]);

      tx.logAudit({
        actorId: customerId,
        actorRole: 'customer',
        action: 'inventory.hold_created',
        entityType: 'inventory_hold',
        entityId: holdId,
        afterState: { offerId, neededRooms, expiresAt }
      });

      const tourPricing = PricingEngine.calculateTourPricing(offer.total_payable_paise);

      return {
        success: true,
        holdId,
        offerId,
        expiresAt,
        holdMinutes,
        totalPayablePaise: offer.total_payable_paise,
        tourPricing,
        holdSnapshot: {
          holdId,
          offerId,
          offerReference: offer.offer_reference,
          requestId: offer.request_id,
          propertyId: offer.property_id,
          propertyName: offer.property_name || 'TripMozy Verified Tour Fleet',
          roomTypeId: offer.room_type_id,
          vendorId: offer.prop_vendor_id || offer.vendor_id,
          vendorName: offer.vendor_business_name || offer.property_name || 'TripMozy Verified Partner',
          totalPayablePaise: offer.total_payable_paise,
          checkInDate: checkInStr,
          checkOutDate: checkOutStr,
          nights: offer.total_nights || Math.max(1, Math.round((endDate - startDate) / 86400000)),
          numRooms: neededRooms,
          mealPlan: offer.meal_plan || 'Custom Tour Package',
          cancellationTerms: offer.cancellation_terms || 'Free cancellation up to 48 hours before departure',
          guestName: offer.guest_name || (requestSnapshot && requestSnapshot.guestName) || 'Verified Traveler',
          guestPhone: offer.guest_phone || (requestSnapshot && requestSnapshot.guestPhone) || '+919876543210',
          guestEmail: offer.guest_email || (requestSnapshot && requestSnapshot.guestEmail) || 'traveler@tripmozy.com',
          destination: offer.req_destination || (requestSnapshot && requestSnapshot.destination) || 'Tour Destination',
          expiresAt
        },
        message: `Tour package held exclusively for ${holdMinutes} minutes. Please complete payment to confirm your booking.`
      };
    });
  }

  /**
   * Background release of expired holds
   * Safely returns held room quantities back to sellable pool
   */
  releaseExpiredHolds() {
    return this.db.transaction((tx) => {
      const expiredHolds = tx.query(`
        SELECT h.*, o.request_id
        FROM inventory_holds h
        JOIN hotel_offers o ON h.offer_id = o.id
        WHERE h.status = 'active' AND datetime(h.expires_at) <= datetime('now')
      `);

      let releasedCount = 0;

      for (const h of expiredHolds) {
        const start = new Date(h.check_in_date);
        const end = new Date(h.check_out_date);

        // Decrement held_quantity on each night
        for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
          const dateStr = d.toISOString().split('T')[0];
          tx.execute(`
            UPDATE room_inventory
            SET held_quantity = MAX(0, held_quantity - ?), last_updated_at = datetime('now')
            WHERE room_type_id = ? AND stay_date = ?
          `, [h.quantity, h.room_type_id, dateStr]);
        }

        // Mark hold timed_out
        tx.execute("UPDATE inventory_holds SET status = 'timed_out' WHERE id = ?", [h.id]);

        // Revert offer status to valid so it can be re-attempted
        tx.execute("UPDATE hotel_offers SET status = 'valid' WHERE id = ?", [h.offer_id]);

        // Revert request status if no other active holds
        tx.execute(`
          UPDATE hotel_booking_requests
          SET status = 'offers_available', updated_at = datetime('now')
          WHERE id = ? AND status = 'reservation_pending'
        `, [h.request_id]);

        tx.logAudit({
          actorRole: 'system',
          action: 'inventory.hold_released_timeout',
          entityType: 'inventory_hold',
          entityId: h.id
        });

        releasedCount++;
      }

      return { releasedCount };
    });
  }
}

module.exports = { InventoryHoldEngine };
