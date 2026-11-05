const path = require('path');
const crypto = require('crypto');
const repoRoot = 'C:/Users/user/Documents/GitHub/tripmozy-smart-tour-booking';
const { TripMozyDatabase } = require(path.join(repoRoot, 'src/db/database'));

function runBackfill() {
  const db = new TripMozyDatabase(path.join(repoRoot, 'tripmozy.db'));

  console.log('--- RUNNING VENDOR PROFILE & RECIPIENT BACKFILL ---');

  // 1. Ensure all active vendors have a property with room_type, room_rate, and facilities
  const vendors = db.query("SELECT id, business_name FROM vendor_accounts WHERE status = 'active'");
  console.log(`Found ${vendors.length} active vendors`);

  const defaultFacs = ['wifi', 'parking', 'breakfast', 'mountain_view', 'ac', 'sightseeing', 'cab_transfer', 'hot_water'];

  for (const v of vendors) {
    let prop = db.queryOne("SELECT id, name FROM properties WHERE vendor_id = ? AND status = 'active' LIMIT 1", [v.id]);
    if (!prop) {
      const propId = db.uuid();
      db.execute(`
        INSERT INTO properties (
          id, vendor_id, name, slug, property_type, star_rating,
          description, address_line, city, state, pincode, country,
          latitude, longitude, timezone, check_in_time, check_out_time,
          status, inventory_mode
        ) VALUES (?, ?, ?, ?, 'hotel', 4.8, ?, 'India Operations', 'All Destinations', 'India', '110001', 'India', 28.6139, 77.2090, 'Asia/Kolkata', '12:00', '11:00', 'active', 'vendor_confirmed')
      `, [
        propId,
        v.id,
        `${v.business_name} - Tour Fleet`,
        `fleet-${v.id.slice(0, 8)}-${Date.now()}`,
        `Verified Tour Operator Partner (${v.business_name})`
      ]);
      prop = { id: propId, name: `${v.business_name} - Tour Fleet` };
      console.log(`Created fleet property for vendor: ${v.business_name}`);
    }

    // Ensure room type
    let room = db.queryOne('SELECT id FROM room_types WHERE property_id = ? AND is_active = 1 LIMIT 1', [prop.id]);
    if (!room) {
      const roomTypeId = db.uuid();
      db.execute(`
        INSERT INTO room_types (id, property_id, name, bed_type, max_adults, max_children, total_inventory, is_ac, is_active)
        VALUES (?, ?, 'Custom Tour Package', 'King', 4, 2, 20, 1, 1)
      `, [roomTypeId, prop.id]);
      const rateId = db.uuid();
      db.execute(`
        INSERT INTO room_rates (id, room_type_id, rate_plan_name, base_nightly_rate_paise, tax_rate_basis_points, meal_plan, is_active)
        VALUES (?, ?, 'Standard Package', 350000, 500, 'Breakfast Included', 1)
      `, [rateId, roomTypeId]);
      console.log(`Created room type & rate for property: ${prop.name}`);
    }

    // Ensure facilities
    for (const f of defaultFacs) {
      db.execute('INSERT OR IGNORE INTO property_facilities (id, property_id, facility_code) VALUES (?, ?, ?)', [db.uuid(), prop.id, f]);
    }
  }

  // 2. Backfill pending requests to all active vendors
  const pendingRequests = db.query("SELECT id, request_reference, destination, expires_at FROM hotel_booking_requests WHERE status IN ('awaiting_responses', 'offers_available') ORDER BY created_at DESC LIMIT 10");
  console.log(`Found ${pendingRequests.length} active/recent requests to verify`);

  let addedCount = 0;
  for (const req of pendingRequests) {
    for (const v of vendors) {
      const existing = db.queryOne('SELECT id, response_status FROM booking_request_recipients WHERE request_id = ? AND vendor_id = ?', [req.id, v.id]);
      if (!existing) {
        const prop = db.queryOne("SELECT id FROM properties WHERE vendor_id = ? AND status = 'active' ORDER BY star_rating DESC LIMIT 1", [v.id]);
        if (prop) {
          const recipientId = db.uuid();
          const rawToken = crypto.randomBytes(16).toString('hex');
          const actionTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
          db.execute(`
            INSERT INTO booking_request_recipients (
              id, request_id, property_id, vendor_id, delivery_status, response_status,
              expires_at, action_token_hash
            ) VALUES (?, ?, ?, ?, 'queued', 'pending', ?, ?)
          `, [recipientId, req.id, prop.id, v.id, req.expires_at, actionTokenHash]);
          addedCount++;
        }
      }
    }
  }

  console.log(`Backfill completed! Added ${addedCount} recipient records across active vendors.`);
}

runBackfill();
