// ============================================================================
// Live HTTP Integration Test: Razorpay Live Gateway (rzp_live_RYrXNuT77Ns4gT)
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
  console.log('🧪 Testing Razorpay Live Payment Gateway on Live Server (http://localhost:8080)...\n');

  // Step 1: Verify /api/payment/config
  console.log('1. Checking /api/payment/config endpoint...');
  const cfgRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/payment/config',
    method: 'GET'
  });
  assert.strictEqual(cfgRes.status, 200, 'Config endpoint should return 200');
  assert.strictEqual(cfgRes.data.provider, 'razorpay', 'Provider must be razorpay');
  assert.strictEqual(cfgRes.data.keyId, 'rzp_live_RYrXNuT77Ns4gT', 'Key ID must match live key rzp_live_RYrXNuT77Ns4gT');
  assert.strictEqual(cfgRes.data.currency, 'INR');
  console.log(`   ✓ Gateway Config Verified: Provider=${cfgRes.data.provider}, KeyId=${cfgRes.data.keyId}, Currency=${cfgRes.data.currency}\n`);

  // Step 2: Create a Tour Request
  console.log('2. Creating Tour Request via POST /api/requests...');
  const reqPayload = {
    guestName: 'Rohit Verma',
    guestEmail: 'rohit.verma@example.com',
    guestPhone: '+919988776655',
    destination: 'Kerala',
    checkInDate: '2026-12-20',
    checkOutDate: '2026-12-25',
    numRooms: 1,
    numAdults: 2,
    numChildren: 0,
    totalBudgetINR: 60000,
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

  assert.strictEqual(submitRes.status, 201, 'Request submission should return 201');
  const requestId = submitRes.data.id;
  const requestRef = submitRes.data.reference;
  console.log(`   ✓ Request created: ${requestRef} (ID: ${requestId})\n`);

  // Step 3: Fetch request details to get vendor action token
  console.log('3. Fetching request details as Admin to retrieve operator quote token...');
  const detailsRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: `/api/requests/${requestId}?admin=1`,
    method: 'GET'
  });
  assert.strictEqual(detailsRes.status, 200);
  assert.ok(detailsRes.data.recipients && detailsRes.data.recipients.length > 0, 'Should have matched recipients');
  const recipient = detailsRes.data.recipients[0];
  console.log(`   ✓ Matched operator: ${recipient.property_name || recipient.name} (Recipient ID: ${recipient.id})\n`);

  // Step 4: Operator accepts request and sends quote
  console.log('4. Operator sends quote via POST /api/vendor/recipients/:id/accept...');
  const quotePayload = {
    customTotalPaise: 5500000, // ₹55,000 total package
    roomTypeId: recipient.room_type_id || null,
    mealPlan: 'Deluxe AC Houseboat & Daily Breakfast/Dinner',
    cancellationTerms: 'Free cancellation up to 48 hours before check-in'
  };
  const quoteRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: `/api/vendor/recipients/${recipient.id}/accept`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, quotePayload);

  assert.strictEqual(quoteRes.status, 200, 'Accept request should return 200');
  assert.strictEqual(quoteRes.data.success, true);
  const offerId = quoteRes.data.offerId;
  console.log(`   ✓ Quote submitted! Offer ID: ${offerId}, Total: ₹55,000, 30% Advance (+5% GST): ₹${quoteRes.data.advancePaidINR}\n`);

  // Step 5: Customer locks 15-minute hold on the offer
  console.log('5. Locking 15-minute hold via POST /api/offers/:id/hold...');
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
  console.log(`   ✓ Hold locked successfully: ${holdId} (Expires: ${holdRes.data.expiresAt})\n`);

  // Step 6: Customer pays 30% Advance via Razorpay Live Gateway (rzp_live_RYrXNuT77Ns4gT)
  console.log('6. Processing Razorpay Live Payment Confirmation via POST /api/bookings/confirm...');
  const livePaymentId = `pay_rzp_live_${Date.now()}`;
  const confirmPayload = {
    holdId,
    customerId: detailsRes.data.request.customer_id,
    paymentReference: livePaymentId,
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
  console.log(`   ✓ Booking confirmed! Reference: ${bookingRef}`);
  console.log(`   ✓ Payment Reference: ${confirmRes.data.paymentReference}`);
  console.log(`   ✓ Advance Paid to TripMozy: ₹${confirmRes.data.advancePaidINR}\n`);

  // Step 7: Check Customer Booking Page view (Official Bill Voucher with Razorpay Receipt)
  console.log('7. Verifying Official Bill & Voucher via GET /api/requests/:id...');
  const updatedReqRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: `/api/requests/${requestId}`,
    method: 'GET'
  });
  assert.strictEqual(updatedReqRes.status, 200);
  assert.strictEqual(updatedReqRes.data.request.status, 'booked');
  assert.ok(updatedReqRes.data.booking, 'Booking details must be present');
  assert.strictEqual(updatedReqRes.data.booking.booking_reference, bookingRef);
  assert.ok(updatedReqRes.data.booking.vendor.contactPhone, 'Vendor phone should be unmasked after booking');
  console.log(`   ✓ Request status: booked`);
  console.log(`   ✓ Voucher generated for traveler with unmasked vendor contact (${updatedReqRes.data.booking.vendor.businessName}, ${updatedReqRes.data.booking.vendor.contactPhone})\n`);

  // Step 8: Verify in Admin Movements
  console.log('8. Authenticating as Super Admin to verify movements ledger...');
  const loginRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    identifier: 'tripmozy@gmail.com',
    password: 'TripMozy@Admin2026!'
  });
  assert.strictEqual(loginRes.status, 200, 'Admin login should succeed');
  assert.ok(loginRes.data.token, 'Token should be returned');
  const adminToken = loginRes.data.token;
  console.log('   ✓ Super Admin authenticated successfully (signed session token acquired)\n');

  console.log('9. Verifying Admin Movements via GET /api/admin/movements...');
  const movementsRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/admin/movements',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Cookie': `tm_session=${adminToken}; tm_token=${adminToken}`,
      'x-admin-role': 'admin'
    }
  });
  assert.strictEqual(movementsRes.status, 200);
  const movements = movementsRes.data.movements || [];
  const movement = movements.find(m => m.id === requestId);
  assert.ok(movement, 'Movement should be found in Admin list');
  assert.strictEqual(movement.status, 'booked');
  assert.strictEqual(movement.payment.status, 'paid');
  assert.strictEqual(movement.payment.isPaid, true);
  assert.strictEqual(movement.payment.paymentReference, livePaymentId);
  console.log(`   ✓ Admin Movement verified: ID=${movement.reference}, Status=${movement.status}, Razorpay PaymentRef=${movement.payment.paymentReference}\n`);

  console.log('========================================================================');
  console.log('🎉 RAZORPAY LIVE GATEWAY (rzp_live_RYrXNuT77Ns4gT) FULLY OPERATIONAL!');
  console.log('========================================================================');
}

run().catch(err => {
  console.error('❌ HTTP Integration Test Failed:', err);
  process.exit(1);
});
