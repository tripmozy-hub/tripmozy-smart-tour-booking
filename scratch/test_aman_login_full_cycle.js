const path = require('path');
const assert = require('assert');
const repoRoot = 'C:/Users/user/Documents/GitHub/tripmozy-smart-tour-booking';
const { TripMozyDatabase } = require(path.join(repoRoot, 'src/db/database'));
const { AuthService } = require(path.join(repoRoot, 'src/auth/auth-service'));
const { VendorService } = require(path.join(repoRoot, 'src/vendor/vendor-service'));
const { NotificationService } = require(path.join(repoRoot, 'src/notifications/notification-service'));

async function testFullCycle() {
  console.log('=== TRIPMOZY AMAN VISHWAKARMA & VENDOR LOGIN VERIFICATION TEST ===\n');

  const db = new TripMozyDatabase(path.join(repoRoot, 'tripmozy.db'));
  const notifService = new NotificationService(db);
  const authService = new AuthService(db, notifService);
  const vendorService = new VendorService(db, notifService);

  // Test 1: getExistingRole with lowercase email
  console.log('Test 1: getExistingRole(amanvishwakarma8016@gmail.com)');
  const role1 = authService.getExistingRole('amanvishwakarma8016@gmail.com');
  console.log('Result:', role1);
  assert.strictEqual(role1, 'vendor', 'Must resolve to vendor');

  // Test 2: getExistingRole with mixed case email
  console.log('\nTest 2: getExistingRole(AmanVishwakarma8016@GMAIL.com)');
  const role2 = authService.getExistingRole('AmanVishwakarma8016@GMAIL.com');
  console.log('Result:', role2);
  assert.strictEqual(role2, 'vendor', 'Must resolve to vendor with case-insensitivity');

  // Test 3: getExistingRole with phone number
  console.log('\nTest 3: getExistingRole(+919876548016)');
  const role3 = authService.getExistingRole('+919876548016');
  console.log('Result:', role3);
  assert.strictEqual(role3, 'vendor', 'Must resolve to vendor with phone number');

  // Test 4: getExistingRole with raw 10 digits
  console.log('\nTest 4: getExistingRole(9876548016)');
  const role4 = authService.getExistingRole('9876548016');
  console.log('Result:', role4);
  assert.strictEqual(role4, 'vendor', 'Must resolve to vendor with raw 10 digits');

  // Test 5: sendOtp in mode: 'login' for Aman
  console.log("\nTest 5: sendOtp({ mode: 'login', email: 'amanvishwakarma8016@gmail.com', phone: '+919876548016' })");
  const otpRes = authService.sendOtp({
    mode: 'login',
    email: 'amanvishwakarma8016@gmail.com',
    phone: '+919876548016',
    identifier: 'amanvishwakarma8016@gmail.com'
  });
  console.log('sendOtp Response:', {
    success: otpRes.success,
    role: otpRes.role,
    channel: otpRes.channel,
    otpCode: otpRes.otpCode
  });
  assert.strictEqual(otpRes.success, true);
  assert.strictEqual(otpRes.role, 'vendor');
  assert.ok(otpRes.otpCode, 'OTP code must be generated');

  // Test 6: verifyOtp for Aman
  console.log('\nTest 6: verifyOtp with generated code');
  const verifyRes = authService.verifyOtp({
    identifier: 'amanvishwakarma8016@gmail.com',
    otpCode: otpRes.otpCode,
    role: 'vendor'
  });
  console.log('verifyOtp Response:', {
    success: verifyRes.success,
    role: verifyRes.role,
    vendor: verifyRes.vendor,
    redirectUrl: verifyRes.redirectUrl
  });
  assert.strictEqual(verifyRes.success, true);
  assert.strictEqual(verifyRes.role, 'vendor');
  assert.strictEqual(verifyRes.vendor.businessName, 'Aman Vishwakarma Tours & Travels');
  assert.ok(verifyRes.redirectUrl.includes('/partner/dashboard?vendorId='));

  // Test 7: Incoming requests for Aman's vendor dashboard
  console.log('\nTest 7: vendorService.getIncomingRequests(Aman vendor id)');
  const requests = vendorService.getIncomingRequests(verifyRes.vendor.id);
  console.log(`Aman's dashboard has ${requests.length} incoming tour request(s)`);
  assert.ok(requests.length > 0, "Aman's dashboard must have pending requests to view/accept");

  // Test 8: Non-existent user in mode: 'login' should throw with needsSignup: true
  console.log("\nTest 8: Non-existent user in mode: 'login'");
  try {
    authService.sendOtp({
      mode: 'login',
      email: 'totallynonexistent998877@gmail.com',
      phone: '+919999900000',
      identifier: 'totallynonexistent998877@gmail.com'
    });
    assert.fail('Should have thrown an error');
  } catch (err) {
    console.log('Error caught properly:', err.message);
    console.log('needsSignup flag:', err.needsSignup);
    assert.strictEqual(err.needsSignup, true, 'Must flag needsSignup for popup modal');
  }

  // Test 9: Serverless auto-recovery with restoreProfile: true
  console.log("\nTest 9: Serverless auto-recovery (restoreProfile: true)");
  const restoreRes = authService.sendOtp({
    mode: 'login',
    restoreProfile: true,
    email: 'newoperator_test99@gmail.com',
    phone: '+919876549999',
    role: 'vendor',
    name: 'New Operator Test',
    fullName: 'New Operator Test',
    businessName: 'New Operator Expeditions'
  });
  console.log('restoreRes Response:', {
    success: restoreRes.success,
    role: restoreRes.role,
    accountExists: restoreRes.accountExists
  });
  assert.strictEqual(restoreRes.success, true);
  assert.strictEqual(restoreRes.role, 'vendor');

  console.log('\n>>> ALL 9 VERIFICATION TESTS PASSED PERFECTLY! <<<');
}

testFullCycle().catch(err => {
  console.error('\nVerification failed:', err);
  process.exit(1);
});
