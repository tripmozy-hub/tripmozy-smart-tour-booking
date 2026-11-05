// ============================================================================
// Comprehensive Test: Admin Master Portal & Razorpay Live Gateway Integration
// ============================================================================

const assert = require('node:assert');
const { TripMozyDatabase } = require('../src/db/database');
const { RequestService } = require('../src/requests/request-service');
const { VendorService } = require('../src/vendor/vendor-service');
const { InventoryHoldEngine } = require('../src/booking/inventory-hold-engine');
const { BookingService } = require('../src/booking/booking-service');
const { PaymentGatewayAdapter } = require('../src/payments/payment-gateway-adapter');
const { NotificationService } = require('../src/notifications/notification-service');

async function runTests() {
  console.log('🚀 Running Admin Master Portal & Razorpay Live Gateway Verification Suite...\n');

  // Initialize DB in test environment
  const db = new TripMozyDatabase(':memory:');
  const notifService = new NotificationService(db);
  const reqService = new RequestService(db, notifService);
  const vendorService = new VendorService(db, notifService);
  const holdEngine = new InventoryHoldEngine(db);
  const bookingService = new BookingService(db);
  const paymentAdapter = new PaymentGatewayAdapter(db, {
    provider: 'razorpay',
    keyId: 'rzp_live_RYrXNuT77Ns4gT'
  });

  // 1. Verify Payment Gateway Adapter Config
  console.log('1. Verifying Razorpay Live Gateway Adapter Config...');
  assert.strictEqual(paymentAdapter.config.keyId, 'rzp_live_RYrXNuT77Ns4gT');
  assert.strictEqual(paymentAdapter.config.provider, 'razorpay');
  console.log('   ✓ Razorpay Key ID verified: rzp_live_RYrXNuT77Ns4gT\n');

  // 2. Set up a Vendor and Property
  console.log('2. Setting up verified Tour Operator...');
  const userId = db.uuid();
  db.execute(`
    INSERT INTO user_profiles (id, email, phone, role, display_name, status)
    VALUES (?, 'operator1@goa-expeditions.com', '+919876543210', 'vendor', 'Goa Royal Expeditions', 'active')
  `, [userId]);

  const vendorId = db.uuid();
  db.execute(`
    INSERT INTO vendor_accounts (
      id, user_id, business_name, contact_person, contact_phone, contact_email,
      status, commission_rate_basis_points
    ) VALUES (?, ?, 'Goa Royal Expeditions',
             'Vikram Malhotra', '+919876543210', 'vikram@goa-expeditions.com', 'active', 1000)
  `, [vendorId, userId]);

  const propId = db.uuid();
  db.execute(`
    INSERT INTO properties (
      id, vendor_id, name, slug, property_type, star_rating, city, state, country,
      address_line, pincode, latitude, longitude, status
    ) VALUES (?, ?, 'Goa Royal Expeditions Fleet Base', 'goa-royal-fleet', 'resort', 5, 'Goa', 'Goa', 'India',
             'Calangute Beach Road', '403516', 15.543, 73.755, 'active')
  `, [propId, vendorId]);

  const roomTypeId = db.uuid();
  db.execute(`
    INSERT INTO room_types (
      id, property_id, name, bed_type, max_adults, max_children, total_inventory
    ) VALUES (?, ?, 'Luxury AC Coach & Beachfront Stay', 'King', 2, 2, 5)
  `, [roomTypeId, propId]);

  // 3. Customer submits a Tour Request
  console.log('3. Customer submits tour request...');
  const submitRes = reqService.submitStayRequest({
    guestName: 'Ananya Sharma',
    guestEmail: 'ananya.traveler@gmail.com',
    guestPhone: '+919811223344',
    destination: 'Goa',
    checkInDate: '2026-12-10',
    checkOutDate: '2026-12-15',
    numRooms: 1,
    numAdults: 2,
    numChildren: 0,
    totalBudgetINR: 50000,
    communicationConsent: true,
    termsAccepted: true
  });

  const requestId = submitRes.id;
  console.log(`   ✓ Request created: ${submitRes.reference} (ID: ${requestId})\n`);

  // 4. Query Request as Regular Traveler vs Admin (Pre-Acceptance)
  console.log('4. Testing Pre-Acceptance Privacy & Admin Unmasking...');
  const travelerPre = reqService.getRequestDetails(requestId, false);
  const adminPre = reqService.getRequestDetails(requestId, true);

  assert.strictEqual(travelerPre.isAdmin, false);
  assert.strictEqual(adminPre.isAdmin, true);

  // In pre-acceptance, recipients should have phone/email hidden for traveler
  assert.strictEqual(travelerPre.recipients[0].vendor_contact_phone, null);
  assert.strictEqual(travelerPre.recipients[0].vendor_contact_email, null);

  // For Admin, recipient contact phone and email are accessible
  assert.strictEqual(adminPre.recipients[0].vendor_contact_phone, '+919876543210');
  assert.strictEqual(adminPre.recipients[0].vendor_contact_email, 'vikram@goa-expeditions.com');
  console.log('   ✓ Pre-acceptance privacy enforced: Traveler blinded, Admin unmasked.\n');

  // 5. Operator Accepts Request and Dispatches Quote
  console.log('5. Operator accepts request...');
  const recipient = db.queryOne('SELECT * FROM booking_request_recipients WHERE request_id = ?', [requestId]);
  let room = db.queryOne(`
    SELECT rt.* FROM room_types rt
    JOIN room_rates rr ON rt.id = rr.room_type_id
    WHERE rt.property_id = ?
  `, [recipient.property_id]);

  if (!room) {
    const defaultRoomId = db.uuid();
    db.execute(`
      INSERT INTO room_types (id, property_id, name, bed_type, max_adults, max_children, total_inventory)
      VALUES (?, ?, 'Premium Beachfront Villa', 'King', 2, 2, 5)
    `, [defaultRoomId, recipient.property_id]);
    db.execute(`
      INSERT INTO room_rates (id, room_type_id, rate_plan_name, base_nightly_rate_paise, tax_rate_basis_points)
      VALUES (?, ?, 'Standard Package', 1000000, 1200)
    `, [db.uuid(), defaultRoomId]);
    room = { id: defaultRoomId };
  }

  const acceptRes = vendorService.acceptRequest({
    actionToken: recipient.action_token_hash,
    recipientId: recipient.id,
    customTotalPaise: 4200000, // ₹42,000 total package
    roomTypeId: room.id,
    mealPlan: 'Daily Sightseeing, Dedicated AC Sedan & All Buffet Meals',
    cancellationTerms: 'Free cancellation up to 48 hours prior to departure'
  });
  assert.strictEqual(acceptRes.success, true);
  console.log(`   ✓ Request accepted: Offer ID ${acceptRes.offerId}, Advance: ₹${acceptRes.advancePaidINR}\n`);

  // 6. Check Admin vs Traveler Quote View (Post-Acceptance, Pre-Payment)
  console.log('6. Verifying Post-Acceptance Privacy & Admin Master View...');
  const travelerPostAccept = reqService.getRequestDetails(requestId, false);
  const adminPostAccept = reqService.getRequestDetails(requestId, true);

  // Traveler sees offer, BUT vendor contact phone & email MUST be null
  assert.strictEqual(travelerPostAccept.offers.length, 1);
  assert.strictEqual(travelerPostAccept.offers[0].vendor.contactPhone, null);
  assert.strictEqual(travelerPostAccept.offers[0].vendor.contactEmail, null);
  assert.strictEqual(travelerPostAccept.offers[0].vendor.contactPerson, 'Verified Tour Partner');
  console.log('   ✓ Traveler View: Vendor contact phone & email are strictly NULL before payment.');

  // Admin sees full traveler details AND full vendor contact details
  assert.strictEqual(adminPostAccept.offers.length, 1);
  assert.strictEqual(adminPostAccept.offers[0].vendor.contactPhone, '+919876543210');
  assert.strictEqual(adminPostAccept.offers[0].vendor.contactEmail, 'vikram@goa-expeditions.com');
  assert.strictEqual(adminPostAccept.offers[0].vendor.contactPerson, 'Vikram Malhotra');
  assert.strictEqual(adminPostAccept.offers[0].vendor.businessName, 'Goa Royal Expeditions');

  // Check financial breakdown in offer
  const tp = adminPostAccept.offers[0].tourPricing;
  assert.strictEqual(tp.totalTourINR, 42000);
  assert.strictEqual(tp.advanceBaseINR, 12600); // 30% of 42000
  assert.strictEqual(tp.advanceGstINR, 630);    // 5% of 12600
  assert.strictEqual(tp.payableNowINR, 13230);  // 12600 + 630
  assert.strictEqual(tp.remainingBalanceINR, 29400); // 70% of 42000
  console.log(`   ✓ Admin View: Vendor contact unmasked (${adminPostAccept.offers[0].vendor.contactPerson}, ${adminPostAccept.offers[0].vendor.contactPhone})`);
  console.log(`   ✓ Financial Breakdown Verified: Total ₹${tp.totalTourINR}, Advance ₹${tp.payableNowINR}, Balance ₹${tp.remainingBalanceINR}\n`);

  // 7. Check Admin Notification Record Link
  console.log('7. Verifying Admin Email Notification Link...');
  const adminNotif = db.queryOne("SELECT * FROM notifications WHERE template_code = 'admin_request_accepted' ORDER BY created_at DESC LIMIT 1");
  assert.ok(adminNotif, 'Admin notification should exist');
  const notifPayload = JSON.parse(adminNotif.payload_json);
  assert.ok(notifPayload.paymentUrl.includes('&admin=1') || notifPayload.adminPaymentUrl.includes('&admin=1'), 'Admin link must include &admin=1');
  console.log(`   ✓ Admin email contains dedicated portal link: ${notifPayload.adminPaymentUrl || notifPayload.paymentUrl}\n`);

  // 8. Create Hold and Simulate Razorpay Live Payment
  console.log('8. Simulating Razorpay Live Payment (rzp_live_RYrXNuT77Ns4gT)...');
  const holdRes = holdEngine.createHold({
    offerId: acceptRes.offerId,
    customerId: travelerPostAccept.request.customer_id
  });
  assert.strictEqual(holdRes.success, true);

  const razorpayPaymentId = `pay_rzp_live_${Date.now()}`;
  const confirmRes = bookingService.confirmBooking({
    holdId: holdRes.holdId,
    customerId: travelerPostAccept.request.customer_id,
    paymentReference: razorpayPaymentId,
    remainingPaymentOption: 'hotel_arrival'
  });
  assert.strictEqual(confirmRes.success, true);
  console.log(`   ✓ Booking confirmed with Razorpay payment ID: ${razorpayPaymentId}`);
  console.log(`   ✓ Booking Reference: ${confirmRes.bookingReference}\n`);

  // 9. Post-Payment: Vendor Contact is Released in Official Bill to Traveler
  console.log('9. Verifying Post-Payment Contact Release in Bill...');
  const travelerPostPay = reqService.getRequestDetails(requestId, false);
  const adminPostPay = reqService.getRequestDetails(requestId, true);

  assert.strictEqual(travelerPostPay.request.status, 'booked');
  assert.ok(travelerPostPay.booking, 'Booking record exists');
  assert.strictEqual(travelerPostPay.booking.vendor.contactPhone, '+919876543210');
  assert.strictEqual(travelerPostPay.booking.vendor.contactEmail, 'vikram@goa-expeditions.com');
  assert.strictEqual(travelerPostPay.booking.vendor.contactPerson, 'Vikram Malhotra');

  assert.strictEqual(adminPostPay.request.status, 'booked');
  assert.strictEqual(adminPostPay.booking.vendor.contactPhone, '+919876543210');
  assert.strictEqual(adminPostPay.booking.vendor.contactEmail, 'vikram@goa-expeditions.com');
  assert.strictEqual(adminPostPay.booking.guest.phone, '+919811223344');
  assert.strictEqual(adminPostPay.booking.guest.email, 'ananya.traveler@gmail.com');
  console.log('   ✓ Post-payment: Vendor phone/email released in official bill voucher for traveler.');
  console.log('   ✓ Admin View: Complete dual-party contact & payment reference verified.\n');

  console.log('================================================================');
  console.log('🎉 ALL ADMIN MASTER PORTAL & RAZORPAY INTEGRATION TESTS PASSED!');
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
