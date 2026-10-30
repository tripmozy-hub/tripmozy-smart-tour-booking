// ============================================================================
// TripMozy Role-Based Access Control & Permission Enforcement
// ============================================================================

const ROLES = {
  CUSTOMER: 'customer',
  VENDOR: 'vendor',
  SUPPORT: 'support',
  ADMIN: 'admin'
};

class AccessControlError extends Error {
  constructor(message, code = 'FORBIDDEN') {
    super(message);
    this.name = 'AccessControlError';
    this.code = code;
  }
}

class SecurityContext {
  constructor({ user = null, role = 'unauthenticated', vendorId = null }) {
    this.user = user;
    this.role = role;
    this.vendorId = vendorId;
  }

  isAuthenticated() {
    return this.role !== 'unauthenticated' && !!this.user;
  }

  isCustomer() {
    return this.role === ROLES.CUSTOMER;
  }

  isVendor() {
    return this.role === ROLES.VENDOR;
  }

  isSupport() {
    return this.role === ROLES.SUPPORT;
  }

  isAdmin() {
    return this.role === ROLES.ADMIN;
  }

  // Check if current actor can view a customer stay request
  canViewRequest(request) {
    if (this.isAdmin() || this.isSupport()) return true;
    if (this.isCustomer() && request.customer_id === this.user.id) return true;
    return false;
  }

  // Check if current actor can manage a property
  canManageProperty(property) {
    if (this.isAdmin()) return true;
    if (this.isVendor() && property.vendor_id === this.vendorId) return true;
    return false;
  }

  // Check if current actor can view a property
  canViewProperty(property) {
    if (property.status === 'active') return true;
    if (this.isAdmin() || this.isSupport()) return true;
    if (this.isVendor() && property.vendor_id === this.vendorId) return true;
    return false;
  }

  // Check if current actor can respond to a booking recipient
  canRespondToRecipient(recipient) {
    if (this.isAdmin()) return true;
    if (this.isVendor() && recipient.vendor_id === this.vendorId) return true;
    return false;
  }

  // Check if actor can view booking
  canViewBooking(booking) {
    if (this.isAdmin() || this.isSupport()) return true;
    if (this.isCustomer() && booking.customer_id === this.user.id) return true;
    if (this.isVendor() && booking.property_vendor_id === this.vendorId) return true;
    return false;
  }

  // Check if actor can view payments
  canViewPayments(payment, booking) {
    if (this.isAdmin() || this.isSupport()) return true;
    if (this.isCustomer() && booking.customer_id === this.user.id) return true;
    // Vendors cannot view customer raw payment records/card details
    return false;
  }

  // Check if actor can view commission details
  canViewCommission(ledger) {
    if (this.isAdmin()) return true;
    if (this.isVendor() && ledger.vendor_id === this.vendorId) return true;
    // Customers can never view platform commissions
    return false;
  }

  // Require specific role or throw
  requireRole(allowedRoles) {
    const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    if (!roles.includes(this.role)) {
      throw new AccessControlError(
        `Access denied. Required role in [${roles.join(', ')}], current role: '${this.role}'`,
        'INSUFFICIENT_PERMISSIONS'
      );
    }
  }

  // Mask customer PII for vendors until booking is confirmed
  sanitizeCustomerForVendor(customer, isConfirmed = false) {
    if (isConfirmed) {
      return {
        name: customer.display_name || customer.guest_name,
        phone: customer.phone || customer.guest_phone,
        email: customer.email || customer.guest_email
      };
    }
    // Anonymized preview before booking
    const nameParts = (customer.display_name || customer.guest_name || 'Guest').split(' ');
    const firstName = nameParts[0] || 'Guest';
    return {
      name: `${firstName} (Verified Traveler)`,
      phone: 'Hidden until booking confirmed',
      email: 'Hidden until booking confirmed'
    };
  }
}

module.exports = {
  ROLES,
  AccessControlError,
  SecurityContext
};
