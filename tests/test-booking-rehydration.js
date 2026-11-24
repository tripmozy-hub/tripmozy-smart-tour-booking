const { TripMozyDatabase } = require('../src/db/database');
const { BookingService } = require('../src/booking/booking-service');
const { RequestService } = require('../src/requests/request-service');
const { VendorService } = require('../src/vendor/vendor-service');
const { InventoryHoldEngine } = require('../src/booking/inventory-hold-engine');
const assert = require('assert');

// 1. Instance A: Create request, accept offer, hold inventory, confirm booking
const dbA = new TripMozyDatabase(':memory:');
const reqServiceA = new RequestService(dbA);
const vendorServiceA = new VendorService(dbA);
const holdEngineA = new InventoryHoldEngine(dbA);
const bookingServiceA = new BookingService(dbA);

const reqRes = reqServiceA.submitStayRequest({
  guestName: 'Arjun Verma',
  guestEmail: 'arjun.verma@example.com',
  guestPhone: '+919876543210',
  destination: 'Manali, Himachal Pradesh',
  checkInDate: '2026-12-10',
  checkOutDate: '2026-12-14',
  numRooms: 1,
  numAdults: 2,
  totalBudgetINR: 40000,
  termsAccepted: true
});
console.log('Instance A - Request created:', reqRes.reference);

// Vendor accepts
const anyVendorA = dbA.queryOne("SELECT id FROM vendor_accounts WHERE status = 'active' LIMIT 1");
const recipientsA = vendorServiceA.getIncomingRequests(anyVendorA.id);
const firstRec = recipientsA[0];
const acceptRes = vendorServiceA.acceptRequest({
  recipientId: firstRec.recipient_id,
  customTotalPaise: 4000000
});
console.log('Instance A - Offer accepted:', acceptRes.offer?.offer_reference || 'OK');

// Create hold
const offersA = dbA.query('SELECT * FROM hotel_offers WHERE request_id = ?', [reqRes.id]);
const offerId = offersA[0].id;
const holdRes = holdEngineA.createHold({
  offerId: offerId,
  holdMinutes: 15
});
console.log('Instance A - Hold created:', holdRes.holdId);

// Confirm booking
const confirmRes = bookingServiceA.confirmBooking({
  holdId: holdRes.holdId,
  paymentReference: 'pay_demo_test123',
  holdSnapshot: holdRes.holdSnapshot
});
console.log('Instance A - Booking confirmed:', confirmRes.bookingReference, 'bookingToken length:', confirmRes.bookingToken?.length);
assert(confirmRes.bookingToken, 'bookingToken must be generated');

// 2. Instance B (Cold Start): In-memory fresh database!
console.log('--- Simulating Cold Instance B ---');
const dbB = new TripMozyDatabase(':memory:');
const reqServiceB = new RequestService(dbB);
const vendorServiceB = new VendorService(dbB);
const bookingServiceB = new BookingService(dbB);

// Attempt lookup without token -> should be null
const directLookupFail = reqServiceB.getRequestDetails(confirmRes.bookingReference);
assert.strictEqual(directLookupFail, null, 'Instance B must have empty database before rehydration');

// Rehydrate using bookingToken
const rehydrated = reqServiceB.rehydrateRequestFromToken(confirmRes.bookingToken, confirmRes.bookingReference);
console.log('Instance B - Rehydration from bookingToken result:', rehydrated);
assert(rehydrated, 'rehydration must succeed on cold instance');

// Query by Booking Reference
const bkgDetails = reqServiceB.getRequestDetails(confirmRes.bookingReference);
assert(bkgDetails, 'Details must exist after rehydration');
assert.strictEqual(bkgDetails.request.status, 'booked', 'Status must be booked');
assert(bkgDetails.booking, 'Booking record must exist');
assert.strictEqual(bkgDetails.booking.booking_reference, confirmRes.bookingReference);
assert.strictEqual(bkgDetails.booking.guest_name, 'Arjun Verma');
console.log('Instance B - Booking Details verified! Guest:', bkgDetails.booking.guest_name, 'Status:', bkgDetails.request.status);

// Query by Request Reference
const reqDetails = reqServiceB.getRequestDetails(reqRes.reference);
assert(reqDetails, 'Details must exist via request reference too');
assert.strictEqual(reqDetails.request.status, 'booked');
console.log('Instance B - Request Reference lookup verified!');

// Check Tour Operator Dashboard on Instance B (Unmasked Traveler Contact)
const vendorIdB = bkgDetails.booking.vendor_id || dbB.queryOne("SELECT id FROM vendor_accounts LIMIT 1").id;
const vendorRequestsB = vendorServiceB.getIncomingRequests(vendorIdB);
const bookedVendorRow = vendorRequestsB.find(r => r.request_id === reqRes.id);
assert(bookedVendorRow, 'Vendor must see booked request');
assert.strictEqual(bookedVendorRow.guest_name, 'Arjun Verma');
assert.strictEqual(bookedVendorRow.guest_phone, '+919876543210');
assert.strictEqual(bookedVendorRow.guest_email, 'arjun.verma@example.com');
console.log('Instance B - Vendor Dashboard traveler contact unmasked successfully! Name:', bookedVendorRow.guest_name, 'Phone:', bookedVendorRow.guest_phone);

console.log('ALL TESTS PASSED WITH 100% SUCCESS!');
