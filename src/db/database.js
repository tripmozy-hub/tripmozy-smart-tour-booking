// ============================================================================
// TripMozy Database Client (Transactional & Audit-Aware)
// ============================================================================

let DatabaseSync = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (e) {
  // node:sqlite not available in this environment
}

const crypto = require('node:crypto');
const path = require('node:path');
const { DDL_STATEMENTS } = require('./schema');

class TripMozyDatabase {
  constructor(dbPath = ':memory:') {
    if (DatabaseSync) {
      try {
        this.db = new DatabaseSync(dbPath);
      } catch (err) {
        console.warn(`[TripMozy DB] Failed to open ${dbPath}: ${err.message}. Falling back to in-memory.`);
        this.db = new DatabaseSync(':memory:');
      }
    } else {
      console.warn('[TripMozy DB] node:sqlite is unavailable. Using safe in-memory fallback.');
      this.db = this._createFallbackDb();
    }
    this.init();
  }

  _createFallbackDb() {
    return {
      exec: () => {},
      prepare: () => ({
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () => undefined,
        all: () => []
      }),
      close: () => {}
    };
  }

  init() {
    try {
      this.db.exec(DDL_STATEMENTS);
      this.seedDefaultSettings();
    } catch (e) {
      console.warn('[TripMozy DB] Init warning:', e.message);
    }
  }

