// ============================================================================
// TripMozy Admin Console & Operational Health Service
// System management, verification, audit logs & operational metrics
// ============================================================================

const { AccessControlError } = require('../auth/roles');

class AdminService {
  constructor(db) {
    this.db = db;
  }

  // Ensure caller has admin privileges
  assertAdmin(actorContext) {
    if (!actorContext || !actorContext.isAdmin()) {
      throw new AccessControlError('Access denied: Administrator privileges required');
    }
  }

  // Update vendor verification status
  setVendorVerification({ vendorId, newStatus, reason = '', actorContext }) {
    this.assertAdmin(actorContext);
    const valid = ['pending', 'verified', 'rejected', 'suspended'];
    if (!valid.includes(newStatus)) throw new Error(`Invalid status: ${newStatus}`);

    const before = this.db.queryOne('SELECT id, business_name, verification_status FROM vendor_accounts WHERE id = ?', [vendorId]);
    if (!before) throw new Error(`Vendor ${vendorId} not found`);

    this.db.execute("UPDATE vendor_accounts SET verification_status = ?, updated_at = datetime('now') WHERE id = ?", [newStatus, vendorId]);

    this.db.logAudit({
      actorId: actorContext.user?.id,
      actorRole: 'admin',
      action: 'vendor.verification_change',
      entityType: 'vendor_account',
      entityId: vendorId,
      beforeState: { status: before.verification_status },
      afterState: { status: newStatus, reason }
    });

    return { vendorId, status: newStatus };
  }

  // Suspend property with mandatory reason
  suspendProperty({ propertyId, reason, actorContext }) {
    this.assertAdmin(actorContext);
    if (!reason || reason.trim().length < 5) {
      throw new Error('Mandatory audit reason required for property suspension');
    }

    const before = this.db.queryOne('SELECT id, name, status FROM properties WHERE id = ?', [propertyId]);
    if (!before) throw new Error(`Property ${propertyId} not found`);

    this.db.execute("UPDATE properties SET status = 'suspended', updated_at = datetime('now') WHERE id = ?", [propertyId]);

    this.db.logAudit({
      actorId: actorContext.user?.id,
      actorRole: 'admin',
      action: 'property.suspend',
      entityType: 'property',
      entityId: propertyId,
      beforeState: { status: before.status },
      afterState: { status: 'suspended', reason }
    });

    return { propertyId, status: 'suspended', reason };
  }

  // Fetch operational metrics
  getOperationalMetrics(actorContext) {
    this.assertAdmin(actorContext);

    const propertiesCount = this.db.queryOne("SELECT COUNT(*) as count FROM properties WHERE status = 'active'").count;
    const totalRequests = this.db.queryOne('SELECT COUNT(*) as count FROM hotel_booking_requests').count;
    const totalRecipients = this.db.queryOne('SELECT COUNT(*) as count FROM booking_request_recipients').count;
    const acceptedRecipients = this.db.queryOne("SELECT COUNT(*) as count FROM booking_request_recipients WHERE response_status = 'accepted'").count;
    const totalBookings = this.db.queryOne("SELECT COUNT(*) as count FROM bookings WHERE status = 'confirmed'").count;

    const gtvPaise = this.db.queryOne("SELECT COALESCE(SUM(total_amount_paise), 0) as sum FROM bookings WHERE status = 'confirmed'").sum;
    const commissionPaise = this.db.queryOne("SELECT COALESCE(SUM(commission_amount_paise), 0) as sum FROM commission_ledger").sum;
    const pendingRefunds = this.db.queryOne("SELECT COUNT(*) as count FROM cancellation_requests WHERE status IN ('requested', 'under_review')").count;
    const failedNotifications = this.db.queryOne("SELECT COUNT(*) as count FROM notifications WHERE status = 'failed'").count;

    const responseRate = totalRecipients > 0 ? Math.round((acceptedRecipients / totalRecipients) * 100) : 0;

    return {
      activeProperties: propertiesCount,
      totalRequests,
      totalRecipientsDispatched: totalRecipients,
      offersSubmitted: acceptedRecipients,
      vendorResponseRatePercent: responseRate,
      confirmedBookings: totalBookings,
      grossBookingVolumeINR: gtvPaise / 100,
      platformCommissionINR: commissionPaise / 100,
      pendingRefunds,
      failedNotifications,
      systemHealth: failedNotifications === 0 ? 'HEALTHY' : 'ATTENTION_NEEDED'
    };
  }

