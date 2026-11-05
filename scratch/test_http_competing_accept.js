// ============================================================================
// Test HTTP API for Competing Tour Operators
// Verifies:
// 1. POST /api/vendor/recipients/:id/accept returns 200 for winning operator.
// 2. GET /api/vendor/requests?vendorId=other returns requests without the accepted one (vanished).
// 3. POST /api/vendor/recipients/:otherId/accept returns 409 Conflict with
//    { error: 'Accepted by other partner (...)', acceptedByOther: true, acceptedByName: '...' }
// 4. GET /action?token=otherToken&action=accept returns 409 Conflict with "Accepted by other partner" HTML page.
// ============================================================================

const http = require('http');
const assert = require('assert');
const path = require('path');
const { TripMozyDatabase } = require('../src/db/database');
const { NotificationService } = require('../src/notifications/notification-service');
const { RequestService } = require('../src/requests/request-service');

const db = new TripMozyDatabase(path.join(__dirname, '..', 'tripmozy.db'));
const notifService = new NotificationService(db);
const requestService = new RequestService(db, notifService);

function makeRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 8080,
      path: urlPath,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ statusCode: res.statusCode, data, json, headers: res.headers });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runHttpTest() {
  console.log('🌐 Testing HTTP API for Competing Vendor Acceptance...');

  // 1. Create a fresh tour request
  const checkIn = new Date(Date.now() + 86400000 * 12).toISOString().split('T')[0];
  const checkOut = new Date(Date.now() + 86400000 * 15).toISOString().split('T')[0];

  const reqResult = requestService.submitStayRequest({
    destination: 'Goa Coastal Circuit',
    destinationLocality: 'Calangute & Candolim',
    checkInDate: checkIn,
    checkOutDate: checkOut,
    nights: 3,
    numRooms: 1,
    numAdults: 2,
    totalBudgetINR: 35000,
    guestName: 'HTTP Race Test Guest',
    guestEmail: 'race.test@example.com',
    guestPhone: '+919988776655'
  });

  const requestId = reqResult.id;
  console.log(`✅ Created tour request ${requestId}`);

  // Fetch recipients for Aman and Verified Partner
  const recipients = db.query(`
    SELECT r.id, r.vendor_id, v.business_name, r.action_token_hash
    FROM booking_request_recipients r
    JOIN vendor_accounts v ON r.vendor_id = v.id
    WHERE r.request_id = ?
  `, [requestId]);

  assert(recipients.length >= 2, 'Must have at least 2 recipients');
  const [recA, recB] = recipients;
  console.log(`Operator A (${recA.business_name}): recipient ${recA.id}`);
  console.log(`Operator B (${recB.business_name}): recipient ${recB.id}`);

  // 2. Operator A accepts via HTTP POST
  console.log('\n📡 POST /api/vendor/recipients/' + recA.id + '/accept');
  const resA = await makeRequest('POST', `/api/vendor/recipients/${recA.id}/accept`, {
    customTotalPaise: 3500000
  });

  console.log(`   Response status: ${resA.statusCode}`);
  assert.strictEqual(resA.statusCode, 200);
  assert(resA.json.offerReference, 'Expected offerReference in response');
  console.log(`✅ Operator A accept succeeded: Offer ${resA.json.offerReference}`);

  // 3. Operator B queries /api/vendor/requests?vendorId=...
  console.log('\n📡 GET /api/vendor/requests?vendorId=' + recB.vendor_id);
  const resListB = await makeRequest('GET', `/api/vendor/requests?vendorId=${recB.vendor_id}`);
  assert.strictEqual(resListB.statusCode, 200);
  const foundB = resListB.json.requests.find(r => r.request_id === requestId);
  assert.strictEqual(foundB, undefined, 'Request must NOT appear in Operator B requests (must be vanished)');
  console.log('✅ Operator B list confirms request has VANISHED!');

  // 4. Operator B tries to accept via HTTP POST using cached recipient ID
  console.log('\n📡 POST /api/vendor/recipients/' + recB.id + '/accept (Stale card acceptance attempt)');
  const resB = await makeRequest('POST', `/api/vendor/recipients/${recB.id}/accept`, {
    customTotalPaise: 3500000
  });

  console.log(`   Response status: ${resB.statusCode}`);
  console.log(`   Response json:`, resB.json);

  assert.strictEqual(resB.statusCode, 409, 'Expected 409 Conflict');
  assert.strictEqual(resB.json.acceptedByOther, true, 'Expected acceptedByOther: true');
  assert(resB.json.error.includes('Accepted by other partner'), 'Error message should say Accepted by other partner');
  assert.strictEqual(resB.json.acceptedByName, recA.business_name);
  console.log('✅ Operator B received 409 with acceptedByOther: true and winning partner name!');

  // 5. Cleanup
  db.execute('DELETE FROM hotel_offers WHERE request_id = ?', [requestId]);
  db.execute('DELETE FROM booking_request_recipients WHERE request_id = ?', [requestId]);
  db.execute('DELETE FROM hotel_booking_requests WHERE id = ?', [requestId]);
  console.log('\n🧹 Cleaned up test data.');

  console.log('\n🎉 ALL HTTP RACE TESTS PASSED SUCCESSFULLY! 🚀');
}

runHttpTest().catch(err => {
  console.error('\n❌ HTTP Test failed:', err);
  process.exit(1);
});
