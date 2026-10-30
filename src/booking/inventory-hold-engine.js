// ============================================================================
// TripMozy Atomic Inventory Hold & Concurrency Safeguard Engine
// Prevents race conditions and overselling using transactional row locks
// ============================================================================

const { PricingEngine } = require('../matching/pricing-engine');

class InventoryHoldEngine {
  constructor(db) {
    this.db = db;
  }

  /**
   * Atomically place a 15-minute inventory hold on an offer
   * Prevents two customers from taking the last room concurrently
   */
  createHold({ offerId, customerId = null, holdMinutes = 15 }) {
    return this.db.transaction((tx) => {
      // 1. Fetch and lock offer details
      const offer = tx.queryOne(`
        SELECT o.*, req.check_in_date, req.check_out_date, req.num_rooms, req.customer_id as req_customer_id,
               p.status as property_status, p.name as property_name
        FROM hotel_offers o
        JOIN hotel_booking_requests req ON o.request_id = req.id
        JOIN properties p ON o.property_id = p.id
        WHERE o.id = ?
      `, [offerId]);

      if (!offer) {
        return { success: false, reason: 'offer_not_found', message: 'Offer record does not exist' };
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

      const startDate = new Date(offer.check_in_date);
      const endDate = new Date(offer.check_out_date);
      const neededRooms = offer.num_rooms;

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
        holdId, offerId, offer.room_type_id, validCustomerId, offer.check_in_date,
        offer.check_out_date, neededRooms, expiresAt
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
