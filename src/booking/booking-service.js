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

  // Confirm booking from an active inventory hold
  confirmBooking({ holdId, customerId, paymentReference = 'DIRECT_VERIFIED', remainingPaymentOption = 'hotel_arrival', actorContext }) {
    return this.db.transaction((tx) => {
      // 1. Verify hold
      const hold = tx.queryOne(`
        SELECT h.*, o.property_id, o.room_type_id, o.subtotal_paise, o.tax_paise,
               o.total_payable_paise, o.meal_plan, o.cancellation_terms, o.request_id,
               req.guest_name, req.guest_phone, req.guest_email, req.nights,
               req.num_adults, req.num_children, req.customer_id as req_customer_id,
               p.vendor_id, p.name as property_name, p.city as property_city,
               v.commission_rate_basis_points
        FROM inventory_holds h
        JOIN hotel_offers o ON h.offer_id = o.id
        JOIN hotel_booking_requests req ON o.request_id = req.id
        JOIN properties p ON o.property_id = p.id
        JOIN vendor_accounts v ON p.vendor_id = v.id
        WHERE h.id = ?
      `, [holdId]);

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
      const termsSnapshot = {
        mealPlan: hold.meal_plan,
        cancellationTerms: hold.cancellation_terms,
        propertySnapshot: { name: hold.property_name, city: hold.property_city },
        guestSnapshot: { name: hold.guest_name, phone: hold.guest_phone, email: hold.guest_email },
        tourPricing,
        advancePaidINR: tourPricing.payableNowINR,
        advancePaidPaise: tourPricing.payableNowPaise,
        remainingBalanceINR: tourPricing.remainingBalanceINR,
        remainingBalancePaise: tourPricing.remainingBalancePaise,
        remainingPaymentOption: remainingPaymentOption || 'hotel_arrival',
        paymentReference,
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

      tx.logAudit({
        actorId: effectiveCustomerId,
        actorRole: 'customer',
        action: 'booking.confirmed',
        entityType: 'booking',
        entityId: bookingId,
        afterState: { bookingReference, totalPayablePaise: hold.total_payable_paise, paymentReference }
      });

      return {
        success: true,
        bookingId,
        bookingReference,
        status: 'confirmed',
        propertyName: hold.property_name,
        checkInDate: hold.check_in_date,
        checkOutDate: hold.check_out_date,
        nights: hold.nights,
        numRooms: hold.quantity,
        totalAmountINR: hold.total_payable_paise / 100,
        advancePaidINR: tourPricing.payableNowINR,
        remainingBalanceINR: tourPricing.remainingBalanceINR,
        remainingPaymentOption: remainingPaymentOption || 'hotel_arrival',
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
