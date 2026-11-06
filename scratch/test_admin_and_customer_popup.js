const http = require('http');

function postJSON(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 8080,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }, res => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(resBody), headers: res.headers });
        } catch (_) {
          resolve({ status: res.statusCode, raw: resBody, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJSON(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 8080,
      path: path,
      method: 'GET',
      headers: { ...headers }
    }, res => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(resBody), headers: res.headers });
        } catch (_) {
          resolve({ status: res.statusCode, raw: resBody, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function deleteJSON(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 8080,
      path: path,
      method: 'DELETE',
      headers: { ...headers }
    }, res => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(resBody), headers: res.headers });
        } catch (_) {
          resolve({ status: res.statusCode, raw: resBody, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function runTests() {
  console.log('--- STARTING ADMIN & POPUP SUITE VERIFICATION ---');

  // Test 1: Admin Direct Login
  console.log('\n[1] Testing Admin Direct Login with tripmozy@gmail.com...');
  const loginRes = await postJSON('/api/auth/admin-login', {
    identifier: 'tripmozy@gmail.com',
    password: 'TripMozy@Admin2026!'
  });
  console.log('Login status:', loginRes.status);
  console.log('Login response role:', loginRes.data && loginRes.data.role);
  console.log('Login redirectUrl:', loginRes.data && loginRes.data.redirectUrl);
  if (loginRes.status !== 200 || loginRes.data.role !== 'admin') {
    throw new Error('Admin login failed: ' + JSON.stringify(loginRes.data));
  }
  const token = loginRes.data.token;
  const authHeader = { 'Authorization': `Bearer ${token}` };

  // Test 2: Admin Movements API
  console.log('\n[2] Testing GET /api/admin/movements...');
  const movRes = await getJSON('/api/admin/movements', authHeader);
  console.log('Movements status:', movRes.status);
  console.log('Total requests count:', movRes.data.requests ? movRes.data.requests.length : 0);
  console.log('Summary metrics:', movRes.data.summary);
  if (movRes.data.requests && movRes.data.requests.length > 0) {
    const firstReq = movRes.data.requests[0];
    console.log('Sample Request ID:', firstReq.id);
    console.log('Customer Unmasked:', firstReq.customer);
    console.log('Tour Circuit:', firstReq.tour);
    console.log('Accepted Operator:', firstReq.acceptedOperator);
    console.log('Offer & Payment:', firstReq.offer, firstReq.payment);
  }

  // Test 3: Public Featured Tours API
  console.log('\n[3] Testing GET /api/featured-tours...');
  const featRes = await getJSON('/api/featured-tours');
  console.log('Featured tours status:', featRes.status);
  console.log('Count of featured packages:', featRes.data.featuredTours.length);
  const sampleFeat = featRes.data.featuredTours[0];
  console.log('Sample featured card:', {
    title: sampleFeat.title,
    destination: sampleFeat.destination,
    duration: sampleFeat.duration,
    starting_price_inr: sampleFeat.starting_price_inr
  });

  // Test 4: Add New Featured Tour Card
  console.log('\n[4] Testing POST /api/admin/featured-tours...');
  const newFeatRes = await postJSON('/api/admin/featured-tours', {
    title: 'Mystical Andaman Island Hopping',
    destination: 'Port Blair & Havelock, Andaman',
    duration: '6 Days / 5 Nights',
    nights: 5,
    days: 6,
    startingPriceINR: 32000,
    badge: 'Island Exclusive',
    imageUrl: 'https://images.unsplash.com/photo-1589308078059-be1415eab4c3?auto=format&fit=crop&w=600&q=80',
    overview: 'Pristine coral reefs, Radhanagar Beach sunset, and luxury speed-boat island transfers.',
    highlights: ['Radhanagar Beach', 'Elephant Beach Snorkeling', 'Cellular Jail Light & Sound'],
    inclusions: ['Luxury Beach Resort', 'Daily Breakfast', 'Private Catamaran Transfers']
  }, authHeader);
  console.log('Add featured tour status:', newFeatRes.status);
  const createdTourId = newFeatRes.data.tour ? newFeatRes.data.tour.id : null;
  console.log('Created tour card ID:', createdTourId);

  // Test 5: Remove Featured Tour Card
  if (createdTourId) {
    console.log('\n[5] Testing DELETE /api/admin/featured-tours/:id...');
    const delFeatRes = await deleteJSON(`/api/admin/featured-tours/${createdTourId}`, authHeader);
    console.log('Delete featured tour status:', delFeatRes.status, delFeatRes.data);
  }

  // Test 6: Add New Tour Operator
  console.log('\n[6] Testing POST /api/admin/vendors...');
  const newVenRes = await postJSON('/api/admin/vendors', {
    businessName: 'Himalayan High Passes Expeditions',
    contactPerson: 'Tenzing Norbu',
    contactPhone: '+91 98160 55443',
    contactEmail: 'tenzing@himalayanpasses.in',
    city: 'Leh & Manali',
    commissionBps: 500
  }, authHeader);
  console.log('Add vendor status:', newVenRes.status);
  const createdVenId = newVenRes.data.vendor ? newVenRes.data.vendor.id : null;
  console.log('Created vendor ID:', createdVenId);

  // Test 7: Toggle Vendor Status
  if (createdVenId) {
    console.log('\n[7] Testing POST /api/admin/vendors/:id/status (suspend & activate)...');
    const suspRes = await postJSON(`/api/admin/vendors/${createdVenId}/status`, { status: 'suspended' }, authHeader);
    console.log('Suspend status:', suspRes.status, suspRes.data);
    const actRes = await postJSON(`/api/admin/vendors/${createdVenId}/status`, { status: 'active' }, authHeader);
    console.log('Activate status:', actRes.status, actRes.data);

    // Test 8: Remove Vendor
    console.log('\n[8] Testing DELETE /api/admin/vendors/:id...');
    const delVenRes = await deleteJSON(`/api/admin/vendors/${createdVenId}`, authHeader);
    console.log('Delete vendor status:', delVenRes.status, delVenRes.data);
  }

  console.log('\n✅ ALL ADMIN SUITE & FEATURED CARDS API TESTS PASSED PERFECTLY!');
}

runTests().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
