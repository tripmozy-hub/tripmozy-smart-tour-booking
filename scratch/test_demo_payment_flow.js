// ============================================================================
// Verification Test: Paused Payment Gateway & Demo Sandbox Flow
// ============================================================================

const assert = require('node:assert');
const http = require('node:http');

const BASE_URL = 'http://localhost:8080';

function request(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, data: parsed, raw: data });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function run() {
  console.log('🧪 Testing Paused Payment Gateway & Demo Sandbox Flow (http://localhost:8080)...\n');

  // Step 1: Verify /api/payment/config returns isPaused: true & mode: 'demo'
  console.log('1. Checking /api/payment/config endpoint...');
  const cfgRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/payment/config',
    method: 'GET'
  });
  assert.strictEqual(cfgRes.status, 200);
  assert.strictEqual(cfgRes.data.isPaused, true, 'Live gateway must be paused');
  assert.strictEqual(cfgRes.data.mode, 'demo', 'Mode must be demo');
  assert.strictEqual(cfgRes.data.provider, 'demo', 'Provider must be demo');
  assert.strictEqual(cfgRes.data.liveKeyId, 'rzp_live_RYrXNuT77Ns4gT', 'Live key ID must be retained');
  console.log(`   ✓ Config verified: isPaused=${cfgRes.data.isPaused}, mode=${cfgRes.data.mode}, provider=${cfgRes.data.provider}`);
  console.log(`   ✓ Live key preserved safely: ${cfgRes.data.liveKeyId}\n`);

  // Step 2: Create a Tour Request
  console.log('2. Creating Tour Request via POST /api/requests...');
  const reqPayload = {
    guestName: 'Kunal Singhania',
    guestEmail: 'kunal.singhania@example.com',
    guestPhone: '+919876501234',
    destination: 'Rajasthan',
    checkInDate: '2026-12-25',
    checkOutDate: '2026-12-30',
    numRooms: 1,
    numAdults: 2,
    numChildren: 0,
    totalBudgetINR: 45000,
    communicationConsent: true,
    termsAccepted: true
  };
  const submitRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/requests',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, reqPayload);

  assert.strictEqual(submitRes.status, 201);
  const requestId = submitRes.data.id;
  const requestRef = submitRes.data.reference;
  console.log(`   ✓ Request created: ${requestRef} (ID: ${requestId})\n`);

  // Step 3: Fetch request details as Admin
  console.log('3. Fetching request details to identify matched operator...');
  const detailsRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: `/api/requests/${requestId}?admin=1`,
    method: 'GET'
  });
  assert.strictEqual(detailsRes.status, 200);
  assert.ok(detailsRes.data.recipients && detailsRes.data.recipients.length > 0);
  const recipient = detailsRes.data.recipients[0];
  console.log(`   ✓ Matched operator: ${recipient.property_name || recipient.name} (Recipient ID: ${recipient.id})\n`);

  // Step 4: Operator accepts request and dispatches quote
  console.log('4. Operator sends quote via POST /api/vendor/recipients/:id/accept...');
  const quotePayload = {
    customTotalPaise: 4000000, // ₹40,000 total package
    roomTypeId: recipient.room_type_id || null,
    mealPlan: 'Royal Heritage Haveli & Desert Safari with Dinner',
    cancellationTerms: 'Free cancellation up to 48 hours before check-in'
  };
  const quoteRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: `/api/vendor/recipients/${recipient.id}/accept`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, quotePayload);

  assert.strictEqual(quoteRes.status, 200);
  assert.strictEqual(quoteRes.data.success, true);
  const offerId = quoteRes.data.offerId;
  console.log(`   ✓ Quote submitted! Offer ID: ${offerId}, Advance: ₹${quoteRes.data.advancePaidINR}\n`);

  // Step 5: Customer locks 15-minute inventory hold
  console.log('5. Customer locks 15-minute hold via POST /api/offers/:id/hold...');
  const holdRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: `/api/offers/${offerId}/hold`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { customerId: detailsRes.data.request.customer_id });

  assert.strictEqual(holdRes.status, 200);
  assert.strictEqual(holdRes.data.success, true);
  const holdId = holdRes.data.holdId;
  console.log(`   ✓ Hold locked: ${holdId}\n`);

  // Step 6: Process Demo Sandbox Payment
  console.log('6. Processing Demo Sandbox Payment via POST /api/bookings/confirm...');
  const demoPaymentId = `pay_demo_${Date.now()}_testxyz`;
  const confirmPayload = {
    holdId,
    customerId: detailsRes.data.request.customer_id,
    paymentReference: demoPaymentId,
    remainingPaymentOption: 'hotel_arrival'
  };
  const confirmRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/bookings/confirm',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, confirmPayload);

  assert.strictEqual(confirmRes.status, 200);
  assert.strictEqual(confirmRes.data.success, true);
  const bookingRef = confirmRes.data.bookingReference;
  console.log(`   ✓ Demo Booking Confirmed! Reference: ${bookingRef}`);
  console.log(`   ✓ Demo Payment Reference: ${confirmRes.data.paymentReference}`);
  console.log(`   ✓ Advance Paid to TripMozy: ₹${confirmRes.data.advancePaidINR}\n`);

  // Step 7: Verify updated request details & unmasked vendor contact
  console.log('7. Verifying traveler view & unmasked operator contact via GET /api/requests/:id...');
  const updatedReqRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: `/api/requests/${requestId}`,
    method: 'GET'
  });
  assert.strictEqual(updatedReqRes.status, 200);
  assert.strictEqual(updatedReqRes.data.request.status, 'booked');
  assert.ok(updatedReqRes.data.booking);
  assert.ok(updatedReqRes.data.booking.vendor.contactPhone, 'Vendor phone unmasked');
  console.log(`   ✓ Status is 'booked'`);
  console.log(`   ✓ Unmasked Partner: ${updatedReqRes.data.booking.vendor.businessName} (Phone: ${updatedReqRes.data.booking.vendor.contactPhone})\n`);

  // Step 8: Test Pause/Unpause Toggle Endpoint
  console.log('8. Testing /api/payment/toggle-pause endpoint...');
  const unpauseRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/payment/toggle-pause',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { pause: false });
  assert.strictEqual(unpauseRes.status, 200);
  assert.strictEqual(unpauseRes.data.isPaused, false);
  assert.strictEqual(unpauseRes.data.mode, 'live');
  assert.strictEqual(unpauseRes.data.keyId, 'rzp_live_RYrXNuT77Ns4gT');
  console.log('   ✓ Successfully toggled to Live Razorpay mode');

  // Toggle back to Demo mode (as requested by user)
  const repauseRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/payment/toggle-pause',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { pause: true });
  assert.strictEqual(repauseRes.status, 200);
  assert.strictEqual(repauseRes.data.isPaused, true);
  assert.strictEqual(repauseRes.data.mode, 'demo');
  console.log('   ✓ Successfully toggled back to Demo Sandbox mode\n');

  console.log('========================================================================');
  console.log('🎉 PAUSED PAYMENT GATEWAY & DEMO SANDBOX FLOW FULLY VERIFIED & WORKING!');
  console.log('========================================================================');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
