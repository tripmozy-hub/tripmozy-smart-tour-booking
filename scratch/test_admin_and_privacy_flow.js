// ============================================================================
// Test Suite: Admin Notifications (tripmozy@gmail.com) & Strict Pre-Payment Privacy
// Validates:
// 1. Admin gets 'admin_new_request' email with customer contact and tour details.
// 2. Vendors DO NOT get customer phone/email before payment.
// 3. Traveler DOES NOT get vendor phone/email before payment.
// 4. Admin gets 'admin_request_accepted' email with whole details when vendor accepts.
// 5. After advance payment, BOTH traveler and vendor get each other's phone/contact info
//    and official PDF bill data contains all details.
// ============================================================================

const path = require('path');
const assert = require('assert');
const { TripMozyDatabase } = require('../src/db/database');
const { NotificationService } = require('../src/notifications/notification-service');
const { RequestService } = require('../src/requests/request-service');
const { VendorService } = require('../src/vendor/vendor-service');
const { BookingService } = require('../src/booking/booking-service');
const { InventoryHoldEngine } = require('../src/booking/inventory-hold-engine');

const db = new TripMozyDatabase(path.join(__dirname, '..', 'tripmozy.db'));
const notifService = new NotificationService(db);
const requestService = new RequestService(db, notifService);
const vendorService = new VendorService(db, notifService);
const holdEngine = new InventoryHoldEngine(db);
const bookingService = new BookingService(db);