  seedDefaultSettings() {
    try {
      const systemUser = this.db.prepare(`
        INSERT OR IGNORE INTO user_profiles (id, email, role, display_name, status, is_phone_verified, is_email_verified)
        VALUES ('00000000-0000-0000-0000-000000000001', 'system@tripmozy.com', 'admin', 'TripMozy System Admin', 'active', 1, 1)
      `);
      systemUser.run();

      // Ensure Admin Profiles & Credentials
      const adminPassHash = '466748976afcd72bec8a7c9bd0a7f25033e811fec64f541e86611435b987946a'; // SHA-256 of TripMozy@Admin2026!
      const adminUsers = [
        ['admin_user_001', 'tripmozy@gmail.com', 'TripMozy Main Admin'],
        ['admin_user_002', 'admin@tripmozy.com', 'TripMozy Super Admin']
      ];

      for (const [uid, email, dName] of adminUsers) {
        this.db.prepare(`
          INSERT INTO user_profiles (id, email, role, display_name, status, is_phone_verified, is_email_verified)
          VALUES (?, ?, 'admin', ?, 'active', 1, 1)
          ON CONFLICT(email) DO UPDATE SET role = 'admin', status = 'active'
        `).run(uid, email, dName);

        this.db.prepare(`
          INSERT INTO admin_credentials (id, email, password_hash, role)
          VALUES (?, ?, ?, 'admin')
          ON CONFLICT(email) DO UPDATE SET password_hash = ?
        `).run(uid, email, adminPassHash, adminPassHash);
      }

      // Seed Default Featured Tour Cards if empty
      const cardCount = this.db.prepare('SELECT COUNT(*) as count FROM featured_tour_cards').get().count;
      if (cardCount === 0) {
        const defaultCards = [
          [
            'ftc_kashmir_01',
            'Kashmir Paradise & Dal Lake Shikara Circuit',
            'Kashmir',
            '6 Days / 5 Nights',
            5, 6, 45000,
            'Best Seller',
            'https://images.unsplash.com/photo-1595815771614-ade9d652a65d?auto=format&fit=crop&w=1200&q=80',
            'Experience the crown of India. Luxury Dal Lake houseboat stay in Srinagar, Gondola cable car ride in Gulmarg snow peaks, and Betaab Valley meadow walks in Pahalgam.',
            JSON.stringify(['Dal Lake Shikara Sunset Ride', 'Gulmarg Gondola Stage 1 & 2', 'Pahalgam Betaab Valley & Aru Valley', 'Sonamarg Glacier Excursion', 'Traditional Kashmiri Wazwan Dinner']),
            JSON.stringify(['Private Dedicated AC Vehicle', '4-Star Luxury Resort & Heritage Houseboat', 'Daily Gourmet Breakfast & Dinner', 'Airport Pickup & Drop from Srinagar Airport', '24x7 TripMozy Local Concierge']),
            1, 1
          ],
          [
            'ftc_goa_02',
            'Goa Coastal Bliss & Luxury Catamaran Escape',
            'Goa',
            '5 Days / 4 Nights',
            4, 5, 38000,
            'Trending',
            'https://images.unsplash.com/photo-1512343879784-a960bf40e7f2?auto=format&fit=crop&w=1200&q=80',
            'The ultimate beach getaway. Pristine South Goa heritage beaches, private sunset catamaran cruise on Mandovi river, North Goa cliff cafes, and luxury boutique resort stays.',
            JSON.stringify(['Private Luxury Sunset Catamaran Cruise', 'Dudhsagar Waterfalls & Spice Plantation Safari', 'Old Goa Portuguese Churches & Fontainhas Latin Quarter', 'Anjuna & Vagator Cliffside Sunset Lounge Experience']),
            JSON.stringify(['Private AC Chauffeur Vehicle Throughout', '5-Star Beach Resort with Pool & Spa', 'Daily Breakfast Buffet', 'Airport / Railway Transfers Included', 'Complimentary Water Sports Pass']),
            1, 2
          ],
          [
            'ftc_rajasthan_03',
            'Royal Rajasthan Palaces & Thar Desert Safari',
            'Rajasthan',
            '6 Days / 5 Nights',
            5, 6, 42000,
            'Royal Heritage',
            'https://images.unsplash.com/photo-1477587458883-47145ed94245?auto=format&fit=crop&w=1200&q=80',
            'Journey through the land of Maharajas. Jaipur Amer Fort & City Palace, Jodhpur Blue City & Mehrangarh Fort, and luxury desert camp under the stars in Jaisalmer Sam Sand Dunes.',
            JSON.stringify(['Amer Fort Jeep Safari', 'Mehrangarh Fort & Jaswant Thada in Jodhpur', 'Jaisalmer Thar Desert Camel Safari & Folk Dance Night', 'Luxury Desert Swiss Tent Glamping with Bonfire']),
            JSON.stringify(['Private AC SUV for Entire Rajasthan Circuit', 'Heritage Haveli & 5-Star Desert Camps', 'Daily Breakfast & Rajasthani Thali Dinners', 'Monument Fast-Track Entry Passes', 'Local Certified Heritage Guide']),
            1, 3
          ],
          [
            'ftc_kerala_04',
            'Kerala Backwaters, Houseboat & Munnar Tea Hills',
            'Kerala',
            '5 Days / 4 Nights',
            4, 5, 36000,
            'Eco Luxury',
            'https://images.unsplash.com/photo-1602216056096-3b40cc0c9944?auto=format&fit=crop&w=1200&q=80',
            'God\'s own country in style. Lush emerald tea estates in Munnar, spice plantations, and an unforgettable overnight cruise in a private AC luxury houseboat along Alleppey backwaters.',
            JSON.stringify(['Private Alleppey Backwaters Houseboat Cruise', 'Munnar Eravikulam National Park & Tea Museum', 'Mattupetty Dam & Echo Point Boating', 'Traditional Kathakali & Kalaripayattu Cultural Show']),
            JSON.stringify(['Private AC Sedan with Experienced Chauffeur', 'Luxury Tea Garden Resort & Private AC Houseboat', 'All Meals on Houseboat + Daily Breakfast at Resorts', 'Spice Plantation Guided Tour', 'Cochin Airport Pickup & Drop']),
            1, 4
          ],
          [
            'ftc_manali_05',
            'Himachal Snow Trails & Manali Solang Adventure',
            'Manali',
            '5 Days / 4 Nights',
            4, 5, 29500,
            'Adventure',
            'https://images.unsplash.com/photo-1626621341517-bbf3d9990a23?auto=format&fit=crop&w=1200&q=80',
            'Crisp mountain air and snow adventure. Rohtang Pass / Atal Tunnel scenic drive, Solang Valley paragliding & snow activities, Old Manali cafes, and riverside mountain cottage stays.',
            JSON.stringify(['Atal Tunnel & Sissu Lahaul Valley Snow Drive', 'Solang Valley Paragliding & Adventure Sports', 'Hadimba Temple & Vashisht Hot Springs', 'Jogini Waterfall Trek & Old Manali Vibe']),
            JSON.stringify(['Private AC Vehicle for all transfers & sightseeing', 'Riverside Mountain Resort with Valley Views', 'Daily Breakfast & Dinner', 'Rohtang Pass Permit Assistance', '24x7 On-Ground Support']),
            1, 5
          ]
        ];

        const cardStmt = this.db.prepare(`
          INSERT INTO featured_tour_cards (
            id, title, destination, duration, nights, days, starting_price_inr,
            badge, image_url, overview, highlights_json, inclusions_json, is_active, display_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const card of defaultCards) {
          cardStmt.run(...card);
        }
      }

      const defaults = [
        ['dispatch.first_batch_size', '10', 'Number of hotels contacted in initial request wave'],
        ['dispatch.max_properties_contacted', '25', 'Maximum properties permitted to be contacted per request'],
        ['dispatch.vendor_response_deadline_hours', '2', 'Hours hoteliers have to accept/quote before recipient expires'],
        ['booking.inventory_hold_minutes', '15', 'Duration room is held exclusively during checkout before auto-release'],
        ['policy.default_commission_bps', '1500', 'Default platform commission rate (1500 = 15.00%)']
      ];

      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO system_settings (key, value, description)
        VALUES (?, ?, ?)
      `);

      for (const [k, v, d] of defaults) {
        insert.run(k, JSON.stringify(v), d);
      }
    } catch (e) {
      console.warn('[TripMozy DB] Seed warning:', e.message);
    }
  }

  // Atomic transaction runner (supports nested/re-entrant transactions)
  transaction(fn) {
    if (this._inTransaction) {
      return fn(this);
    }
    this._inTransaction = true;
    try {
      this.db.exec('BEGIN IMMEDIATE TRANSACTION;');
    } catch (_) {}

    try {
      const result = fn(this);
      try {
        this.db.exec('COMMIT;');
      } catch (_) {}
      this._inTransaction = false;
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch (_) {
        // Transaction already aborted
      }
      this._inTransaction = false;
      throw err;
    }
  }

  // Generate standard v4 UUID
  uuid() {
    return crypto.randomUUID();
  }

  // Audit Logger
  logAudit({ actorId, actorRole, action, entityType, entityId, correlationId = null, beforeState = null, afterState = null, ipAddress = null }) {
    let validActorId = null;
    if (actorId) {
      const exists = this.queryOne('SELECT id FROM user_profiles WHERE id = ?', [actorId]);
      if (exists) {
        validActorId = actorId;
      }
    }
    if (!validActorId) {
      validActorId = '00000000-0000-0000-0000-000000000001';
    }

    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id, correlation_id, before_state, after_state, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const id = this.uuid();
    stmt.run(
      id,
      validActorId,
      actorRole || 'system',
      action,
      entityType,
      String(entityId),
      correlationId,
      beforeState ? JSON.stringify(beforeState) : null,
      afterState ? JSON.stringify(afterState) : null,
      ipAddress
    );
    return id;
  }

  // Helper for raw queries
  query(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  queryOne(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.get(...params);
  }

  execute(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.run(...params);
  }

  close() {
    this.db.close();
  }
}

module.exports = { TripMozyDatabase };
