const assert = require('assert');

async function runTest() {
  console.log('--- TESTING COMPLETE CUSTOMER SUBMIT & VENDOR DASHBOARD APPEARANCE ---');

  // 1. Fetch all active vendors
  const listRes = await fetch('http://localhost:8080/api/vendor/list');
  const listData = await listRes.json();
  const activeVendors = listData.vendors;
  console.log(`Found ${activeVendors.length} active tour operator vendors in marketplace:`);
  activeVendors.forEach(v => console.log(`  - ${v.business_name} (${v.id})`));
  assert(activeVendors.length >= 2, 'Must have at least 2 active vendors');

  // 2. Customer submits a new tour request
  const testRef = `Test Traveler ${Date.now()}`;
  console.log(`\n2. Customer submitting tour request for "${testRef}"...`);
  const submitRes = await fetch('http://localhost:8080/api/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      destination: 'Gulmarg, Kashmir',
      propertyTypePreference: 'hotel',
      checkInDate: '2026-12-01',
      checkOutDate: '2026-12-05',
      numRooms: 1,
      numAdults: 2,
      numChildren: 0,
      totalBudgetINR: 35000,
      roomPreference: 'ac',
      requiredFacilities: ['wifi', 'breakfast', 'mountain_view'],
      guestName: testRef,
      guestEmail: `traveler_${Date.now()}@gmail.com`,
      guestPhone: '9876500000',
      communicationConsent: true,
      termsAccepted: true
    })
  });

  const submitData = await submitRes.json();
  console.log('Submit Response:', submitRes.status, submitData);
  assert(submitRes.status === 201, 'Request submission must succeed with 201');
  assert(submitData.id, 'Request ID must be returned');
  const requestId = submitData.id;

  // 3. Check EVERY active vendor's dashboard to ensure the request APPEARS in all of them!
  console.log(`\n3. Verifying that request ${requestId} appears in EVERY vendor's dashboard...`);
  for (const v of activeVendors) {
    const vRes = await fetch(`http://localhost:8080/api/vendor/requests?vendorId=${v.id}`);
    const vData = await vRes.json();
    assert(vRes.status === 200, `Vendor ${v.business_name} request list must return 200`);
    const found = vData.requests.some(r => r.request_id === requestId && r.response_status === 'pending');
    console.log(`  Vendor "${v.business_name}" (${v.id.slice(0, 8)}): found pending request = ${found}`);
    assert(found, `Request MUST appear in vendor dashboard for ${v.business_name}`);
  }
  console.log('SUCCESS: Customer request appeared in ALL vendors\' dashboards simultaneously!');

  // 4. One vendor accepts the request
  const vendorToAccept = activeVendors[0];
  console.log(`\n4. Vendor "${vendorToAccept.business_name}" accepts the request...`);
  const detailsRes = await fetch(`http://localhost:8080/api/requests/${requestId}`);
  const detailsData = await detailsRes.json();
  const recipientForVendor = detailsData.recipients.find(r => r.vendor_id === vendorToAccept.id);
  assert(recipientForVendor, 'Recipient record must exist for accepting vendor');

  const acceptRes = await fetch(`http://localhost:8080/api/vendor/recipients/${recipientForVendor.id}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customTotalPaise: 3500000,
      mealPlan: 'Breakfast & Sightseeing'
    })
  });
  const acceptData = await acceptRes.json();
  assert(acceptRes.status === 200, 'Accept must succeed');
  console.log(`Vendor "${vendorToAccept.business_name}" accepted! Offer:`, acceptData.offerReference);

  // 5. Verify the request automatically DISAPPEARED from ALL OTHER vendors' dashboards!
  console.log('\n5. Verifying automatic disappear from other vendors...');
  for (const v of activeVendors) {
    const vRes = await fetch(`http://localhost:8080/api/vendor/requests?vendorId=${v.id}`);
    const vData = await vRes.json();
    const hasPending = vData.requests.some(r => r.request_id === requestId && r.response_status === 'pending');

    if (v.id === vendorToAccept.id) {
      const hasAccepted = vData.requests.some(r => r.request_id === requestId && r.response_status === 'accepted');
      console.log(`  Accepting Vendor "${v.business_name}": has accepted request = ${hasAccepted}`);
      assert(hasAccepted, 'Accepting vendor must have request in accepted state');
    } else {
      console.log(`  Other Vendor "${v.business_name}": has request = ${hasPending} (should be false)`);
      assert(!hasPending, `Request MUST disappear from other vendor ${v.business_name}`);
    }
  }

  console.log('\n*** ALL TESTS PASSED: Customer request reliably appears in vendor dashboards & auto-disappears on accept! ***');
}

runTest().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
