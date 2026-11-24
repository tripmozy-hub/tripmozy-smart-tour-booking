const http = require('http');
const assert = require('assert');

// Require server or spawn
const { spawn } = require('child_process');

async function main() {
  const serverProcess = spawn('node', ['server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: '8099', PAYMENT_GATEWAY_PAUSED: 'true' },
    stdio: 'pipe'
  });

  serverProcess.stdout.on('data', (d) => {
    // console.log('[Server stdout]', d.toString());
  });
  serverProcess.stderr.on('data', (d) => {
    console.error('[Server stderr]', d.toString());
  });

  // Wait 1.5s for server to start
  await new Promise(r => setTimeout(r, 1500));

  function request(path, options = {}, body = null) {
    return new Promise((resolve, reject) => {
      const opt = {
        hostname: '127.0.0.1',
        port: 8099,
        path,
        method: options.method || 'GET',
        headers: options.headers || {}
      };
      const req = http.request(opt, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, body: json || data });
        });
      });
      req.on('error', reject);
      if (body) {
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.end();
    });
  }

  try {
    // 1. Submit Request
    const submitRes = await request('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      guestName: 'Rohit Sharma',
      guestEmail: 'rohit.sharma@example.com',
      guestPhone: '+919876543211',
      destination: 'Goa Coastal Tour',
      checkInDate: '2026-12-15',
      checkOutDate: '2026-12-19',
      numRooms: 1,
      numAdults: 2,
      totalBudgetINR: 35000,
      termsAccepted: true
    });
    console.log('HTTP Submit Request:', submitRes.status, submitRes.body.reference);
    assert.strictEqual(submitRes.status, 201);
    const reqRef = submitRes.body.reference;
    const reqToken = submitRes.body.requestToken;

    // 2. Vendor gets incoming requests
    const venRes = await request(`/api/vendor/requests`);
    console.log('Vendor requests response count:', venRes.body?.requests?.length);
    const incoming = venRes.body?.requests?.find(r => r.request_reference === reqRef);
    if (!incoming && venRes.body?.requests?.length > 0) {
      console.log('First incoming request ref:', venRes.body.requests[0].request_reference);
    }
    const vendorId = incoming ? incoming.vendor_id : (venRes.body?.requests?.[0]?.vendor_id || 'v-goa-001');
    assert(incoming, 'Request must appear in vendor incoming list');
    console.log('HTTP Vendor Incoming found, recipientId:', incoming.recipient_id);

    // 3. Vendor accepts request
    const acceptRes = await request(`/api/vendor/recipients/${incoming.recipient_id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { customTotalPaise: 3500000 });
    assert.strictEqual(acceptRes.status, 200);
    console.log('HTTP Vendor Accepted request');

    // 4. Customer views request & offers
    const custReqRes = await request(`/api/requests/${reqRef}?token=${reqToken}`);
    assert.strictEqual(custReqRes.status, 200);
    assert(custReqRes.body.offers.length > 0, 'Offers must exist');
    const offer = custReqRes.body.offers[0];
    console.log('HTTP Customer view offers found offerId:', offer.id);

    // 5. Customer creates hold
    const holdRes = await request(`/api/offers/${offer.id}/hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-token': reqToken }
    }, {
      offer: { id: offer.id, totalPayablePaise: offer.total_payable_paise },
      request: { id: custReqRes.body.request.id, reference: reqRef },
      token: reqToken
    });
    assert.strictEqual(holdRes.status, 200);
    const holdId = holdRes.body.holdId;
    const holdSnapshot = holdRes.body.holdSnapshot;
    console.log('HTTP Hold created:', holdId);

    // 6. Confirm Booking
    const confirmRes = await request('/api/bookings/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-token': reqToken }
    }, {
      holdId,
      holdSnapshot,
      paymentReference: 'pay_demo_e2e_test',
      remainingPaymentOption: 'hotel_arrival',
      token: reqToken
    });
    console.log('HTTP Booking Confirm status:', confirmRes.status, 'Reference:', confirmRes.body.bookingReference);
    assert.strictEqual(confirmRes.status, 200);
    assert(confirmRes.body.bookingToken, 'bookingToken must be returned in HTTP response');
    const bkgRef = confirmRes.body.bookingReference;
    const bkgToken = confirmRes.body.bookingToken;

    // Verify Set-Cookie header
    const setCookie = confirmRes.headers['set-cookie'] || [];
    const hasBkgTokenCookie = setCookie.some(c => c.includes('tm_latest_booking_token'));
    assert(hasBkgTokenCookie, 'Response must set tm_latest_booking_token cookie');
    console.log('HTTP Set-Cookie header verified!');

    // 7. Look up by Booking Reference
    const bkgLookupRes = await request(`/api/requests/${bkgRef}?token=${bkgToken}`);
    assert.strictEqual(bkgLookupRes.status, 200);
    assert.strictEqual(bkgLookupRes.body.request.status, 'booked');
    assert(bkgLookupRes.body.booking, 'Booking object must be populated');
    assert.strictEqual(bkgLookupRes.body.booking.booking_reference, bkgRef);
    console.log('HTTP Booking Reference Lookup verified! Status:', bkgLookupRes.body.request.status);

    // 8. Vendor Dashboard verifies traveler contact is unmasked
    const venAfterRes = await request(`/api/vendor/requests?vendorId=${vendorId}`);
    assert.strictEqual(venAfterRes.status, 200);
    const bookedRow = venAfterRes.body.requests.find(r => r.request_reference === reqRef);
    assert(bookedRow, 'Booked request must be in vendor list');
    assert.strictEqual(bookedRow.guest_name, 'Rohit Sharma');
    assert.strictEqual(bookedRow.guest_phone, '+919876543211');
    assert.strictEqual(bookedRow.guest_email, 'rohit.sharma@example.com');
    console.log('HTTP Vendor Dashboard Contact unmasked verified! Name:', bookedRow.guest_name, 'Phone:', bookedRow.guest_phone);

    console.log('ALL HTTP END-TO-END TESTS PASSED SUCCESSFULLY!');
  } finally {
    serverProcess.kill('SIGTERM');
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