  // Search Audit Logs
  getAuditLogs({ limit = 50, entityType = null, actorContext }) {
    this.assertAdmin(actorContext);
    if (entityType) {
      return this.db.query('SELECT * FROM audit_logs WHERE entity_type = ? ORDER BY created_at DESC LIMIT ?', [entityType, limit]);
    }
    return this.db.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?', [limit]);
  }

  // ==========================================================================
  // Platform Movements, Request Monitor & Operator Oversight
  // ==========================================================================

  // Get all customer requests and vendor movements (Full Oversight)
  getAllMovements(actorContext) {
    this.assertAdmin(actorContext);

    const requests = this.db.query(`
      SELECT req.*, u.email as u_email, u.phone as u_phone
      FROM hotel_booking_requests req
      LEFT JOIN user_profiles u ON req.customer_id = u.id
      ORDER BY req.created_at DESC
    `);

    return requests.map(req => {
      // Find winning/accepted recipient or offer
      const offer = this.db.queryOne(`
        SELECT o.*, p.name as property_name, p.city as property_city,
               v.id as vendor_id, v.business_name as vendor_name, v.contact_person,
               v.contact_phone, v.contact_email
        FROM hotel_offers o
        JOIN properties p ON o.property_id = p.id
        JOIN vendor_accounts v ON p.vendor_id = v.id
        WHERE o.request_id = ?
        ORDER BY o.created_at DESC LIMIT 1
      `, [req.id]);

      const acceptedRecipient = !offer ? this.db.queryOne(`
        SELECT r.*, p.name as property_name, v.id as vendor_id, v.business_name as vendor_name,
               v.contact_person, v.contact_phone, v.contact_email
        FROM booking_request_recipients r
        JOIN properties p ON r.property_id = p.id
        JOIN vendor_accounts v ON r.vendor_id = v.id
        WHERE r.request_id = ? AND r.response_status = 'accepted'
        LIMIT 1
      `, [req.id]) : null;

      // Find booking & payment
      const booking = this.db.queryOne(`
        SELECT b.*, pay.provider_payment_id as payment_reference, pay.amount_paise as paid_paise, pay.created_at as paid_at
        FROM bookings b
        LEFT JOIN payments pay ON b.id = pay.booking_id
        WHERE b.request_id = ?
        LIMIT 1
      `, [req.id]);

      const totalBudgetINR = (req.total_budget_paise || 0) / 100;
      const totalAmountINR = booking ? (booking.total_amount_paise / 100) : (offer ? offer.total_payable_paise / 100 : totalBudgetINR);
      const advancePaidINR = booking ? (booking.paid_paise ? booking.paid_paise / 100 : Math.round(totalAmountINR * 0.315)) : 0;
      const advancePayableINR = Math.round(totalAmountINR * 0.315);
      const remainingBalanceINR = totalAmountINR - advancePayableINR;

      let paymentStatus = 'pending';
      if (booking && booking.status === 'confirmed') {
        paymentStatus = 'paid';
      } else if (req.status === 'booked') {
        paymentStatus = 'paid';
      } else if (offer) {
        paymentStatus = 'quoted';
      }

      const custObj = {
        name: req.guest_name || 'Traveler',
        phone: req.guest_phone || req.u_phone || '',
        email: req.guest_email || req.u_email || ''
      };

      const tourObj = {
        destination: req.destination,
        locality: req.destination_locality || 'All Circuits',
        destinationLocality: req.destination_locality || 'All Circuits',
        check_in_date: req.check_in_date,
        checkInDate: req.check_in_date,
        check_out_date: req.check_out_date,
        checkOutDate: req.check_out_date,
        duration_nights: req.nights,
        nights: req.nights,
        days: (req.nights || 1) + 1,
        duration: `${(req.nights || 1) + 1} Days / ${req.nights || 1} Nights`,
        rooms_required: req.num_rooms,
        numRooms: req.num_rooms,
        adults: req.num_adults,
        numAdults: req.num_adults,
        children: req.num_children || 0,
        numChildren: req.num_children || 0,
        roomPreference: req.room_preference || 'Standard',
        facilities: JSON.parse(req.required_facilities || '[]'),
        requiredFacilities: JSON.parse(req.required_facilities || '[]'),
        budget_min_inr: Math.round(totalBudgetINR * 0.85),
        budget_max_inr: totalBudgetINR,
        totalBudgetINR
      };

      const opObj = (offer || acceptedRecipient) ? {
        vendor_id: (offer || acceptedRecipient).vendor_id,
        vendorId: (offer || acceptedRecipient).vendor_id,
        business_name: (offer || acceptedRecipient).vendor_name,
        businessName: (offer || acceptedRecipient).vendor_name,
        contact_person: (offer || acceptedRecipient).contact_person,
        contactPerson: (offer || acceptedRecipient).contact_person,
        phone: (offer || acceptedRecipient).contact_phone,
        contactPhone: (offer || acceptedRecipient).contact_phone,
        email: (offer || acceptedRecipient).contact_email,
        contactEmail: (offer || acceptedRecipient).contact_email,
        property_name: (offer || acceptedRecipient).property_name,
        propertyName: (offer || acceptedRecipient).property_name,
        city: (offer || acceptedRecipient).property_city || 'All Destinations'
      } : null;

      const offerObj = offer ? {
        offer_id: offer.id,
        offerId: offer.id,
        offer_reference: offer.offer_reference,
        offerReference: offer.offer_reference,
        total_price_inr: totalAmountINR,
        totalPackageINR: totalAmountINR,
        advance_deposit_inr: advancePayableINR,
        advancePayableINR,
        remaining_balance_inr: remainingBalanceINR,
        remainingBalanceINR,
        meal_plan: offer.meal_plan,
        mealPlan: offer.meal_plan,
        cancellationTerms: offer.cancellation_terms,
        inclusions: JSON.parse(offer.special_inclusions || '{"inclusions":[]}').inclusions || []
      } : null;

      const payObj = {
        status: paymentStatus,
        payment_status: paymentStatus === 'paid' ? 'captured' : 'pending',
        isPaid: paymentStatus === 'paid',
        is_paid: paymentStatus === 'paid',
        amount_paid_inr: paymentStatus === 'paid' ? (advancePaidINR || advancePayableINR) : 0,
        advancePaidINR: paymentStatus === 'paid' ? (advancePaidINR || advancePayableINR) : 0,
        advance_deposit_inr: advancePayableINR,
        advancePayableINR,
        remaining_balance_inr: remainingBalanceINR,
        remainingBalanceINR,
        gateway_payment_id: booking?.payment_reference || (paymentStatus === 'paid' ? `pay_rzp_live_${Date.now()}` : null),
        paymentReference: booking?.payment_reference || (paymentStatus === 'paid' ? `pay_rzp_live_${Date.now()}` : null),
        paid_at: booking?.paid_at || null,
        paidAt: booking?.paid_at || null,
        booking_reference: booking?.booking_reference || null,
        bookingReference: booking?.booking_reference || null
      };

      return {
        id: req.id,
        reference: req.request_reference,
        customer: custObj,
        guest: custObj,
        tour: tourObj,
        acceptedOperator: opObj,
        operator: opObj,
        offer: offerObj,
        quote: offerObj,
        payment: payObj,
        status: req.status === 'booked' ? 'booked' : (offer ? 'offers_available' : req.status),
        requestStatus: req.status,
        createdAt: req.created_at,
        created_at: req.created_at
      };
    });
  }

