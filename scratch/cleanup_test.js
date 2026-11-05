const path = require('path');
const { TripMozyDatabase } = require(path.join(__dirname, '../src/db/database'));
const db = new TripMozyDatabase(path.join(__dirname, '../tripmozy.db'));

const vendor = db.queryOne("SELECT id, user_id FROM vendor_accounts WHERE contact_email = 'newoperator_test99@gmail.com'");
if (vendor) {
  const props = db.query("SELECT id FROM properties WHERE vendor_id = ?", [vendor.id]);
  for (const p of props) {
    db.execute("DELETE FROM booking_request_recipients WHERE property_id = ? OR vendor_id = ?", [p.id, vendor.id]);
    const rts = db.query("SELECT id FROM room_types WHERE property_id = ?", [p.id]);
    for (const rt of rts) {
      db.execute("DELETE FROM room_rates WHERE room_type_id = ?", [rt.id]);
    }
    db.execute("DELETE FROM room_types WHERE property_id = ?", [p.id]);
    db.execute("DELETE FROM property_facilities WHERE property_id = ?", [p.id]);
    db.execute("DELETE FROM properties WHERE id = ?", [p.id]);
  }
  db.execute("DELETE FROM vendor_accounts WHERE id = ?", [vendor.id]);
  if (vendor.user_id) {
    db.execute("DELETE FROM user_profiles WHERE id = ?", [vendor.user_id]);
  }
}
db.execute("DELETE FROM user_profiles WHERE email = 'newoperator_test99@gmail.com'");
db.execute("DELETE FROM auth_otps WHERE identifier LIKE '%newoperator_test99%'");
console.log('Cleaned up test user successfully');