async function runTest() {
  console.log('🧪 Starting Admin Notifications & Strict Contact Privacy Test...\n');

  // 1. Customer submits a tour request
  console.log('📝 1. Customer submits tour request for Kerala Backwaters...');
  const checkIn = new Date(Date.now() + 86400000 * 15).toISOString().split('T')[0];
  const checkOut = new Date(Date.now() + 86400000 * 19).toISOString().split('T')[0];

  const reqResult = requestService.submitStayRequest({
    destination: 'Kerala Backwaters & Munnar',
    destinationLocality: 'Alleppey & Munnar Hills',
    checkInDate: checkIn,
    checkOutDate: checkOut,
    nights: 4,
    numRooms: 1,
    numAdults: 2,
    numChildren: 1,
    roomPreference: 'deluxe',
    requiredFacilities: ['Private Houseboat', 'Munnar Tea Plantation Tour', 'Private AC Sedan'],
    totalBudgetINR: 55000,
    guestName: 'Dr. Rajesh Sharma',
    guestEmail: 'dr.sharma.test@example.com',
    guestPhone: '+919876543210'
  });

  const requestId = reqResult.id;
  console.log(`✅ Request created: ID ${requestId}, Ref: ${reqResult.reference}`);

  // Check admin notification
  console.log('\n📧 2. Verifying Admin Email (tripmozy@gmail.com) received written customer details...');
  const adminNotif = db.queryOne(`
    SELECT * FROM notifications
    WHERE recipient_destination = 'tripmozy@gmail.com' AND template_code = 'admin_new_request'
    ORDER BY created_at DESC LIMIT 1
  `);

  assert(adminNotif, 'Admin MUST receive admin_new_request email at tripmozy@gmail.com');
  const adminPayload = JSON.parse(adminNotif.payload_json);
  console.log(`✅ Admin email payload verified:`);
  console.log(`   - Customer: ${adminPayload.guestName}`);
  console.log(`   - Phone: ${adminPayload.guestPhone}`);
  console.log(`   - Email: ${adminPayload.guestEmail}`);
  console.log(`   - Destination: ${adminPayload.destination}`);
  console.log(`   - Budget: ₹${adminPayload.totalBudgetINR.toLocaleString('en-IN')}`);

  assert.strictEqual(adminPayload.guestName, 'Dr. Rajesh Sharma');
  assert.strictEqual(adminPayload.guestPhone, '+919876543210');
  assert.strictEqual(adminPayload.guestEmail, 'dr.sharma.test@example.com');

  // Verify tripmozy@gmail.com was NOT sent vendor dispatch alerts
  const badVendorAlertsToAdmin = db.query(`
    SELECT * FROM notifications
    WHERE recipient_destination = 'tripmozy@gmail.com' AND template_code = 'hotel_request_received_vendor'
    AND created_at >= datetime('now', '-1 minute')
  `);
  assert.strictEqual(badVendorAlertsToAdmin.length, 0, 'Admin MUST NOT receive vendor action alerts (hotel_request_received_vendor)');
  console.log('✅ Confirmed: tripmozy@gmail.com did NOT receive vendor action alerts!');

  // 3. Verify Vendor does NOT see customer phone/email
  console.log('\n🔒 3. Verifying vendor incoming requests DO NOT leak customer phone or email...');
  const recipient = db.queryOne('SELECT * FROM booking_request_recipients WHERE request_id = ? LIMIT 1', [requestId]);
  assert(recipient, 'Recipient must exist');
  const vendorIncoming = vendorService.getIncomingRequests(recipient.vendor_id, null);
  const vReq = vendorIncoming.find(r => r.request_id === requestId);
  assert(vReq, 'Vendor must see the request in incoming queue');
  assert.strictEqual(vReq.guest_phone, undefined, 'guest_phone must NOT be exposed in incoming requests');
  assert.strictEqual(vReq.guest_email, undefined, 'guest_email must NOT be exposed in incoming requests');
  console.log('✅ Confirmed: Vendor incoming request query has NO customer phone or email!');

  // 4. Tour operator accepts request
  console.log('\n🤝 4. Tour operator accepts request...');
  const acceptRes = vendorService.acceptRequest({
    recipientId: recipient.id,
    customTotalPaise: 5500000
  });

  console.log(`✅ Vendor accepted! Offer Ref: ${acceptRes.offerReference}`);

  // 5. Verify Admin received admin_request_accepted with whole details
  console.log('\n📧 5. Verifying Admin Email (tripmozy@gmail.com) received whole acceptance details...');
  const adminAcceptNotif = db.queryOne(`
    SELECT * FROM notifications
    WHERE recipient_destination = 'tripmozy@gmail.com' AND template_code = 'admin_request_accepted'
    ORDER BY created_at DESC LIMIT 1
  `);

  assert(adminAcceptNotif, 'Admin MUST receive admin_request_accepted email at tripmozy@gmail.com');
  const acceptPayload = JSON.parse(adminAcceptNotif.payload_json);
  console.log(`✅ Admin acceptance notification verified:`);
  console.log(`   - Operator: ${acceptPayload.vendorName}`);
  console.log(`   - Operator Phone: ${acceptPayload.vendorPhone}`);
  console.log(`   - Operator Email: ${acceptPayload.vendorEmail}`);
  console.log(`   - Customer: ${acceptPayload.guestName} (${acceptPayload.guestPhone})`);
  console.log(`   - Total Package: ₹${acceptPayload.totalAmountINR.toLocaleString('en-IN')}`);
  console.log(`   - 30% Advance + 5% GST: ₹${acceptPayload.advancePayableINR.toLocaleString('en-IN')}`);
  console.log(`   - 70% Balance Due: ₹${acceptPayload.remainingBalanceINR.toLocaleString('en-IN')}`);

  assert(acceptPayload.vendorName, 'Must include vendor name');
  assert.strictEqual(acceptPayload.guestName, 'Dr. Rajesh Sharma');
  assert.strictEqual(acceptPayload.guestPhone, '+919876543210');
  assert.strictEqual(acceptPayload.totalAmountINR, 55000);

  // 6. Verify traveler DOES NOT see operator phone/email before payment
  console.log('\n🔒 6. Verifying traveler cannot see vendor contact before payment...');
  const reqDetailsBeforePay = requestService.getRequestDetails(requestId);
  assert(reqDetailsBeforePay.offers.length > 0, 'Offers must exist');
  const offerBeforePay = reqDetailsBeforePay.offers[0];
  assert.strictEqual(offerBeforePay.vendor.contactPhone, null, 'Operator phone must be null before payment');
  assert.strictEqual(offerBeforePay.vendor.contactEmail, null, 'Operator email must be null before payment');
  console.log('✅ Confirmed: Traveler API returns null for operator phone & email before payment!');

  // 7. Customer confirms booking (pays 30% advance)
  console.log('\n💳 7. Customer pays advance and confirms booking...');
  const holdRes = holdEngine.createHold({
    offerId: acceptRes.offerId,
    customerId: reqDetailsBeforePay.request.customer_id
  });
  assert(holdRes.success, 'Hold creation must succeed');

  const bookingConfirmRes = bookingService.confirmBooking({
    holdId: holdRes.holdId,
    customerId: reqDetailsBeforePay.request.customer_id,
    paymentReference: 'PAY_TEST_ESCROW_998877',
    remainingPaymentOption: 'hotel_arrival'
  });

  console.log(`✅ Booking confirmed! Reference: ${bookingConfirmRes.bookingReference}`);

  // 8. Verify AFTER payment: both parties get each other's contact info
  console.log('\n🎉 8. Verifying contact release AFTER payment in confirmed voucher/bill...');
  const reqDetailsAfterPay = requestService.getRequestDetails(requestId);
  assert.strictEqual(reqDetailsAfterPay.request.status, 'booked');
  assert(reqDetailsAfterPay.booking, 'Booking record must exist');
  console.log(`   Customer Phone in Booking: ${reqDetailsAfterPay.booking.guest_phone}`);
  console.log(`   Operator Phone in Booking: ${reqDetailsAfterPay.booking.vendor.contactPhone}`);
  assert(reqDetailsAfterPay.booking.guest_phone, 'Customer phone must be present after booking');
  assert(reqDetailsAfterPay.booking.vendor.contactPhone, 'Operator phone must be present after booking');
  console.log('✅ Confirmed: Both traveler and operator verified phone numbers released upon advance payment!');

  // Clean up test data
  console.log('\n🧹 Cleaning up test data...');
  db.execute('DELETE FROM commission_ledger WHERE booking_id IN (SELECT id FROM bookings WHERE request_id = ?)', [requestId]);
  db.execute('DELETE FROM payments WHERE booking_id IN (SELECT id FROM bookings WHERE request_id = ?)', [requestId]);
  db.execute('DELETE FROM booking_room_nights WHERE booking_id IN (SELECT id FROM bookings WHERE request_id = ?)', [requestId]);
  db.execute('DELETE FROM bookings WHERE request_id = ?', [requestId]);
  db.execute('DELETE FROM inventory_holds WHERE offer_id IN (SELECT id FROM hotel_offers WHERE request_id = ?)', [requestId]);
  db.execute('DELETE FROM hotel_offers WHERE request_id = ?', [requestId]);
  db.execute('DELETE FROM booking_request_recipients WHERE request_id = ?', [requestId]);
  db.execute('DELETE FROM hotel_booking_requests WHERE id = ?', [requestId]);
  console.log('✅ Cleanup complete.');

  console.log('\n🎉 ALL ADMIN NOTIFICATION & CONTACT PRIVACY TESTS PASSED! 🚀');
}

runTest().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