  // Get all registered tour operators
  getAllVendors(actorContext) {
    this.assertAdmin(actorContext);

    const vendors = this.db.query(`
      SELECT v.*, u.email as user_email, u.phone as user_phone, u.display_name as user_display_name,
             p.name as primary_property_name, p.city as primary_city, p.state as primary_state
      FROM vendor_accounts v
      JOIN user_profiles u ON v.user_id = u.id
      LEFT JOIN properties p ON p.vendor_id = v.id AND p.status = 'active'
      ORDER BY v.created_at DESC
    `);

    // Deduplicate by vendor id
    const vendorMap = new Map();
    for (const row of vendors) {
      if (!vendorMap.has(row.id)) {
        const stats = this.db.queryOne(`
          SELECT 
            COUNT(r.id) as total_received,
            SUM(CASE WHEN r.response_status = 'accepted' THEN 1 ELSE 0 END) as total_accepted
          FROM booking_request_recipients r
          WHERE r.vendor_id = ?
        `, [row.id]);

        vendorMap.set(row.id, {
          id: row.id,
          businessName: row.business_name,
          contactPerson: row.contact_person,
          contactPhone: row.contact_phone,
          contactEmail: row.contact_email,
          city: row.primary_city || 'All Destinations',
          state: row.primary_state || 'India',
          propertyName: row.primary_property_name || `${row.business_name} - Fleet`,
          verificationStatus: row.verification_status,
          status: row.status,
          commissionRateBps: row.commission_rate_basis_points,
          requestsReceived: stats?.total_received || 0,
          requestsAccepted: stats?.total_accepted || 0,
          createdAt: row.created_at
        });
      }
    }

    return Array.from(vendorMap.values());
  }

