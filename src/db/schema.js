// ============================================================================
// TripMozy Database Schema Initializer (Runtime engine)
// ============================================================================

const DDL_STATEMENTS = `
PRAGMA foreign_keys = ON;

-- 1. USER PROFILES
CREATE TABLE IF NOT EXISTS user_profiles (
    id TEXT PRIMARY KEY,
    auth_user_id TEXT UNIQUE,
    email TEXT NOT NULL UNIQUE,
    phone TEXT,
    role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer', 'vendor', 'support', 'admin')),
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'pending_verification')),
    is_phone_verified INTEGER NOT NULL DEFAULT 0,
    is_email_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. VENDOR ACCOUNTS
CREATE TABLE IF NOT EXISTS vendor_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    business_name TEXT NOT NULL,
    gstin TEXT,
    pan TEXT,
    contact_person TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending', 'verified', 'rejected', 'suspended')),
    agreement_signed_at TEXT,
    payout_details_reference TEXT,
    commission_rate_basis_points INTEGER NOT NULL DEFAULT 1500,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3. PROPERTIES
CREATE TABLE IF NOT EXISTS properties (
    id TEXT PRIMARY KEY,
    vendor_id TEXT NOT NULL REFERENCES vendor_accounts(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    property_type TEXT NOT NULL DEFAULT 'hotel' CHECK(property_type IN ('hotel', 'resort', 'homestay')),
    star_rating REAL DEFAULT 4.0 CHECK (star_rating >= 1.0 AND star_rating <= 5.0),
    description TEXT,
    address_line TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    pincode TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT 'India',
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    check_in_time TEXT NOT NULL DEFAULT '14:00',
    check_out_time TEXT NOT NULL DEFAULT '11:00',
    house_rules TEXT DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'under_review' CHECK(status IN ('draft', 'under_review', 'active', 'suspended', 'archived')),
    inventory_mode TEXT NOT NULL DEFAULT 'vendor_confirmed' CHECK(inventory_mode IN ('live_inventory', 'vendor_confirmed')),
    last_availability_confirmed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 4. PROPERTY PHOTOS
CREATE TABLE IF NOT EXISTS property_photos (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,
    caption TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_cover INTEGER NOT NULL DEFAULT 0,
    is_moderated INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 5. PROPERTY FACILITIES
CREATE TABLE IF NOT EXISTS property_facilities (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    facility_code TEXT NOT NULL,
    is_highlight INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(property_id, facility_code)
);

-- 6. ROOM TYPES
CREATE TABLE IF NOT EXISTS room_types (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    bed_type TEXT NOT NULL DEFAULT 'King',
    max_adults INTEGER NOT NULL DEFAULT 2 CHECK (max_adults >= 1),
    max_children INTEGER NOT NULL DEFAULT 1 CHECK (max_children >= 0),
    total_inventory INTEGER NOT NULL DEFAULT 1 CHECK (total_inventory >= 1),
    is_ac INTEGER NOT NULL DEFAULT 1,
    is_accessible INTEGER NOT NULL DEFAULT 0,
    amenities TEXT DEFAULT '[]',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 7. ROOM RATES
CREATE TABLE IF NOT EXISTS room_rates (
    id TEXT PRIMARY KEY,
    room_type_id TEXT NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
    rate_plan_name TEXT NOT NULL DEFAULT 'Standard EP',
    base_nightly_rate_paise INTEGER NOT NULL CHECK (base_nightly_rate_paise > 0),
    tax_rate_basis_points INTEGER NOT NULL DEFAULT 1200,
    meal_plan TEXT NOT NULL DEFAULT 'Room Only',
    cancellation_rule TEXT NOT NULL DEFAULT 'Free cancellation up to 48 hours before check-in',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 8. ROOM INVENTORY
CREATE TABLE IF NOT EXISTS room_inventory (
    id TEXT PRIMARY KEY,
    room_type_id TEXT NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
    stay_date TEXT NOT NULL,
    sellable_quantity INTEGER NOT NULL DEFAULT 0 CHECK (sellable_quantity >= 0),
    held_quantity INTEGER NOT NULL DEFAULT 0 CHECK (held_quantity >= 0),
    booked_quantity INTEGER NOT NULL DEFAULT 0 CHECK (booked_quantity >= 0),
    stop_sell INTEGER NOT NULL DEFAULT 0,
    last_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(room_type_id, stay_date)
);

-- 9. HOTEL BOOKING REQUESTS
CREATE TABLE IF NOT EXISTS hotel_booking_requests (
    id TEXT PRIMARY KEY,
    request_reference TEXT NOT NULL UNIQUE,
    customer_id TEXT REFERENCES user_profiles(id) ON DELETE SET NULL,
    guest_name TEXT NOT NULL,
    guest_email TEXT NOT NULL,
    guest_phone TEXT NOT NULL,
    destination TEXT NOT NULL,
    destination_locality TEXT,
    check_in_date TEXT NOT NULL,
    check_out_date TEXT NOT NULL,
    nights INTEGER NOT NULL CHECK (nights >= 1),
    num_rooms INTEGER NOT NULL DEFAULT 1 CHECK (num_rooms >= 1 AND num_rooms <= 10),
    num_adults INTEGER NOT NULL DEFAULT 2 CHECK (num_adults >= 1),
    num_children INTEGER NOT NULL DEFAULT 0 CHECK (num_children >= 0),
    children_ages TEXT DEFAULT '[]',
    total_budget_paise INTEGER NOT NULL CHECK (total_budget_paise > 0),
    property_type_preference TEXT,
    room_preference TEXT DEFAULT 'any',
    required_facilities TEXT DEFAULT '[]',
    communication_consent INTEGER NOT NULL DEFAULT 1,
    terms_accepted INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN (
        'draft', 'submitted', 'matching', 'dispatching', 'awaiting_responses',
        'offers_available', 'customer_selecting', 'reservation_pending',
        'booked', 'no_matches', 'expired', 'cancelled', 'failed'
    )),
    max_recipients INTEGER NOT NULL DEFAULT 10,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 10. BOOKING REQUEST RECIPIENTS
CREATE TABLE IF NOT EXISTS booking_request_recipients (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES hotel_booking_requests(id) ON DELETE CASCADE,
    property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    vendor_id TEXT NOT NULL REFERENCES vendor_accounts(id) ON DELETE CASCADE,
    delivery_status TEXT NOT NULL DEFAULT 'queued' CHECK(delivery_status IN ('queued', 'sent', 'delivered', 'viewed', 'failed')),
    response_status TEXT NOT NULL DEFAULT 'pending' CHECK(response_status IN ('pending', 'accepted', 'rejected', 'expired', 'cancelled')),
    sent_at TEXT,
    expires_at TEXT NOT NULL,
    action_token_hash TEXT NOT NULL,
    rejection_reason TEXT,
    rejection_note TEXT,
    responded_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(request_id, property_id)
);

-- 11. HOTEL OFFERS
CREATE TABLE IF NOT EXISTS hotel_offers (
    id TEXT PRIMARY KEY,
    offer_reference TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL REFERENCES hotel_booking_requests(id) ON DELETE CASCADE,
    property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL REFERENCES booking_request_recipients(id) ON DELETE CASCADE,
    room_type_id TEXT NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
    rate_id TEXT REFERENCES room_rates(id) ON DELETE SET NULL,
    nightly_base_paise INTEGER NOT NULL,
    total_nights INTEGER NOT NULL,
    total_rooms INTEGER NOT NULL,
    subtotal_paise INTEGER NOT NULL,
    tax_paise INTEGER NOT NULL,
    total_payable_paise INTEGER NOT NULL,
    is_budget_match INTEGER NOT NULL DEFAULT 1,
    meal_plan TEXT NOT NULL DEFAULT 'Room Only',
    cancellation_terms TEXT NOT NULL,
    special_inclusions TEXT DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('draft', 'submitted', 'valid', 'selected', 'expired', 'withdrawn', 'unavailable')),
    valid_until TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 12. INVENTORY HOLDS
CREATE TABLE IF NOT EXISTS inventory_holds (
    id TEXT PRIMARY KEY,
    offer_id TEXT NOT NULL REFERENCES hotel_offers(id) ON DELETE CASCADE,
    room_type_id TEXT NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
    customer_id TEXT REFERENCES user_profiles(id) ON DELETE SET NULL,
    check_in_date TEXT NOT NULL,
    check_out_date TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'consumed', 'released', 'timed_out')),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 13. BOOKINGS
CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    booking_reference TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL REFERENCES hotel_booking_requests(id) ON DELETE RESTRICT,
    offer_id TEXT NOT NULL REFERENCES hotel_offers(id) ON DELETE RESTRICT,
    hold_id TEXT REFERENCES inventory_holds(id) ON DELETE SET NULL,
    customer_id TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
    property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
    room_type_id TEXT NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
    check_in_date TEXT NOT NULL,
    check_out_date TEXT NOT NULL,
    num_rooms INTEGER NOT NULL,
    num_adults INTEGER NOT NULL,
    num_children INTEGER NOT NULL,
    total_nights INTEGER NOT NULL,
    base_amount_paise INTEGER NOT NULL,
    tax_amount_paise INTEGER NOT NULL,
    total_amount_paise INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    cancellation_policy_snapshot TEXT NOT NULL,
    terms_snapshot TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN (
        'pending_payment', 'confirmed', 'cancelled_by_customer',
        'cancelled_by_hotel', 'completed', 'disputed'
    )),
    confirmed_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 14. BOOKING ROOM NIGHTS
CREATE TABLE IF NOT EXISTS booking_room_nights (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    room_type_id TEXT NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
    stay_date TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    nightly_rate_paise INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(booking_id, stay_date)
);

-- 15. PAYMENTS
CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
    amount_paise INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    provider TEXT NOT NULL,
    provider_order_id TEXT NOT NULL UNIQUE,
    provider_payment_id TEXT UNIQUE,
    provider_signature TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('not_required', 'pending', 'authorized', 'paid', 'failed', 'partially_refunded', 'refunded', 'disputed')),
    idempotency_key TEXT NOT NULL UNIQUE,
    error_code TEXT,
    error_description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 16. REFUNDS
CREATE TABLE IF NOT EXISTS refunds (
    id TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    currency TEXT NOT NULL DEFAULT 'INR',
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested', 'approved', 'processing', 'completed', 'failed', 'rejected')),
    provider_refund_id TEXT,
    approved_by TEXT REFERENCES user_profiles(id) ON DELETE SET NULL,
    approved_at TEXT,
    processed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 17. CANCELLATION REQUESTS
CREATE TABLE IF NOT EXISTS cancellation_requests (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    requester_role TEXT NOT NULL CHECK(requester_role IN ('customer', 'vendor', 'admin')),
    requested_by TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL,
    policy_snapshot TEXT NOT NULL,
    calculated_refund_paise INTEGER NOT NULL DEFAULT 0,
    cancellation_fee_paise INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested', 'under_review', 'approved', 'rejected', 'processed')),
    admin_notes TEXT,
    reviewed_by TEXT REFERENCES user_profiles(id) ON DELETE SET NULL,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 18. NOTIFICATIONS & 19. ATTEMPTS
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    recipient_user_id TEXT REFERENCES user_profiles(id) ON DELETE SET NULL,
    recipient_destination TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('whatsapp', 'email', 'sms', 'in_app')),
    template_code TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    provider_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'sending', 'delivered', 'failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notification_attempts (
    id TEXT PRIMARY KEY,
    notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    result TEXT NOT NULL,
    sanitized_error TEXT,
    retry_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 20. WEBHOOK EVENTS
CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'received',
    processed_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, event_id)
);

-- 21. COMMISSION LEDGER
CREATE TABLE IF NOT EXISTS commission_ledger (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
    property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
    vendor_id TEXT NOT NULL REFERENCES vendor_accounts(id) ON DELETE RESTRICT,
    gross_booking_paise INTEGER NOT NULL,
    tax_paise INTEGER NOT NULL,
    commission_basis_points INTEGER NOT NULL,
    commission_amount_paise INTEGER NOT NULL,
    gst_on_commission_paise INTEGER NOT NULL DEFAULT 0,
    net_payable_to_vendor_paise INTEGER NOT NULL,
    payout_status TEXT NOT NULL DEFAULT 'accrued' CHECK(payout_status IN ('accrued', 'pending_approval', 'processing', 'settled', 'clawback')),
    payout_batch_id TEXT,
    payout_reference TEXT,
    settled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 22. SUPPORT CASES
CREATE TABLE IF NOT EXISTS support_cases (
    id TEXT PRIMARY KEY,
    case_reference TEXT NOT NULL UNIQUE,
    booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
    request_id TEXT REFERENCES hotel_booking_requests(id) ON DELETE SET NULL,
    customer_id TEXT REFERENCES user_profiles(id) ON DELETE SET NULL,
    vendor_id TEXT REFERENCES vendor_accounts(id) ON DELETE SET NULL,
    category TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open',
    assigned_support_agent_id TEXT REFERENCES user_profiles(id) ON DELETE SET NULL,
    resolution_summary TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 23. AUDIT LOGS
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_id TEXT REFERENCES user_profiles(id) ON DELETE SET NULL,
    actor_role TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    correlation_id TEXT,
    before_state TEXT,
    after_state TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 24. SYSTEM SETTINGS
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_by TEXT REFERENCES user_profiles(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 25. AUTH SESSIONS & OTP CODES
CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('customer', 'vendor', 'support', 'admin')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_otps (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    otp_code TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    is_used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

module.exports = { DDL_STATEMENTS };
