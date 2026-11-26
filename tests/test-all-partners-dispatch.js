const assert = require('assert');
const { TripMozyDatabase } = require('../src/db/database');
const { AuthService } = require('../src/auth/auth-service');
const { AdminService } = require('../src/admin/admin-service');
const { RequestService } = require('../src/requests/request-service');
const { VendorService } = require('../src/vendor/vendor-service');
const { seedCoreTourOperators } = require('../src/onboarding/catalog-loader');
const { ROLES, SecurityContext } = require('../src/auth/roles');

// Instance A: multiple partners + new partner + newly added partner without room rates
const dbA = new TripMozyDatabase(':memory:');
seedCoreTourOperators(dbA);

const authA = new AuthService(dbA);
const adminA = new AdminService(dbA);
const reqServiceA = new RequestService(dbA);
const vendorServiceA = new VendorService(dbA);

const newReg = authA.registerNewVendor({
  cleanId: 'brandnew.operator@example.com',
  isEmail: true,
  cleanDigits: '9811199222',
  name: 'Dev Patel',
  phone: '+919811199222',
  email: 'brandnew.operator@example.com',
  businessName: 'Deccan Discovery Travels'
});

const adminAdded = adminA.addVendor({
  actorContext: new SecurityContext({ user: { id: 'admin', email: 'tripmozy@gmail.com' }, role: ROLES.ADMIN }),
  businessName: 'Sunrise Heritage Tours',
  contactPerson: 'Suresh Nair',
  contactPhone: '+919822288333',
  contactEmail: 'sunrise.tours@example.com',
  city: 'Jaipur'
});

const reqRes = reqServiceA.submitStayRequest({
  guestName: 'Test Traveler',
  guestEmail: 'traveler.dispatch@example.com',
  guestPhone: '+919800012345',
  destination: 'Goa',
  checkInDate: '2027-05-10',
  checkOutDate: '2027-05-14',
  numRooms: 1,
  numAdults: 2,
  totalBudgetINR: 40000,
  termsAccepted: true
});

const allActiveVendors = dbA.query("SELECT id, business_name FROM vendor_accounts WHERE LOWER(TRIM(status)) = 'active'");
assert(allActiveVendors.length >= 8, 'Expected all seeded and newly added active vendors');

for (const v of allActiveVendors) {
  const queue = vendorServiceA.getIncomingRequests(v.id);
  const found = queue.find(item => item.request_reference === reqRes.reference);
  assert(found, `Vendor ${v.business_name} (${v.id}) did NOT receive request ${reqRes.reference}`);
  assert.strictEqual(found.response_status, 'pending');
  assert.strictEqual(found.total_budget_inr, 40000);
}
console.log(`ALL ${allActiveVendors.length} ACTIVE PARTNERS ON INSTANCE A RECEIVED ${reqRes.reference}`);

// Simulate signed token login for brandnew.operator@example.com and cold Instance B
const signedToken = authA.generateSignedToken({
  userId: newReg.user_id,
  role: 'vendor',
  email: 'brandnew.operator@example.com',
  phone: '+919811199222',
  displayName: 'Deccan Discovery Travels',
  vendorId: newReg.id
});

const dbB = new TripMozyDatabase(':memory:');
seedCoreTourOperators(dbB);
const authB = new AuthService(dbB);
const reqServiceB = new RequestService(dbB);
const vendorServiceB = new VendorService(dbB);

// Cold Instance B does not have newReg or adminAdded yet
assert.strictEqual(dbB.queryOne('SELECT id FROM vendor_accounts WHERE id = ?', [newReg.id]), undefined);

const sessionB = authB.validateSession(signedToken);
assert.strictEqual(sessionB.authenticated, true);
assert.strictEqual(sessionB.role, 'vendor');
assert.strictEqual(sessionB.vendorId, newReg.id);

const rehydratedVendorId = vendorServiceB.rehydrateVendorFromSession(sessionB);
assert.strictEqual(rehydratedVendorId, newReg.id);

const rehydratedReqOk = reqServiceB.rehydrateRequestFromToken(reqRes.requestToken);
assert.strictEqual(rehydratedReqOk, true);

const coldQueueNewVendor = vendorServiceB.getIncomingRequests(newReg.id);
assert(
  coldQueueNewVendor.some(item => item.request_reference === reqRes.reference),
  'Newly registered partner on cold Instance B must see rehydrated request'
);

const coreVendorsB = dbB.query("SELECT id, business_name FROM vendor_accounts WHERE LOWER(TRIM(status)) = 'active'");
for (const v of coreVendorsB) {
  const q = vendorServiceB.getIncomingRequests(v.id);
  assert(
    q.some(item => item.request_reference === reqRes.reference),
    `Cold Instance B vendor ${v.business_name} must also see ${reqRes.reference}`
  );
}

// Verify late-joining partner without pre-existing room_types still has active fleet/rate auto-provisioned
vendorServiceB.getIncomingRequests(rehydratedVendorId);
const roomCheck = dbB.queryOne(`
  SELECT rt.id FROM properties p
  JOIN room_types rt ON rt.property_id = p.id
  JOIN room_rates rr ON rr.room_type_id = rt.id
  WHERE p.vendor_id = ? AND p.status = 'active' AND rt.is_active = 1 AND rr.is_active = 1
`, [newReg.id]);
assert(roomCheck && roomCheck.id, 'Partner must have active room_type and room_rate to quote');

console.log(`COLD INSTANCE B REHYDRATION & ALL-PARTNER PARITY PASSED (${coreVendorsB.length} vendors verified)`);
dbA.close();
dbB.close();