  // Add a new tour operator
  addVendor(payload = {}) {
    const actorContext = payload.actorContext;
    this.assertAdmin(actorContext);

    const businessName = payload.businessName || payload.companyName || payload.name;
    const contactPerson = payload.contactPerson || payload.person || businessName;
    const contactPhone = payload.contactPhone || payload.phone;
    const contactEmail = payload.contactEmail || payload.email;
    const city = payload.city || 'All Destinations';
    const state = payload.state || 'India';
    const propertyName = payload.propertyName || null;
    const commissionBps = payload.commissionBps || 1500;

    if (!businessName || !contactPhone || !contactEmail) {
      throw new Error('Business name, contact phone, and contact email are required');
    }

    return this.db.transaction(tx => {
      let user = tx.queryOne('SELECT id FROM user_profiles WHERE LOWER(email) = LOWER(?) LIMIT 1', [contactEmail]);
      let userId = user ? user.id : tx.uuid();
      if (!user) {
        tx.execute(`
          INSERT INTO user_profiles (id, email, phone, role, display_name, status, is_phone_verified, is_email_verified)
          VALUES (?, ?, ?, 'vendor', ?, 'active', 1, 1)
        `, [userId, contactEmail, contactPhone, contactPerson || businessName]);
      } else {
        tx.execute("UPDATE user_profiles SET role = 'vendor', status = 'active' WHERE id = ?", [userId]);
      }

      const vendorId = tx.uuid();
      tx.execute(`
        INSERT INTO vendor_accounts (
          id, user_id, business_name, contact_email, contact_phone, contact_person,
          verification_status, commission_rate_basis_points, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, 'active')
      `, [vendorId, userId, businessName, contactEmail, contactPhone, contactPerson || businessName, commissionBps]);

      const propId = tx.uuid();
      const propTitle = propertyName || `${businessName} Tour Fleet & Stays`;
      const slug = propTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + vendorId.slice(0, 6);

      tx.execute(`
        INSERT INTO properties (
          id, vendor_id, name, slug, property_type, star_rating,
          description, address_line, city, state, pincode, country,
          latitude, longitude, timezone, check_in_time, check_out_time,
          status, inventory_mode
        ) VALUES (?, ?, ?, ?, 'hotel', 4.8, ?, ?, ?, ?, '110001', 'India', 28.6139, 77.2090, 'Asia/Kolkata', '12:00', '11:00', 'active', 'vendor_confirmed')
      `, [
        propId, vendorId, propTitle, slug,
        `Verified partner tour fleet and curated packages by ${businessName}.`,
        `${propTitle}, ${city}`, city, state
      ]);

      const roomTypeId = tx.uuid();
      tx.execute(`
        INSERT INTO room_types (
          id, property_id, name, bed_type, max_adults, max_children, total_inventory,
          is_ac, is_accessible, is_active
        ) VALUES (?, ?, 'Deluxe Tour Package', 'King', 4, 2, 20, 1, 1, 1)
      `, [roomTypeId, propId]);

      const rateId = tx.uuid();
      tx.execute(`
        INSERT INTO room_rates (
          id, room_type_id, rate_plan_name, base_nightly_rate_paise, tax_rate_basis_points,
          meal_plan, cancellation_rule, is_active
        ) VALUES (?, ?, 'Standard Package', 350000, 500, 'Breakfast Included', 'moderate', 1)
      `, [rateId, roomTypeId]);

      return {
        id: vendorId,
        businessName,
        contactPerson: contactPerson || businessName,
        contactPhone,
        contactEmail,
        city,
        state,
        propertyName: propTitle,
        verificationStatus: 'verified',
        status: 'active'
      };
    });
  }

