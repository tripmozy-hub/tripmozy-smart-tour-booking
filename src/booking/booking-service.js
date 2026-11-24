// ============================================================================
// TripMozy Booking Lifecycle & State Machine Service
// Handles hold-to-booking conversion, snapshot immutability & cancellations
// ============================================================================

const crypto = require('node:crypto');
const { AccessControlError } = require('../auth/roles');
const { PricingEngine } = require('../matching/pricing-engine');

class BookingService {
  constructor(db) {
    this.db = db;
  }

  // Generate reference like TM-BKG-20261028-F8E2
  static generateReference() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `TM-BKG-${today}-${rand}`;
  }

  // Generate cryptographically signed stateless booking token (resilient across serverless instances)
  static generateSignedBookingToken(payload) {
    const ACTION_SECRET = process.env.ACTION_SECRET || 'tripmozy_action_secure_key_2026';
    const minPayload = {
      type: 'booking',
      bkgId: payload.bookingId,
      bkgRef: payload.bookingReference,
      reqId: payload.requestId,
      reqRef: payload.requestReference,
      offId: payload.offerId,
      holdId: payload.holdId,
      cid: payload.customerId,
      propId: payload.propertyId,
      pnm: payload.propertyName,
      venId: payload.vendorId,
      vnm: payload.vendorBusinessName || payload.vendorName,
      vcp: payload.vendorContactPerson || 'Tour Manager',
      vph: payload.vendorContactPhone || '',
      vem: payload.vendorContactEmail || '',
      dst: payload.destination,
      cin: payload.checkInDate,
      cout: payload.checkOutDate,
      nts: payload.nights || 4,
      rms: payload.numRooms || 1,
      adt: payload.numAdults || 2,
      totPaise: payload.totalPayablePaise || (payload.totalAmountINR ? Math.round(payload.totalAmountINR * 100) : 3500000),
      advPaidINR: payload.advancePaidINR,
      advPaidPaise: payload.advPaidPaise,
      advBaseINR: payload.advanceBaseINR,
      advGstINR: payload.advanceGstINR,
      remBalINR: payload.remainingBalanceINR,
      remBalPaise: payload.remBalPaise,
      remOpt: payload.remainingPaymentOption || 'hotel_arrival',
      payRef: payload.paymentReference || 'DIRECT_VERIFIED',
      gnm: payload.guestName,
      gph: payload.guestPhone,
      gem: payload.guestEmail,
      confAt: payload.confirmedAt || new Date().toISOString(),
      exp: Date.now() + 30 * 86400 * 1000 // 30 days validity for confirmed booking voucher
    };
    const pStr = Buffer.from(JSON.stringify(minPayload)).toString('base64url');
    const sig = crypto.createHmac('sha256', ACTION_SECRET).update(pStr).digest('hex');
    return `${pStr}.${sig}`;
  }

  // Rehydrate confirmed booking, request, property, vendor and payment on cold serverless instances
  rehydrateBookingFromToken(rawToken, targetId = null) {
    if (!rawToken || typeof rawToken !== 'string' || !rawToken.includes('.')) return false;
    const ACTION_SECRET = process.env.ACTION_SECRET || 'tripmozy_action_secure_key_2026';
    try {
      const [pStr, sig] = rawToken.split('.');
      if (!pStr || !sig) return false;
      const expectedSig = crypto.createHmac('sha256', ACTION_SECRET).update(pStr).digest('hex');
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expectedSig);
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return false;
      }
      const p = JSON.parse(Buffer.from(pStr, 'base64url').toString('utf8'));
      if (!p || (p.type !== 'booking' && !p.bkgId && !p.bkgRef)) return false;

      // If targetId is provided, ensure it matches either booking reference, booking id, request reference, or request id
      if (targetId && targetId !== 'latest' && targetId !== 'undefined' && targetId !== 'null') {
        const idMatches = targetId === p.bkgRef || targetId === p.bkgId || targetId === p.reqRef || targetId === p.reqId;
        if (!idMatches) return false;
      }

      return this.db.transaction((tx) => {
        const { seedCoreTourOperators } = require('../onboarding/catalog-loader');
        try { seedCoreTourOperators(tx); } catch (_) {}

        const bkgId = p.bkgId || tx.uuid();
        const bkgRef = p.bkgRef || `TM-BKG-${Date.now()}`;
        const reqId = p.reqId || tx.uuid();
        const reqRef = p.reqRef || `TM-REQ-${Date.now()}`;
        const offerId = p.offId || tx.uuid();
        const holdId = p.holdId || tx.uuid();
        let vendorId = p.venId || tx.uuid();
        let propId = p.propId || tx.uuid();
        let roomTypeId = tx.uuid();
        const totalPaise = p.totPaise || 3500000;
        const checkInDate = p.cin || new Date().toISOString().split('T')[0];
        const checkOutDate = p.cout || new Date(Date.now() + 4 * 86400000).toISOString().split('T')[0];
        const nights = p.nts || 4;
        const numRooms = p.rms || 1;
        const guestName = p.gnm || 'Verified Traveler';
        const guestPhone = p.gph || '+919876543210';
        const guestEmail = p.gem || 'traveler@tripmozy.com';

        // 1. Ensure user profile
        let custId = p.cid;
        if (guestEmail) {
          const exUser = tx.queryOne('SELECT id FROM user_profiles WHERE email = ?', [guestEmail]);
          if (exUser) {
            custId = exUser.id;
          } else {
            custId = custId || tx.uuid();
            tx.execute(`
              INSERT INTO user_profiles (id, email, phone, role, display_name, status, is_phone_verified, is_email_verified)
              VALUES (?, ?, ?, 'customer', ?, 'active', 0, 0)
            `, [custId, guestEmail, guestPhone, guestName]);
          }
        } else if (!custId) {
          const exUser = tx.queryOne('SELECT id FROM user_profiles LIMIT 1');
          custId = exUser ? exUser.id : tx.uuid();
        }

        // 2. Ensure request with status 'booked'
        let exReq = tx.queryOne('SELECT id FROM hotel_booking_requests WHERE id = ? OR request_reference = ?', [reqId, reqRef]);
        const effectiveReqId = exReq ? exReq.id : reqId;
        if (!exReq) {
          tx.execute(`
            INSERT INTO hotel_booking_requests (
              id, request_reference, customer_id, guest_name, guest_email, guest_phone,
              destination, check_in_date, check_out_date, nights, num_rooms, num_adults,
              total_budget_paise, status, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?)
          `, [
            effectiveReqId, reqRef, custId, guestName, guestEmail, guestPhone,
            p.dst || 'Tour Destination', checkInDate, checkOutDate, nights, numRooms, p.adt || 2, totalPaise,
            new Date(Date.now() + 24 * 3600 * 1000).toISOString()
          ]);
        } else {
          tx.execute("UPDATE hotel_booking_requests SET status = 'booked', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [effectiveReqId]);
        }

        // 3. Ensure vendor
        let exVendor = tx.queryOne('SELECT id FROM vendor_accounts WHERE id = ?', [vendorId]);
        if (!exVendor) {
          const anyVendor = tx.queryOne("SELECT id FROM vendor_accounts WHERE status = 'active' LIMIT 1");
          if (anyVendor) {
            vendorId = anyVendor.id;
          } else {
            tx.execute(`
              INSERT INTO vendor_accounts (id, business_name, contact_person, contact_phone, contact_email, status)
              VALUES (?, ?, ?, ?, ?, 'active')
            `, [vendorId, p.vnm || 'TripMozy Verified Tour Operator', p.vcp || 'Tour Operations Manager', p.vph || '+919876543210', p.vem || 'vendor@tripmozy.com']);
          }
        }

        // 4. Ensure property
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
            `, [propId, vendorId, p.pnm || 'TripMozy Verified Tour Fleet', `fleet-${vendorId.slice(0, 8)}-${Date.now()}`, p.dst || 'India']);
          }
        }

        // 5. Ensure room type & rate
        let exRoom = tx.queryOne('SELECT id FROM room_types WHERE property_id = ? AND is_active = 1 LIMIT 1', [propId]);
        if (exRoom) {
          roomTypeId = exRoom.id;
        } else {
          tx.execute(`
            INSERT INTO room_types (id, property_id, name, bed_type, max_adults, max_children, total_inventory, is_ac, is_active)
            VALUES (?, ?, 'Custom Tour Package', 'King', 4, 2, 20, 1, 1)
          `, [roomTypeId, propId]);
          tx.execute(`
            INSERT INTO room_rates (id, room_type_id, rate_plan_name, base_nightly_rate_paise, tax_rate_basis_points, meal_plan, is_active)
            VALUES (?, ?, 'Standard Package', 350000, 500, 'Breakfast Included', 1)
          `, [tx.uuid(), roomTypeId]);
        }

        // 6. Ensure recipient
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

        // 7. Ensure offer
        let exOffer = tx.queryOne('SELECT id FROM hotel_offers WHERE id = ?', [offerId]);
        if (!exOffer) {
          const subtotal = Math.round(totalPaise / 1.05);
          const tax = totalPaise - subtotal;
          const nightlyBase = Math.round(subtotal / (nights * numRooms));
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'Custom Tour Package', 'Free cancellation up to 48 hours before departure', ?, 'selected', ?)
          `, [
            offerId, `TM-OFF-${Date.now()}`, effectiveReqId, propId, recipId, roomTypeId,
            nightlyBase, nights, numRooms, subtotal, tax, totalPaise,
            JSON.stringify(inclusionsData), new Date(Date.now() + 4 * 3600 * 1000).toISOString()
          ]);
        }

        // 8. Ensure inventory hold
        let exHold = tx.queryOne('SELECT id FROM inventory_holds WHERE id = ?', [holdId]);
        if (!exHold) {
          tx.execute(`
            INSERT INTO inventory_holds (
              id, offer_id, room_type_id, customer_id, check_in_date, check_out_date,
              quantity, status, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'consumed', ?)
          `, [
            holdId, offerId, roomTypeId, custId, checkInDate, checkOutDate, numRooms,
            new Date(Date.now() + 15 * 60 * 1000).toISOString()
          ]);
        } else {
          tx.execute("UPDATE inventory_holds SET status = 'consumed' WHERE id = ?", [holdId]);
        }

        // 9. Ensure booking record
        let exBkg = tx.queryOne('SELECT id FROM bookings WHERE id = ? OR booking_reference = ? OR request_id = ?', [bkgId, bkgRef, effectiveReqId]);
        if (!exBkg) {
          const tourPricing = PricingEngine.calculateTourPricing(totalPaise);
          const advancePaidINR = p.advPaidINR || tourPricing.payableNowINR;
          const advanceBaseINR = p.advBaseINR || Math.round(advancePaidINR / 1.05);
          const advanceGstINR = p.advGstINR || (advancePaidINR - advanceBaseINR);
          const remainingBalanceINR = p.remBalINR || tourPricing.remainingBalanceINR;
          const subtotalPaise = Math.round(totalPaise / 1.05);
          const taxPaise = totalPaise - subtotalPaise;

          const termsSnapshot = {
            mealPlan: 'Custom Tour Package',
            cancellationTerms: 'Free cancellation up to 48 hours before departure',
            propertySnapshot: { name: p.pnm || 'Verified Tour Fleet', city: p.dst || 'India' },
            guestSnapshot: { name: guestName, phone: guestPhone, email: guestEmail },
            vendorSnapshot: {
              vendorId,
              businessName: p.vnm || 'Verified Tour Operator',
              contactPerson: p.vcp || 'Tour Manager',
              contactPhone: p.vph || '',
              contactEmail: p.vem || ''
            },
            tourPricing,
            totalTourINR: totalPaise / 100,
            advancePaidINR,
            advancePaidPaise: advancePaidINR * 100,
            advanceBaseINR,
            advanceGstINR,
            remainingBalanceINR,
            remainingBalancePaise: remainingBalanceINR * 100,
            remainingPaymentOption: p.remOpt || 'hotel_arrival',
            paymentReference: p.payRef || 'DIRECT_VERIFIED',
            paymentStatus: 'SUCCESS_RECEIVED_BY_TRIPMOZY',
            paymentGateway: 'tripmozy.com',
            confirmedAt: p.confAt || new Date().toISOString()
          };

          tx.execute(`
            INSERT INTO bookings (
              id, booking_reference, request_id, offer_id, hold_id, customer_id,
              property_id, room_type_id, check_in_date, check_out_date, num_rooms,
              num_adults, num_children, total_nights, base_amount_paise, tax_amount_paise,
              total_amount_paise, currency, cancellation_policy_snapshot, terms_snapshot,
              status, confirmed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'INR', ?, ?, 'confirmed', ?)
          `, [
            bkgId, bkgRef, effectiveReqId, offerId, holdId,
            custId, propId, roomTypeId, checkInDate, checkOutDate,
            numRooms, p.adt || 2, nights, subtotalPaise, taxPaise,
            totalPaise, 'Free cancellation up to 48 hours before departure',
            JSON.stringify(termsSnapshot), p.confAt || new Date().toISOString()
          ]);

          // Ensure payment
          const payId = tx.uuid();
          const isPaused = process.env.PAYMENT_GATEWAY_PAUSED !== 'false';
          const providerName = (p.payRef && p.payRef.includes('demo')) || isPaused ? 'demo' : 'razorpay';
          tx.execute(`
            INSERT OR IGNORE INTO payments (
              id, booking_id, amount_paise, currency, provider, provider_order_id,
              provider_payment_id, status, idempotency_key
            ) VALUES (?, ?, ?, 'INR', ?, ?, ?, 'paid', ?)
          `, [
            payId, bkgId, advancePaidINR * 100, providerName,
            `order_${bkgRef}`, p.payRef || `pay_verified_${bkgRef}`, `idem_${bkgId}`
          ]);
        }

        return true;
      });
    } catch (err) {
      console.error('[Booking Rehydration Error]', err.stack || err.message);
      return false;
    }
  }

  // Rehydrate hold, offer, request and property records on cold serverless instances
  rehydrateHoldRecord(tx, holdId, hs, customerId = null) {
    if (!hs) return false;
    try {
      const { seedCoreTourOperators } = require('../onboarding/catalog-loader');
      try { seedCoreTourOperators(tx); } catch (_) {}

      const reqId = hs.requestId || tx.uuid();
      const offerId = hs.offerId || tx.uuid();
      let vendorId = hs.vendorId || tx.uuid();
      let propId = hs.propertyId || tx.uuid();
      let roomTypeId = hs.roomTypeId || tx.uuid();
      const totalPaise = hs.totalPayablePaise || 3500000;
      const checkInDate = hs.checkInDate || new Date().toISOString().split('T')[0];
      const checkOutDate = hs.checkOutDate || new Date(Date.now() + 4 * 86400000).toISOString().split('T')[0];
      const nights = hs.nights || 4;
      const numRooms = hs.numRooms || 1;
      const guestName = hs.guestName || 'Verified Traveler';
      const guestPhone = hs.guestPhone || '+919876543210';
      const guestEmail = hs.guestEmail || 'traveler@tripmozy.com';

      // 1. Ensure customer user profile
      let finalCustId = customerId || hs.customerId;
      if (guestEmail) {
        const exUser = tx.queryOne('SELECT id FROM user_profiles WHERE email = ?', [guestEmail]);
        if (exUser) {
          finalCustId = exUser.id;
        } else {
          finalCustId = finalCustId || tx.uuid();
          tx.execute(`
            INSERT INTO user_profiles (id, email, phone, role, display_name, status, is_phone_verified, is_email_verified)
            VALUES (?, ?, ?, 'customer', ?, 'active', 0, 0)
          `, [finalCustId, guestEmail, guestPhone, guestName]);
        }
      } else if (!finalCustId) {
        const exUser = tx.queryOne('SELECT id FROM user_profiles LIMIT 1');
        finalCustId = exUser ? exUser.id : tx.uuid();
      }

      // 2. Ensure request
      let exReq = tx.queryOne('SELECT id FROM hotel_booking_requests WHERE id = ?', [reqId]);
      if (!exReq) {
        tx.execute(`
          INSERT INTO hotel_booking_requests (
            id, request_reference, customer_id, guest_name, guest_email, guest_phone,
            destination, check_in_date, check_out_date, nights, num_rooms, num_adults,
            total_budget_paise, status, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reservation_pending', ?)
        `, [
          reqId, hs.requestReference || `TM-REQ-${Date.now()}`, finalCustId, guestName, guestEmail, guestPhone,
          hs.destination || 'Tour Destination', checkInDate, checkOutDate, nights, numRooms, 2, totalPaise,
          new Date(Date.now() + 24 * 3600 * 1000).toISOString()
        ]);
      }

      // 3. Ensure vendor
      let exVendor = tx.queryOne('SELECT id FROM vendor_accounts WHERE id = ?', [vendorId]);
      if (!exVendor) {
        const anyVendor = tx.queryOne("SELECT id FROM vendor_accounts WHERE status = 'active' LIMIT 1");
        if (anyVendor) {
          vendorId = anyVendor.id;
        } else {
          tx.execute(`
            INSERT INTO vendor_accounts (id, business_name, contact_person, contact_phone, contact_email, status)
            VALUES (?, ?, 'Tour Operations Manager', '+919876543210', 'vendor@tripmozy.com', 'active')
          `, [vendorId, hs.vendorName || 'TripMozy Verified Tour Operator']);
        }
      }

      // 4. Ensure property
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
          `, [propId, vendorId, hs.propertyName || 'TripMozy Verified Tour Fleet', `fleet-${vendorId.slice(0, 8)}-${Date.now()}`, hs.destination || 'India']);
        }
      }

      // 5. Ensure room type
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

      // 6. Ensure recipient
      let exRecip = tx.queryOne('SELECT id FROM booking_request_recipients WHERE request_id = ? AND vendor_id = ?', [reqId, vendorId]);
      const recipId = exRecip ? exRecip.id : tx.uuid();
      if (!exRecip) {
        const actHash = crypto.createHash('sha256').update(`${reqId}:${vendorId}`).digest('hex');
        tx.execute(`
          INSERT OR IGNORE INTO booking_request_recipients (
            id, request_id, property_id, vendor_id, delivery_status, response_status, responded_at, expires_at, action_token_hash
          ) VALUES (?, ?, ?, ?, 'delivered', 'accepted', CURRENT_TIMESTAMP, ?, ?)
        `, [recipId, reqId, propId, vendorId, new Date(Date.now() + 4 * 3600 * 1000).toISOString(), actHash]);
      }

      // 7. Ensure offer
      let exOffer = tx.queryOne('SELECT id FROM hotel_offers WHERE id = ?', [offerId]);
      if (!exOffer) {
        const subtotal = Math.round(totalPaise / 1.05);
        const tax = totalPaise - subtotal;
        const nightlyBase = Math.round(subtotal / (nights * numRooms));
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'selected', ?)
        `, [
          offerId, hs.offerReference || `TM-OFF-${Date.now()}`, reqId, propId, recipId, roomTypeId,
          nightlyBase, nights, numRooms, subtotal, tax, totalPaise,
          hs.mealPlan || 'Custom Tour Package', hs.cancellationTerms || 'Free cancellation up to 48 hours before departure',
          JSON.stringify(inclusionsData), new Date(Date.now() + 4 * 3600 * 1000).toISOString()
        ]);
      }

      // 8. Ensure inventory hold
      let exHold = tx.queryOne('SELECT id FROM inventory_holds WHERE id = ?', [holdId]);
      if (!exHold) {
        tx.execute(`
          INSERT INTO inventory_holds (
            id, offer_id, room_type_id, customer_id, check_in_date, check_out_date,
            quantity, status, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
        `, [
          holdId, offerId, roomTypeId, finalCustId, checkInDate, checkOutDate, numRooms,
          hs.expiresAt || new Date(Date.now() + 15 * 60 * 1000).toISOString()
        ]);
      }

      return true;
    } catch (err) {
      console.error('[rehydrateHoldRecord Error]', err.stack || err.message);
      return false;
    }
  }

  // Confirm booking from an active inventory hold
  confirmBooking({ holdId, customerId, paymentReference = 'DIRECT_VERIFIED', remainingPaymentOption = 'hotel_arrival', holdSnapshot = null, actorContext }) {
    return this.db.transaction((tx) => {
      // 1. Verify hold
      let hold = tx.queryOne(`
        SELECT h.*, o.property_id, o.room_type_id, o.subtotal_paise, o.tax_paise,
               o.total_payable_paise, o.meal_plan, o.cancellation_terms, o.request_id,
               req.request_reference, req.guest_name, req.guest_phone, req.guest_email, req.nights,
               req.num_adults, req.num_children, req.customer_id as req_customer_id,
               req.destination,
               p.vendor_id, p.name as property_name, p.city as property_city,
               v.business_name as vendor_business_name, v.contact_person as vendor_contact_person,
               v.contact_phone as vendor_contact_phone, v.contact_email as vendor_contact_email,
               v.commission_rate_basis_points
        FROM inventory_holds h
        JOIN hotel_offers o ON h.offer_id = o.id
        JOIN hotel_booking_requests req ON o.request_id = req.id
        JOIN properties p ON o.property_id = p.id
        JOIN vendor_accounts v ON p.vendor_id = v.id
        WHERE h.id = ?
      `, [holdId]);

      if (!hold && holdSnapshot) {
        this.rehydrateHoldRecord(tx, holdId, holdSnapshot, customerId);
        hold = tx.queryOne(`
          SELECT h.*, o.property_id, o.room_type_id, o.subtotal_paise, o.tax_paise,
                 o.total_payable_paise, o.meal_plan, o.cancellation_terms, o.request_id,
                 req.request_reference, req.guest_name, req.guest_phone, req.guest_email, req.nights,
                 req.num_adults, req.num_children, req.customer_id as req_customer_id,
                 req.destination,
                 p.vendor_id, p.name as property_name, p.city as property_city,
                 v.business_name as vendor_business_name, v.contact_person as vendor_contact_person,
                 v.contact_phone as vendor_contact_phone, v.contact_email as vendor_contact_email,
                 v.commission_rate_basis_points
          FROM inventory_holds h
          JOIN hotel_offers o ON h.offer_id = o.id
          JOIN hotel_booking_requests req ON o.request_id = req.id
          JOIN properties p ON o.property_id = p.id
          JOIN vendor_accounts v ON p.vendor_id = v.id
          WHERE h.id = ?
        `, [holdId]);
      }

      if (!hold) {
        throw new Error(`Inventory hold ${holdId} not found`);
      }

      if (hold.status !== 'active') {
        throw new Error(`Cannot confirm booking. Hold is no longer active (status: ${hold.status})`);
      }

      if (new Date(hold.expires_at) < new Date()) {
        throw new Error('Inventory hold has expired. Please select the offer again.');
      }

      const bookingId = tx.uuid();
      const bookingReference = BookingService.generateReference();

      let effectiveCustomerId = null;
      if (customerId && tx.queryOne('SELECT id FROM user_profiles WHERE id = ?', [customerId])) {
        effectiveCustomerId = customerId;
      } else if (hold.customer_id && tx.queryOne('SELECT id FROM user_profiles WHERE id = ?', [hold.customer_id])) {
        effectiveCustomerId = hold.customer_id;
      } else {
        effectiveCustomerId = hold.req_customer_id;
      }

      // 2. Decrement held_quantity and increment booked_quantity
      const start = new Date(hold.check_in_date);
      const end = new Date(hold.check_out_date);

      for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        tx.execute(`
          UPDATE room_inventory
          SET held_quantity = MAX(0, held_quantity - ?),
              booked_quantity = booked_quantity + ?,
              last_updated_at = datetime('now')
          WHERE room_type_id = ? AND stay_date = ?
        `, [hold.quantity, hold.quantity, hold.room_type_id, dateStr]);
      }

      // 3. Mark hold consumed
      tx.execute("UPDATE inventory_holds SET status = 'consumed' WHERE id = ?", [holdId]);

      // 4. Calculate Tour Payment Structure (30% Advance + 5% GST on Advance, 70% Remaining)
      const tourPricing = PricingEngine.calculateTourPricing(hold.total_payable_paise);

      // Create immutable booking record with terms snapshot
      const advanceBaseINR = Math.round(tourPricing.payableNowINR / 1.05);
      const advanceGstINR = tourPricing.payableNowINR - advanceBaseINR;

      const termsSnapshot = {
        mealPlan: hold.meal_plan,
        cancellationTerms: hold.cancellation_terms,
        propertySnapshot: { name: hold.property_name, city: hold.property_city },
        guestSnapshot: { name: hold.guest_name, phone: hold.guest_phone, email: hold.guest_email },
        vendorSnapshot: {
          vendorId: hold.vendor_id,
          businessName: hold.vendor_business_name || hold.property_name,
          contactPerson: hold.vendor_contact_person || 'Tour Manager',
          contactPhone: hold.vendor_contact_phone || '',
          contactEmail: hold.vendor_contact_email || ''
        },
        tourPricing,
        totalTourINR: hold.total_payable_paise / 100,
        advancePaidINR: tourPricing.payableNowINR,
        advancePaidPaise: tourPricing.payableNowPaise,
        advanceBaseINR,
        advanceGstINR,
        remainingBalanceINR: tourPricing.remainingBalanceINR,
        remainingBalancePaise: tourPricing.remainingBalancePaise,
        remainingPaymentOption: remainingPaymentOption || 'hotel_arrival',
        paymentReference,
        paymentStatus: 'SUCCESS_RECEIVED_BY_TRIPMOZY',
        paymentGateway: 'tripmozy.com',
        confirmedAt: new Date().toISOString()
      };

      tx.execute(`
        INSERT INTO bookings (
          id, booking_reference, request_id, offer_id, hold_id, customer_id,
          property_id, room_type_id, check_in_date, check_out_date, num_rooms,
          num_adults, num_children, total_nights, base_amount_paise, tax_amount_paise,
          total_amount_paise, currency, cancellation_policy_snapshot, terms_snapshot,
          status, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, 'confirmed', datetime('now'))
      `, [
        bookingId, bookingReference, hold.request_id, hold.offer_id, holdId,
        effectiveCustomerId, hold.property_id, hold.room_type_id, hold.check_in_date,
        hold.check_out_date, hold.quantity, hold.num_adults, hold.num_children,
        hold.nights, hold.subtotal_paise, hold.tax_paise, hold.total_payable_paise,
        hold.cancellation_terms, JSON.stringify(termsSnapshot)
      ]);

      // 5. Record room night ledger (child of bookings)
      for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        tx.execute(`
          INSERT INTO booking_room_nights (
            id, booking_id, room_type_id, stay_date, quantity, nightly_rate_paise
          ) VALUES (?, ?, ?, ?, ?, ?)
        `, [
          tx.uuid(), bookingId, hold.room_type_id, dateStr, hold.quantity,
          Math.round(hold.subtotal_paise / (hold.nights * hold.quantity))
        ]);
      }

      // 6. Update request status to 'booked'
      tx.execute("UPDATE hotel_booking_requests SET status = 'booked', updated_at = datetime('now') WHERE id = ?", [hold.request_id]);

      // 6. Record Platform Commission Ledger
      const commBps = hold.commission_rate_basis_points || 1500;
      const commissionAmountPaise = Math.round((hold.subtotal_paise * commBps) / 10000);
      const netPayableVendorPaise = hold.total_payable_paise - commissionAmountPaise;

      tx.execute(`
        INSERT INTO commission_ledger (
          id, booking_id, property_id, vendor_id, gross_booking_paise, tax_paise,
          commission_basis_points, commission_amount_paise, net_payable_to_vendor_paise,
          payout_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accrued')
      `, [
        tx.uuid(), bookingId, hold.property_id, hold.vendor_id, hold.total_payable_paise,
        hold.tax_paise, commBps, commissionAmountPaise, netPayableVendorPaise
      ]);

      // 7. Record Payment in payments ledger (Razorpay Live or Demo Sandbox Gateway)
      const isPaused = process.env.PAYMENT_GATEWAY_PAUSED !== 'false';
      let effectiveProviderPaymentId = paymentReference || (isPaused ? `pay_demo_${crypto.randomBytes(6).toString('hex')}` : `pay_rzp_live_${crypto.randomBytes(6).toString('hex')}`);
      const existingPay = tx.queryOne('SELECT id FROM payments WHERE provider_payment_id = ?', [effectiveProviderPaymentId]);
      if (existingPay) {
        effectiveProviderPaymentId = `${effectiveProviderPaymentId}_${bookingReference}`;
      }
      const paymentId = tx.uuid();
      const providerOrderId = `order_${crypto.randomBytes(8).toString('hex')}`;
      const idempotencyKey = `idem_${bookingId}_${effectiveProviderPaymentId}`;
      const providerName = (effectiveProviderPaymentId.startsWith('pay_demo_') || isPaused) ? 'demo' : 'razorpay';

      tx.execute(`
        INSERT INTO payments (
          id, booking_id, amount_paise, currency, provider, provider_order_id,
          provider_payment_id, status, idempotency_key
        ) VALUES (?, ?, ?, 'INR', ?, ?, ?, 'paid', ?)
      `, [
        paymentId, bookingId, tourPricing.payableNowPaise,
        providerName, providerOrderId, effectiveProviderPaymentId, idempotencyKey
      ]);

      tx.logAudit({
        actorId: effectiveCustomerId,
        actorRole: 'customer',
        action: 'booking.confirmed',
        entityType: 'booking',
        entityId: bookingId,
        afterState: { bookingReference, totalPayablePaise: hold.total_payable_paise, paymentReference }
      });

      const bookingToken = BookingService.generateSignedBookingToken({
        bookingId,
        bookingReference,
        requestId: hold.request_id,
        requestReference: hold.request_reference || (holdSnapshot && holdSnapshot.requestReference),
        offerId: hold.offer_id,
        holdId,
        customerId: effectiveCustomerId,
        propertyId: hold.property_id,
        propertyName: hold.property_name,
        vendorId: hold.vendor_id,
        vendorBusinessName: hold.vendor_business_name || hold.property_name,
        vendorContactPerson: hold.vendor_contact_person || 'Tour Manager',
        vendorContactPhone: hold.vendor_contact_phone || '',
        vendorContactEmail: hold.vendor_contact_email || '',
        destination: hold.destination || hold.property_city,
        checkInDate: hold.check_in_date,
        checkOutDate: hold.check_out_date,
        nights: hold.nights,
        numRooms: hold.quantity,
        numAdults: hold.num_adults,
        totalPayablePaise: hold.total_payable_paise,
        totalAmountINR: hold.total_payable_paise / 100,
        advancePaidINR: tourPricing.payableNowINR,
        advPaidPaise: tourPricing.payableNowPaise,
        advanceBaseINR,
        advanceGstINR,
        remainingBalanceINR: tourPricing.remainingBalanceINR,
        remBalPaise: tourPricing.remainingBalancePaise,
        remainingPaymentOption: remainingPaymentOption || 'hotel_arrival',
        paymentReference,
        guestName: hold.guest_name,
        guestPhone: hold.guest_phone,
        guestEmail: hold.guest_email,
        confirmedAt: termsSnapshot.confirmedAt
      });

      return {
        success: true,
        bookingId,
        bookingReference,
        bookingToken,
        status: 'confirmed',
        propertyName: hold.property_name,
        destination: hold.destination || hold.property_city,
        vendor: {
          vendorId: hold.vendor_id,
          businessName: hold.vendor_business_name || hold.property_name,
          contactPerson: hold.vendor_contact_person || 'Tour Manager',
          contactPhone: hold.vendor_contact_phone || '',
          contactEmail: hold.vendor_contact_email || ''
        },
        checkInDate: hold.check_in_date,
        checkOutDate: hold.check_out_date,
        nights: hold.nights,
        numRooms: hold.quantity,
        totalAmountINR: hold.total_payable_paise / 100,
        advancePaidINR: tourPricing.payableNowINR,
        advanceBaseINR,
        advanceGstINR,
        remainingBalanceINR: tourPricing.remainingBalanceINR,
        remainingPaymentOption: remainingPaymentOption || 'hotel_arrival',
        paymentReference,
        paymentStatus: 'SUCCESS_RECEIVED_BY_TRIPMOZY',
        paymentGateway: 'tripmozy.com',
        tourPricing,
        guest: {
          name: hold.guest_name,
          phone: hold.guest_phone,
          email: hold.guest_email
        }
      };
    });
  }

  // Cancel booking and calculate refund according to policy snapshot
  cancelBooking({ bookingId, requesterRole = 'customer', requestedBy, reason, actorContext }) {
    return this.db.transaction((tx) => {
      const booking = tx.queryOne(`
        SELECT b.*, p.vendor_id as property_vendor_id
        FROM bookings b
        JOIN properties p ON b.property_id = p.id
        WHERE b.id = ?
      `, [bookingId]);

      if (!booking) {
        throw new Error(`Booking ${bookingId} not found`);
      }

      if (booking.status !== 'confirmed') {
        throw new Error(`Cannot cancel booking with current status '${booking.status}'`);
      }

      // Check hours until check-in
      const checkInDateTime = new Date(`${booking.check_in_date}T14:00:00+05:30`);
      const now = new Date();
      const hoursUntilCheckIn = (checkInDateTime - now) / (1000 * 60 * 60);

      // Refund calculation:
      // More than 48 hours: 100% refund
      // Between 24 and 48 hours: 50% refund
      // Less than 24 hours: 0% refund
      let refundPercentage = 0;
      if (hoursUntilCheckIn >= 48) {
        refundPercentage = 100;
      } else if (hoursUntilCheckIn >= 24) {
        refundPercentage = 50;
      }

      const calculatedRefundPaise = Math.round((booking.total_amount_paise * refundPercentage) / 100);
      const cancellationFeePaise = booking.total_amount_paise - calculatedRefundPaise;

      // Decrement booked_quantity to restore inventory
      const start = new Date(booking.check_in_date);
      const end = new Date(booking.check_out_date);

      for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        tx.execute(`
          UPDATE room_inventory
          SET booked_quantity = MAX(0, booked_quantity - ?), last_updated_at = datetime('now')
          WHERE room_type_id = ? AND stay_date = ?
        `, [booking.num_rooms, booking.room_type_id, dateStr]);
      }

      // Update booking status
      tx.execute(`
        UPDATE bookings
        SET status = 'cancelled_by_customer', cancelled_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `, [bookingId]);

      // Record cancellation request
      const cancelReqId = tx.uuid();
      let validRequestedBy = null;
      if (requestedBy && tx.queryOne('SELECT id FROM user_profiles WHERE id = ?', [requestedBy])) {
        validRequestedBy = requestedBy;
      } else {
        validRequestedBy = booking.customer_id;
      }

      tx.execute(`
        INSERT INTO cancellation_requests (
          id, booking_id, requester_role, requested_by, reason, policy_snapshot,
          calculated_refund_paise, cancellation_fee_paise, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'under_review')
      `, [
        cancelReqId, bookingId, requesterRole, validRequestedBy, reason,
        booking.cancellation_policy_snapshot, calculatedRefundPaise, cancellationFeePaise
      ]);

      tx.logAudit({
        actorId: validRequestedBy,
        actorRole: requesterRole,
        action: 'booking.cancelled',
        entityType: 'booking',
        entityId: bookingId,
        afterState: { refundPercentage, calculatedRefundPaise, cancellationFeePaise }
      });

      return {
        success: true,
        bookingId,
        status: 'cancelled_by_customer',
        refundPercentage,
        calculatedRefundINR: calculatedRefundPaise / 100,
        cancellationFeeINR: cancellationFeePaise / 100
      };
    });
  }
}

module.exports = { BookingService };
