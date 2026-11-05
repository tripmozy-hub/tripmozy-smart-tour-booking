const path = require('path');
const crypto = require('crypto');
const repoRoot = 'C:/Users/user/Documents/GitHub/tripmozy-smart-tour-booking';
const { TripMozyDatabase } = require(path.join(repoRoot, 'src/db/database'));

function seedAmanVendor() {
  const db = new TripMozyDatabase(path.join(repoRoot, 'tripmozy.db'));
  const email = 'amanvishwakarma8016@gmail.com';
  const phone = '+919876548016';
  const name = 'Aman Vishwakarma';
  const bName = 'Aman Vishwakarma Tours & Travels';

  console.log(`Checking existing account for ${email}...`);

  db.transaction((tx) => {
    // 1. User profile
    let user = tx.queryOne('SELECT * FROM user_profiles WHERE LOWER(email) = LOWER(?)', [email]);
    if (!user) {
      const userId = tx.uuid();
      tx.execute(`
        INSERT INTO user_profiles (id, email, phone, role, display_name, status)
        VALUES (?, ?, ?, 'vendor', ?, 'active')
      `, [userId, email.toLowerCase(), phone, name]);
      user = tx.queryOne('SELECT * FROM user_profiles WHERE id = ?', [userId]);
      console.log(`Created user profile: ${user.id} (${user.email}, role: ${user.role})`);
    } else {
      tx.execute("UPDATE user_profiles SET role = 'vendor', display_name = ?, status = 'active' WHERE id = ?", [name, user.id]);
      console.log(`Updated existing user profile: ${user.id} (${user.email}, role: vendor)`);
    }

    // 2. Vendor account
    let vendor = tx.queryOne('SELECT * FROM vendor_accounts WHERE LOWER(contact_email) = LOWER(?) OR user_id = ?', [email, user.id]);
    if (!vendor) {
      const vendorId = tx.uuid();
      tx.execute(`
        INSERT INTO vendor_accounts (
          id, user_id, business_name, contact_person, contact_phone, contact_email,
          verification_status, commission_rate_basis_points, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'verified', 1500, 'active')
      `, [vendorId, user.id, bName, name, phone, email.toLowerCase()]);
      vendor = tx.queryOne('SELECT * FROM vendor_accounts WHERE id = ?', [vendorId]);
      console.log(`Created vendor account: ${vendor.id} (${vendor.business_name})`);
    } else {
      tx.execute(`
        UPDATE vendor_accounts
        SET user_id = ?, business_name = ?, contact_person = ?, contact_phone = ?, contact_email = ?, verification_status = 'verified', status = 'active'
        WHERE id = ?
      `, [user.id, bName, name, phone, email.toLowerCase(), vendor.id]);
      console.log(`Updated existing vendor account: ${vendor.id} (${vendor.business_name})`);
    }

    // 3. Property
    let prop = tx.queryOne("SELECT id, name FROM properties WHERE vendor_id = ? AND status = 'active' LIMIT 1", [vendor.id]);
    if (!prop) {
      const propId = tx.uuid();
      const slug = `partner-aman-vishwakarma-tours-${Date.now()}`;
      tx.execute(`
        INSERT INTO properties (
          id, vendor_id, name, slug, property_type, star_rating,
          description, address_line, city, state, pincode, country,
          latitude, longitude, timezone, check_in_time, check_out_time,
          status, inventory_mode
        ) VALUES (?, ?, ?, ?, 'hotel', 4.9, ?, 'Operations Center, Aman Vishwakarma Tours', 'All Destinations', 'India', '110001', 'India', 28.6139, 77.2090, 'Asia/Kolkata', '12:00', '11:00', 'active', 'vendor_confirmed')
      `, [
        propId,
        vendor.id,
        `${bName} - Premium Tour Fleet`,
        slug,
        `Verified TripMozy Tour Operator Partner (${bName}) providing premium guided tours, luxury vehicle rentals, and customized holiday packages across India.`
      ]);
      prop = { id: propId, name: `${bName} - Premium Tour Fleet` };
      console.log(`Created property: ${prop.id} (${prop.name})`);
    }

    // 4. Room type & rates
    let room = tx.queryOne('SELECT id FROM room_types WHERE property_id = ? AND is_active = 1 LIMIT 1', [prop.id]);
    if (!room) {
      const roomTypeId = tx.uuid();
      tx.execute(`
        INSERT INTO room_types (id, property_id, name, bed_type, max_adults, max_children, total_inventory, is_ac, is_active)
        VALUES (?, ?, 'All Inclusions Tour Package', 'Tour Vehicle + Hotel', 10, 5, 20, 1, 1)
      `, [roomTypeId, prop.id]);
      const rateId = tx.uuid();
      tx.execute(`
        INSERT INTO room_rates (id, room_type_id, rate_plan_name, base_nightly_rate_paise, tax_rate_basis_points, meal_plan, cancellation_rule, is_active)
        VALUES (?, ?, 'Premium Guided Tour Plan', 250000, 500, 'Breakfast, Dinner & Sightseeing', 'Free cancellation up to 48 hours before tour start', 1)
      `, [rateId, roomTypeId]);
      console.log(`Created room type & rate for property: ${prop.name}`);
    }

    // 5. Facilities
    const defaultFacs = ['wifi', 'parking', 'breakfast', 'mountain_view', 'ac', 'sightseeing', 'cab_transfer', 'hot_water'];
    for (const f of defaultFacs) {
      tx.execute('INSERT OR IGNORE INTO property_facilities (id, property_id, facility_code) VALUES (?, ?, ?)', [tx.uuid(), prop.id, f]);
    }

    // 6. Backfill all active tour requests to Aman's dashboard
    const pendingRequests = tx.query("SELECT id, request_reference, destination, expires_at FROM hotel_booking_requests WHERE status IN ('awaiting_responses', 'offers_available') ORDER BY created_at DESC LIMIT 15");
    let addedCount = 0;
    for (const req of pendingRequests) {
      const existing = tx.queryOne('SELECT id FROM booking_request_recipients WHERE request_id = ? AND vendor_id = ?', [req.id, vendor.id]);
      if (!existing) {
        const recipientId = tx.uuid();
        const rawToken = crypto.randomBytes(16).toString('hex');
        const actionTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        tx.execute(`
          INSERT INTO booking_request_recipients (
            id, request_id, property_id, vendor_id, delivery_status, response_status,
            expires_at, action_token_hash
          ) VALUES (?, ?, ?, ?, 'delivered', 'pending', ?, ?)
        `, [recipientId, req.id, prop.id, vendor.id, req.expires_at, actionTokenHash]);
        addedCount++;
      }
    }
    console.log(`Backfilled ${addedCount} tour requests to Aman's dashboard.`);
  });

  const finalCheck = db.queryOne(`
    SELECT v.id as vendor_id, v.business_name, v.contact_email, v.contact_phone, v.status,
           u.id as user_id, u.role, u.display_name
    FROM vendor_accounts v
    JOIN user_profiles u ON v.user_id = u.id
    WHERE LOWER(v.contact_email) = LOWER(?)
  `, [email]);

  console.log('--- FINAL SEED STATUS ---');
  console.log(finalCheck);
}

seedAmanVendor();
