// ============================================================================
// Verification Test: TripMozy Official Vector Receipt PDF & JSON API
// ============================================================================

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

async function requestHttp(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 18089,
      path: urlPath,
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer: buf, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  const serverProcess = spawn('node', ['server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: '18089', PAYMENT_GATEWAY_PAUSED: 'true' },
    stdio: 'pipe'
  });
  await new Promise(r => setTimeout(r, 1500));

  try {
    // 1. Submit request
    const subRes = await requestHttp('POST', '/api/requests', {
      destination: 'Jaipur & Udaipur Heritage',
      checkInDate: '2027-02-12',
      checkOutDate: '2027-02-16',
      numRooms: 1,
      numAdults: 2,
      totalBudgetINR: 60000,
      guestName: 'Meera Kapoor',
      guestEmail: 'meera.pdf@tripmozy.com',
      guestPhone: '+91 98220 11223'
    });
    assert.strictEqual(subRes.status, 201);
    const sub = JSON.parse(subRes.text);
    const reqId = sub.id;
    const reqToken = sub.requestToken;

    // 2. Unbooked request should return 409 for receipt.pdf
    const unbookedPdfRes = await requestHttp('GET', `/api/bookings/${sub.reference}/receipt.pdf`);
    assert.strictEqual(unbookedPdfRes.status, 409);

    // 3. Vendor accepts request
    const vendorsRes = await requestHttp('GET', '/api/vendor/requests?vendorId=2f9816f8-f5e9-4f65-bee1-4b378133da81');
    const vendors = JSON.parse(vendorsRes.text);
    const rec = vendors.requests.find(r => r.request_id === reqId);
    assert.ok(rec, 'Expected recipient entry for vendor');

    const accRes = await requestHttp('POST', `/api/vendor/recipients/${rec.recipient_id}/accept`, {});
    assert.strictEqual(accRes.status, 200);

    // 4. Customer holds offer & confirms booking
    const detailRes = await requestHttp('GET', `/api/requests/${reqId}`);
    const detail = JSON.parse(detailRes.text);
    const offerId = detail.offers[0].id;

    const holdRes = await requestHttp('POST', `/api/offers/${offerId}/hold`, {
      token: reqToken,
      offer: {
        id: offerId,
        requestId: reqId,
        propertyId: detail.offers[0].property_id,
        propertyName: detail.offers[0].property_name,
        roomTypeId: detail.offers[0].room_type_id,
        totalPayablePaise: detail.offers[0].total_payable_paise
      }
    });
    assert.strictEqual(holdRes.status, 200);
    const hold = JSON.parse(holdRes.text);

    const confRes = await requestHttp('POST', '/api/bookings/confirm', {
      holdId: hold.holdId,
      paymentReference: 'pay_demo_pdf_verify_001',
      remainingPaymentOption: 'hotel_arrival',
      holdSnapshot: hold.holdSnapshot,
      token: reqToken
    });
    assert.strictEqual(confRes.status, 200);
    const confirmed = JSON.parse(confRes.text);
    const bkgRef = confirmed.bookingReference;

    // 5. Fetch JSON Receipt
    const jsonRes = await requestHttp('GET', `/api/bookings/${bkgRef}/receipt?token=${encodeURIComponent(confirmed.bookingToken)}`);
    assert.strictEqual(jsonRes.status, 200);
    const jsonPayload = JSON.parse(jsonRes.text);
    assert.strictEqual(jsonPayload.success, true);
    assert.strictEqual(jsonPayload.receipt.traveler.name, 'Meera Kapoor');
    assert.strictEqual(jsonPayload.receipt.pricing.totalTourINR, 60000);
    assert.strictEqual(jsonPayload.receipt.pricing.advanceBaseINR, 18000);
    assert.strictEqual(jsonPayload.receipt.pricing.advanceGstINR, 900);
    assert.strictEqual(jsonPayload.receipt.pricing.advancePaidINR, 18900);
    assert.strictEqual(jsonPayload.receipt.pricing.remainingBalanceINR, 42000);

    // 6. Fetch Inline PDF & Download Attachment PDF
    const inlinePdfRes = await requestHttp('GET', `/api/bookings/${bkgRef}/receipt.pdf?view=1&token=${encodeURIComponent(confirmed.bookingToken)}`);
    assert.strictEqual(inlinePdfRes.status, 200);
    assert.strictEqual(inlinePdfRes.headers['content-type'], 'application/pdf');
    assert.ok(inlinePdfRes.headers['content-disposition'].includes('inline; filename="TripMozy-Receipt-TM-INV-'));
    assert.ok(inlinePdfRes.buffer.subarray(0, 8).toString('latin1').startsWith('%PDF-1.4'));
    assert.ok(inlinePdfRes.buffer.toString('latin1').trim().endsWith('%%EOF'));

    const dlPdfRes = await requestHttp('GET', `/api/bookings/${reqId}/receipt.pdf?download=1`);
    assert.strictEqual(dlPdfRes.status, 200);
    assert.ok(dlPdfRes.headers['content-disposition'].includes('attachment; filename="TripMozy-Receipt-TM-INV-'));

    const pdfBodyStr = dlPdfRes.buffer.toString('latin1');
    assert.ok(pdfBodyStr.includes('TripMozy'), 'PDF should render TripMozy masthead');
    assert.ok(pdfBodyStr.includes('Meera Kapoor'), 'PDF should include traveler name');
    assert.ok(pdfBodyStr.includes('Rs. 18,900'), 'PDF should include advance deposit total');
    assert.ok(pdfBodyStr.includes('Rs. 42,000'), 'PDF should include remaining balance');
    assert.ok(pdfBodyStr.includes(jsonPayload.receipt.invoiceNumber), 'PDF should include invoice number');

    // Save sample PDF artifact if requested for visual inspection
    if (process.env.SAVE_SAMPLE_PDF_PATH) {
      fs.writeFileSync(process.env.SAVE_SAMPLE_PDF_PATH, dlPdfRes.buffer);
    }

    console.log('PDF RECEIPT TESTS PASSED!', jsonPayload.receipt.invoiceNumber, 'size=' + dlPdfRes.buffer.length + 'B');
  } finally {
    serverProcess.kill();
  }
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