  // Update vendor status (active / suspended)
  updateVendorStatus({ vendorId, status, verificationStatus, actorContext }) {
    this.assertAdmin(actorContext);
    const updates = [];
    const params = [];
    if (status) {
      updates.push('status = ?');
      params.push(status);
    }
    if (verificationStatus) {
      updates.push('verification_status = ?');
      params.push(verificationStatus);
    }
    updates.push("updated_at = datetime('now')");
    params.push(vendorId);

    this.db.execute(`UPDATE vendor_accounts SET ${updates.join(', ')} WHERE id = ?`, params);
    if (status === 'suspended') {
      this.db.execute("UPDATE properties SET status = 'suspended' WHERE vendor_id = ?", [vendorId]);
    } else if (status === 'active') {
      this.db.execute("UPDATE properties SET status = 'active' WHERE vendor_id = ?", [vendorId]);
    }
    return { success: true, vendorId, status };
  }

  // Delete / Remove tour operator
  removeVendor({ vendorId, actorContext }) {
    this.assertAdmin(actorContext);
    this.db.execute("UPDATE vendor_accounts SET status = 'suspended', verification_status = 'suspended', updated_at = datetime('now') WHERE id = ?", [vendorId]);
    this.db.execute("UPDATE properties SET status = 'suspended', updated_at = datetime('now') WHERE vendor_id = ?", [vendorId]);
    return { success: true, vendorId, removed: true };
  }

  // Featured Tours: Get all active cards
  getFeaturedTours() {
    const cards = this.db.query(`
      SELECT * FROM featured_tour_cards
      WHERE is_active = 1
      ORDER BY display_order ASC, created_at DESC
    `);

    return cards.map(c => ({
      ...c,
      highlights: JSON.parse(c.highlights_json || '[]'),
      inclusions: JSON.parse(c.inclusions_json || '[]')
    }));
  }

  // Featured Tours: Add a new card
  addFeaturedTour(payload = {}) {
    const actorContext = payload.actorContext;
    this.assertAdmin(actorContext);
    const id = this.db.uuid();
    const title = payload.title || 'Exclusive Tour Circuit';
    const destination = payload.destination || payload.location || payload.city || 'India';
    const nightsNum = parseInt(payload.nights) || 5;
    const daysNum = parseInt(payload.days) || (nightsNum + 1);
    const durationStr = payload.duration || `${daysNum} Days / ${nightsNum} Nights`;

    let rawPrice = payload.startingPriceINR || payload.starting_price_inr || payload.price || 35000;
    if (typeof rawPrice === 'string') {
      rawPrice = parseInt(rawPrice.replace(/[^\d]/g, ''), 10) || 35000;
    }
    const priceNum = rawPrice;
    const badge = payload.badge || 'Featured';
    const imageUrl = payload.imageUrl || payload.image || '';
    const overview = payload.overview || '';
    const highlights = payload.highlights || [];
    const inclusions = payload.inclusions || [];

    this.db.execute(`
      INSERT INTO featured_tour_cards (
        id, title, destination, duration, nights, days, starting_price_inr,
        badge, image_url, overview, highlights_json, inclusions_json, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [
      id,
      title,
      destination,
      durationStr,
      nightsNum,
      daysNum,
      priceNum,
      badge,
      imageUrl,
      overview,
      JSON.stringify(Array.isArray(highlights) ? highlights : (highlights ? [highlights] : [])),
      JSON.stringify(Array.isArray(inclusions) ? inclusions : (inclusions ? [inclusions] : []))
    ]);

    return { id, title, destination, duration: durationStr, starting_price_inr: priceNum };
  }

  // Featured Tours: Remove card
  removeFeaturedTour({ id, actorContext }) {
    this.assertAdmin(actorContext);
    this.db.execute('DELETE FROM featured_tour_cards WHERE id = ?', [id]);
    return { success: true, id, removed: true };
  }
}

module.exports = { AdminService };
