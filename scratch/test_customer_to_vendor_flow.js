const assert = require('assert');

async function runTest() {
  console.log('=== END-TO-END TEST: CUSTOMER REQUEST TO VENDOR DASHBOARD ===\n');
  const baseUrl = 'http://localhost:8080';

  // 1. Check vendor list
  console.log('Step 1: Check active vendors via /api/vendor/list');
  const vListRes = await fetch(`${baseUrl}/api/vendor/list`);
  const vListData = await vListRes.json();
  console.log(`Found ${vListData.vendors.length} active tour operators:`);
  vListData.vendors.forEach(v => console.log(` - ${v.business_name} (ID: ${v.id})`));
  const aman = vListData.vendors.find(v => v.contact_email === 'amanvishwakarma8016@gmail.com' || v.business_name.includes('Aman'));
  assert.ok(aman, 'Aman Vishwakarma vendor must be in the active list');
  const amanId = aman.id;

  // 2. Customer submits a new tour request
  console.log('\nStep 2: Customer submits tour request for Jaipur');
  const customerEmail = 'priya.traveler@gmail.com';
  const reqPayload = {
    guestName: 'Priya Patel',
    guestEmail: customerEmail,
    guestPhone: '+919876543210',
    destination: 'Jaipur, Rajasthan',
    checkInDate: '2026-11-20',
    checkOutDate: '2026-11-24',
    numRooms: 1,
    numAdults: 2,
    numChildren: 0,
    totalBudgetINR: 30000,
    roomPreference: 'any',
    requiredFacilities: ['wifi', 'parking'],
    communicationConsent: true,
    termsAccepted: true
  };

  const reqRes = await fetch(`${baseUrl}/api/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqPayload)
  });
  const reqData = await reqRes.json();
  console.log('Customer request created:', {
    id: reqData.id,
    reference: reqData.reference,
    status: reqData.status,
    matchedCount: reqData.matchedCount
  });
  assert.strictEqual(reqRes.status, 201);
  assert.strictEqual(reqData.status, 'awaiting_responses');
  assert.ok(reqData.matchedCount >= 2, 'Must be dispatched to multiple tour operators');

  // 3. Check Aman Vishwakarma dashboard
  console.log(`\nStep 3: Check Aman's dashboard (/api/vendor/requests?vendorId=${amanId})`);
  const amanReqRes = await fetch(`${baseUrl}/api/vendor/requests?vendorId=${amanId}`);
  const amanReqData = await amanReqRes.json();
  const foundInAman = (amanReqData.requests || []).find(r => r.request_id === reqData.id);
  console.log('Found in Aman queue:', !!foundInAman);
  if (foundInAman) {
    console.log({
      recipient_id: foundInAman.recipient_id,
      ref: foundInAman.request_reference,
      destination: foundInAman.destination,
      status: foundInAman.response_status
    });
  }
  assert.ok(foundInAman, 'New request must appear in Aman dashboard');
  assert.strictEqual(foundInAman.response_status, 'pending');

  // 4. Check another active vendor's dashboard
  const otherVendor = vListData.vendors.find(v => v.id !== amanId);
  console.log(`\nStep 4: Check other vendor dashboard (${otherVendor.business_name}, ID: ${otherVendor.id})`);
  const otherRes = await fetch(`${baseUrl}/api/vendor/requests?vendorId=${otherVendor.id}`);
  const otherData = await otherRes.json();
  const foundInOther = (otherData.requests || []).find(r => r.request_id === reqData.id);
  console.log(`Found in ${otherVendor.business_name} queue:`, !!foundInOther);
  assert.ok(foundInOther, `New request must appear in other vendor (${otherVendor.business_name}) dashboard`);

  // 5. Aman accepts the tour request & submits quote
  console.log("\nStep 5: Aman accepts the tour request with quote of 28,000 INR");
  const acceptRes = await fetch(`${baseUrl}/api/vendor/recipients/${foundInAman.recipient_id}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customTotalPaise: 2800000,
      mealPlan: 'Breakfast & Sightseeing Included',
      cancellationTerms: 'Free cancellation up to 48 hours before tour start'
    })
  });
  const acceptData = await acceptRes.json();
  console.log('Aman accept response:', {
    success: acceptData.success,
    offerId: acceptData.offer ? acceptData.offer.id : null,
    totalINR: acceptData.offer ? acceptData.offer.pricing.totalPayablePaise / 100 : null
  });
  assert.strictEqual(acceptData.success, true);

  // 6. Verify request disappeared from other vendor's queue
  console.log(`\nStep 6: Verify request disappeared from other vendor (${otherVendor.business_name})`);
  const otherResAfter = await fetch(`${baseUrl}/api/vendor/requests?vendorId=${otherVendor.id}`);
  const otherDataAfter = await otherResAfter.json();
  const foundInOtherAfter = (otherDataAfter.requests || []).find(r => r.request_id === reqData.id && r.response_status === 'pending');
  console.log(`Still pending in ${otherVendor.business_name} queue?`, !!foundInOtherAfter);
  assert.strictEqual(foundInOtherAfter, undefined, 'Request must disappear from other vendors once one vendor accepts');

  // 7. Verify customer sees Aman offer
  console.log('\nStep 7: Customer loads request details (/api/requests/:id)');
  const custViewRes = await fetch(`${baseUrl}/api/requests/${reqData.id}`);
  const custViewData = await custViewRes.json();
  console.log('Customer view status:', custViewData.request.status);
  console.log('Offers count:', custViewData.offers.length);
  if (custViewData.offers.length > 0) {
    const o = custViewData.offers[0];
    console.log(`Offer from: ${o.vendor ? o.vendor.businessName : o.property_name} · Total: ₹${o.total_payable_paise / 100}`);
  }
  assert.strictEqual(custViewData.offers.length, 1);
  assert.strictEqual(custViewData.offers[0].total_payable_paise, 2800000);

  console.log('\n>>> ALL 7 END-TO-END FLOW TESTS PASSED FLAWLESSLY! <<<');
}

runTest().catch(err => {
  console.error('\nTest failed:', err);
  process.exit(1);
});
