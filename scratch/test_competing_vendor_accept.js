// ============================================================================
// Test Suite: Competing Tour Operators & Instant Exclusion on Acceptance
// Validates:
// 1. Tour request broadcast to multiple tour operators.
// 2. When Operator A accepts, the request immediately vanishes from Operator B's dashboard.
// 3. If Operator B attempts to accept from a stale/cached card, it returns 'Accepted by other partner'
//    with acceptedByOther: true and the winning operator's name.
// 4. Operator A still retains their accepted request in their dashboard.
// ============================================================================

const path = require('path');
const assert = require('assert');
const { TripMozyDatabase } = require('../src/db/database');
const { RequestService } = require('../src/requests/request-service');
const { MatchingEngine } = require('../src/matching/matching-engine');
const { VendorService } = require('../src/vendor/vendor-service');
const { NotificationService } = require('../src/notifications/notification-service');

const dbPath = path.join(__dirname, '..', 'tripmozy.db');
const db = new TripMozyDatabase(dbPath);
const notifService = new NotificationService(db);
const requestService = new RequestService(db, notifService);
const vendorService = new VendorService(db, notifService);

async function runTest() {
  console.log('🧪 Starting Competing Vendor Acceptance & Auto-Exclusion Test...\n');

  // Find two active verified tour operators
  const vendors = db.query(`
    SELECT v.id, v.business_name, v.contact_email, p.id as property_id
    FROM vendor_accounts v
    JOIN properties p ON v.id = p.vendor_id
    WHERE v.status = 'active'
    GROUP BY v.id
    LIMIT 2
  `);

  assert(vendors.length >= 2, 'Need at least 2 active vendors in the database');
  const [vendorA, vendorB] = vendors;
  console.log(`👤 Operator A: "${vendorA.business_name}" (${vendorA.id})`);
  console.log(`👤 Operator B: "${vendorB.business_name}" (${vendorB.id})`);

  // 1. Customer submits a tour request
  console.log('\n📝 1. Customer creates a tour request for Manali...');
  const checkIn = new Date(Date.now() + 86400000 * 10).toISOString().split('T')[0];
  const checkOut = new Date(Date.now() + 86400000 * 14).toISOString().split('T')[0];

  const reqResult = requestService.submitStayRequest({
    destination: 'Manali, Himachal Pradesh',
    destinationLocality: 'Mall Road & Solang Valley',
    checkInDate: checkIn,
    checkOutDate: checkOut,
    nights: 4,
    numRooms: 1,
    numAdults: 2,
    numChildren: 0,
    roomPreference: 'deluxe',
    totalBudgetINR: 48000, // ₹48,000
    guestName: 'Simulated Competing Test Traveler',
    guestEmail: 'traveler.test@example.com',
    guestPhone: '+919999888877',
    actorContext: null
  });

  const requestId = reqResult.id;
  console.log(`✅ Tour request created: ID ${requestId}, Ref: ${reqResult.reference}`);
  console.log(`   Dispatched to ${reqResult.matchedCount} vendor recipients.`);

  // 2. Fetch incoming requests for both Operator A and Operator B
  console.log('\n🔍 2. Verifying request appears on both operators dashboards...');
  const listA1 = vendorService.getIncomingRequests(vendorA.id, null);
  const listB1 = vendorService.getIncomingRequests(vendorB.id, null);

  const recA = listA1.find(r => r.request_id === requestId);
  const recB = listB1.find(r => r.request_id === requestId);

  assert(recA, `Operator A should receive the request. Found ${listA1.length} requests for A.`);
  assert(recB, `Operator B should receive the request. Found ${listB1.length} requests for B.`);

  console.log(`✅ Operator A has recipient record: ${recA.recipient_id}`);
  console.log(`✅ Operator B has recipient record: ${recB.recipient_id}`);

  // 3. Operator A accepts the tour request
  console.log('\n🤝 3. Operator A accepts the tour request...');
  const acceptResultA = vendorService.acceptRequest({
    recipientId: recA.recipient_id,
    customTotalPaise: 4800000,
    actorContext: null
  });

  assert(acceptResultA.offerReference, 'Operator A should receive an offer reference');
  console.log(`✅ Operator A successfully accepted! Offer Ref: ${acceptResultA.offerReference}`);

  // 4. Check Operator B's dashboard — request MUST HAVE VANISHED!
  console.log('\n👻 4. Checking Operator B incoming queue (Must be vanished)...');
  const listB2 = vendorService.getIncomingRequests(vendorB.id, null);
  const recB_after = listB2.find(r => r.request_id === requestId);

  assert.strictEqual(recB_after, undefined, 'CRITICAL: The request must have vanished from Operator B incoming requests!');
  console.log(`✅ Confirmed: Tour request ${requestId} has completely disappeared from Operator B's queue!`);

  // 5. Operator B attempts to accept the request using their stale/cached recipient ID
  console.log('\n⚡ 5. Simulating Operator B clicking "Accept" on stale cached card...');
  let errorCaught = null;
  try {
    vendorService.acceptRequest({
      recipientId: recB.recipient_id,
      customTotalPaise: 4800000,
      actorContext: null
    });
  } catch (err) {
    errorCaught = err;
  }

  assert(errorCaught, 'Accepting an already-accepted request MUST throw an error');
  console.log(`   Captured error message: "${errorCaught.message}"`);
  console.log(`   acceptedByOther flag: ${errorCaught.acceptedByOther}`);
  console.log(`   acceptedByName: "${errorCaught.acceptedByName}"`);

  assert.strictEqual(errorCaught.acceptedByOther, true, 'Error must have acceptedByOther === true');
  assert(errorCaught.message.toLowerCase().includes('accepted by other partner'), 'Error message must say "Accepted by other partner"');
  assert.strictEqual(errorCaught.acceptedByName, vendorA.business_name, 'Error must identify the winning operator');
  console.log('✅ Confirmed: Operator B receives explicit "Accepted by other partner" rejection with winning partner name!');

  // 6. Operator A still sees their accepted request in their dashboard
  console.log('\n📋 6. Checking Operator A dashboard (Must still see accepted request)...');
  const listA2 = vendorService.getIncomingRequests(vendorA.id, null);
  const recA_accepted = listA2.find(r => r.request_id === requestId);
  assert(recA_accepted, 'Operator A must still see their accepted request');
  assert.strictEqual(recA_accepted.response_status, 'accepted', 'Status must be accepted');
  console.log(`✅ Confirmed: Operator A still sees request in "accepted" status!`);

  // Clean up test data
  console.log('\n🧹 Cleaning up test request...');
  db.execute('DELETE FROM hotel_offers WHERE request_id = ?', [requestId]);
  db.execute('DELETE FROM booking_request_recipients WHERE request_id = ?', [requestId]);
  db.execute('DELETE FROM hotel_booking_requests WHERE id = ?', [requestId]);
  console.log('✅ Cleanup complete.');

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🚀');
}

runTest().catch(err => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
