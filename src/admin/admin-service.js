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
}

module.exports = { AdminService };
