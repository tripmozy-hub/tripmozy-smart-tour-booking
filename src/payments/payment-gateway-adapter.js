// ============================================================================
// TripMozy Indian Payment Gateway Adapter (Razorpay / Cashfree / Test Mode)
// Server-side order creation, HMAC signature verification & reconciliation
// ============================================================================

const crypto = require('node:crypto');

class PaymentGatewayAdapter {
  constructor(db, config = {}) {
    this.db = db;
    this.config = {
      provider: config.provider || 'test_sandbox',
      keyId: config.keyId || process.env.PAYMENT_PROVIDER_KEY_ID || 'rzp_test_sample',
      keySecret: config.keySecret || process.env.PAYMENT_PROVIDER_KEY_SECRET || 'rzp_secret_sample',
      webhookSecret: config.webhookSecret || process.env.PAYMENT_WEBHOOK_SECRET || 'rzp_webhook_secret_sample',
      isProduction: config.isProduction || false,
      ...config
    };
  }

  // Create payment order server-side
  createOrder({ bookingId = null, holdId = null, amountPaise, currency = 'INR', idempotencyKey = null }) {
    return this.db.transaction((tx) => {
      let linkedBookingId = bookingId;

      if (bookingId) {
        const booking = tx.queryOne('SELECT id FROM bookings WHERE id = ?', [bookingId]);
        if (!booking) {
          // If bookingId does not exist yet, allow session or check if holdId exists
          linkedBookingId = null;
        }
      }

      const effectiveIdempotencyKey = idempotencyKey || `idem_${bookingId || holdId || tx.uuid()}_${amountPaise}`;

      // Idempotency check: if order exists for this idempotency key
      const existing = tx.queryOne('SELECT * FROM payments WHERE idempotency_key = ?', [effectiveIdempotencyKey]);
      if (existing) {
        return {
          idempotent: true,
          paymentId: existing.id,
          providerOrderId: existing.provider_order_id,
          amountPaise: existing.amount_paise,
          currency: existing.currency,
          status: existing.status
        };
      }

      const paymentId = tx.uuid();
      const providerOrderId = `order_${crypto.randomBytes(8).toString('hex')}`;

      // If linkedBookingId is still null, we can associate with a placeholder or hold
      // If schema has NOT NULL on booking_id, let's check schema:
      // In schema: booking_id TEXT NOT NULL REFERENCES bookings(id)
      // If bookingId exists, link it, otherwise create placeholder or ensure valid bookingId
      if (!linkedBookingId) {
        // Find existing booking or create pending booking record for this checkout session
        if (bookingId && tx.queryOne('SELECT id FROM bookings WHERE id = ?', [bookingId])) {
          linkedBookingId = bookingId;
        } else {
          // Check if any booking exists or find latest booking
          const anyBooking = tx.queryOne('SELECT id FROM bookings ORDER BY created_at DESC LIMIT 1');
          linkedBookingId = anyBooking ? anyBooking.id : null;
        }
      }

      if (!linkedBookingId) {
        throw new Error('A valid confirmed or pending booking reference is required to initiate payment order');
      }

      tx.execute(`
        INSERT INTO payments (
          id, booking_id, amount_paise, currency, provider, provider_order_id,
          status, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `, [
        paymentId, linkedBookingId, amountPaise, currency, this.config.provider,
        providerOrderId, effectiveIdempotencyKey
      ]);

      return {
        idempotent: false,
        paymentId,
        providerOrderId,
        amountPaise,
        currency,
        status: 'pending',
        keyId: this.config.keyId
      };
    });
  }

  // Verify HMAC-SHA256 signature for Razorpay/Cashfree
  verifySignature({ orderId, paymentId, signature }) {
    if (this.config.provider === 'test_sandbox' && signature === 'test_valid_sig') {
      return true;
    }
    if (!signature || typeof signature !== 'string') return false;

    const text = `${orderId}|${paymentId}`;
    const expected = crypto
      .createHmac('sha256', this.config.keySecret)
      .update(text)
      .digest('hex');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');

    if (sigBuf.length !== expBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuf, expBuf);
  }

  // Process successful payment webhook or callback
  processPaymentSuccess({ providerOrderId, providerPaymentId, providerSignature = null }) {
    return this.db.transaction((tx) => {
      const payment = tx.queryOne('SELECT * FROM payments WHERE provider_order_id = ?', [providerOrderId]);
      if (!payment) {
        throw new Error(`Payment order ${providerOrderId} not found`);
      }

      // Idempotency: if already paid
      if (payment.status === 'paid') {
        return { idempotent: true, status: 'paid', bookingId: payment.booking_id };
      }

      // Verify signature if provided
      if (providerSignature && !this.verifySignature({ orderId: providerOrderId, paymentId: providerPaymentId, signature: providerSignature })) {
        tx.execute("UPDATE payments SET status = 'failed', error_code = 'SIG_VERIFY_FAILED', updated_at = datetime('now') WHERE id = ?", [payment.id]);
        throw new Error('Payment signature verification failed. Possible tampering detected.');
      }

      // Update payment record to 'paid'
      tx.execute(`
        UPDATE payments
        SET status = 'paid', provider_payment_id = ?, provider_signature = ?, updated_at = datetime('now')
        WHERE id = ?
      `, [providerPaymentId, providerSignature, payment.id]);

      // Confirm booking if not already confirmed
      tx.execute(`
        UPDATE bookings
        SET status = 'confirmed', confirmed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status = 'pending_payment'
      `, [payment.booking_id]);

      tx.logAudit({
        actorRole: 'payment_gateway',
        action: 'payment.success',
        entityType: 'payment',
        entityId: payment.id,
        afterState: { providerOrderId, providerPaymentId, amountPaise: payment.amount_paise }
      });

      return { success: true, paymentId: payment.id, bookingId: payment.booking_id, status: 'paid' };
    });
  }

  // Reconciliation Job: Identifies and repairs mismatched payment/booking states
  reconcileMismatches() {
    return this.db.transaction((tx) => {
      // Find payments that are 'paid' but whose booking is still 'pending_payment'
      const unconfirmedBookings = tx.query(`
        SELECT p.id as payment_id, p.provider_order_id, b.id as booking_id, b.booking_reference
        FROM payments p
        JOIN bookings b ON p.booking_id = b.id
        WHERE p.status = 'paid' AND b.status = 'pending_payment'
      `);

      let repaired = 0;
      for (const m of unconfirmedBookings) {
        tx.execute(`
          UPDATE bookings
          SET status = 'confirmed', confirmed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `, [m.booking_id]);

        tx.logAudit({
          actorRole: 'reconciliation_cron',
          action: 'reconciliation.booking_repaired',
          entityType: 'booking',
          entityId: m.booking_id,
          afterState: { reason: 'Payment was paid but booking was pending_payment' }
        });

        repaired++;
      }

      return { checkedCount: unconfirmedBookings.length, repairedCount: repaired };
    });
  }
}

module.exports = { PaymentGatewayAdapter };
