// ============================================================================
// TripMozy Verified Catalog Loader
// Onboards verified properties from tripmozy_hotels.json into the DB
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { PropertyService } = require('./property-service');
const { SecurityContext, ROLES } = require('../auth/roles');

// Verified coordinates mapping for primary TripMozy destinations
const DESTINATION_COORDS = {
  'Manali': { lat: 32.2396, lng: 77.1887, state: 'Himachal Pradesh' },
  'Shimla': { lat: 31.1048, lng: 77.1734, state: 'Himachal Pradesh' },
  'Dharamshala': { lat: 32.2190, lng: 76.3234, state: 'Himachal Pradesh' },
  'Dalhousie': { lat: 32.5387, lng: 75.9710, state: 'Himachal Pradesh' },
  'Goa': { lat: 15.2993, lng: 74.1240, state: 'Goa' },
  'North Goa': { lat: 15.5847, lng: 73.7438, state: 'Goa' },
  'South Goa': { lat: 15.1500, lng: 73.9800, state: 'Goa' },
  'Munnar': { lat: 10.0889, lng: 77.0595, state: 'Kerala' },
  'Alleppey': { lat: 9.4981, lng: 76.3388, state: 'Kerala' },
  'Kochi': { lat: 9.9312, lng: 76.2673, state: 'Kerala' },
  'Jaipur': { lat: 26.9124, lng: 75.7873, state: 'Rajasthan' },
  'Udaipur': { lat: 24.5854, lng: 73.7125, state: 'Rajasthan' },
  'Jodhpur': { lat: 26.2389, lng: 73.0243, state: 'Rajasthan' },
  'Jaisalmer': { lat: 26.9157, lng: 70.9083, state: 'Rajasthan' },
  'Srinagar': { lat: 34.0837, lng: 74.7973, state: 'Jammu and Kashmir' },
  'Gulmarg': { lat: 34.0484, lng: 74.3805, state: 'Jammu and Kashmir' },
  'Leh': { lat: 34.1526, lng: 77.5771, state: 'Ladakh' },
  'Rishikesh': { lat: 30.0869, lng: 78.2676, state: 'Uttarakhand' },
  'Mussoorie': { lat: 30.4598, lng: 78.0644, state: 'Uttarakhand' },
  'Nainital': { lat: 29.3803, lng: 79.4636, state: 'Uttarakhand' },
  'Ooty': { lat: 11.4102, lng: 76.6950, state: 'Tamil Nadu' },
  'Kodaikanal': { lat: 10.2381, lng: 77.4892, state: 'Tamil Nadu' },
  'Coorg': { lat: 12.3375, lng: 75.8069, state: 'Karnataka' },
  'Darjeeling': { lat: 27.0410, lng: 88.2663, state: 'West Bengal' },
  'Gangtok': { lat: 27.3389, lng: 88.6065, state: 'Sikkim' },
  'Varanasi': { lat: 25.3176, lng: 82.9739, state: 'Uttar Pradesh' },
  'Agra': { lat: 27.1767, lng: 78.0081, state: 'Uttar Pradesh' }
};

function loadCatalogIntoDb(db, jsonPath) {
  const propertyService = new PropertyService(db);
  const adminContext = new SecurityContext({
    user: { id: db.uuid(), email: 'admin@tripmozy.com', role: ROLES.ADMIN },
    role: ROLES.ADMIN
  });

  // 1. Create a Primary Verified Vendor Account for TripMozy Partner Network
  const vendor = propertyService.createVendor({
    email: 'partners@tripmozy.com',
    phone: '+919876543210',
    displayName: 'TripMozy Direct Partner Network',
    businessName: 'TripMozy Verified Hospitality Partners',
    gstin: '07AAAAA0000A1Z5',
    pan: 'AAAAA0000A',
    contactPerson: 'Partner Operations Desk',
    commissionBps: 1500,
    actorContext: adminContext
  });

  // 2. Read the 172 hotels
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Catalog JSON not found at ${jsonPath}`);
  }

  const raw = fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, '').trim();
  const hotels = JSON.parse(raw);

  let loaded = 0;
  for (const h of hotels) {
    const loc = h.location || 'Manali';
    const geo = DESTINATION_COORDS[loc] || { lat: 28.6139, lng: 77.2090, state: 'Delhi' };

    // Small jitter to simulate distinct physical street addresses in the destination
    const jitterLat = geo.lat + (Math.sin(loaded) * 0.015);
    const jitterLng = geo.lng + (Math.cos(loaded) * 0.015);

    const slug = h.url ? h.url.split('/hotel/')[1] || h.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') : h.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    const priceINR = (typeof h.price === 'number' && h.price > 0) ? h.price : 1800;
    const baseNightlyRatePaise = Math.round(priceINR * 100);

    const lowerTitle = (h.title || '').toLowerCase();
    const propType = (lowerTitle.includes('resort') || lowerTitle.includes('spa')) ? 'resort'
      : (lowerTitle.includes('homestay') || lowerTitle.includes('villa') || lowerTitle.includes('cottage')) ? 'homestay'
      : 'hotel';

    const prop = propertyService.createProperty({
      vendorId: vendor.vendorAccountId,
      name: h.title,
      slug: slug + (loaded > 0 ? `-${loaded}` : ''),
      propertyType: propType,
      starRating: typeof h.rating === 'number' ? h.rating : 4.5,
      description: `Verified TripMozy Partner Property in ${loc}, offering premium comfort, scenic surroundings, and top hospitality.`,
      addressLine: `${h.title}, ${loc}`,
      city: loc,
      state: geo.state,
      pincode: '175103',
      country: 'India',
      latitude: jitterLat,
      longitude: jitterLng,
      facilities: ['wifi', 'parking', 'ac', 'breakfast', 'mountain_view'],
      actorContext: adminContext
    });

    // Mark as active so it is immediately eligible for smart matching
    propertyService.setPropertyStatus(prop.id, 'active', adminContext);

    // Add Deluxe & Standard room types
    const room = propertyService.addRoomType({
      propertyId: prop.id,
      name: 'Deluxe Room',
      bedType: 'King',
      maxAdults: 2,
      maxChildren: 1,
      totalInventory: 6,
      baseNightlyRatePaise,
      taxBps: 1200,
      mealPlan: 'Breakfast Included',
      actorContext: adminContext
    });

    // Populate inventory for the next 90 days
    const today = new Date();
    const future = new Date();
    future.setDate(today.getDate() + 90);

    propertyService.setInventoryForDates({
      roomTypeId: room.roomTypeId,
      startDate: today.toISOString().split('T')[0],
      endDate: future.toISOString().split('T')[0],
      quantity: 6,
      actorContext: adminContext
    });

    // Store cover photo
    if (h.img) {
      db.execute(`
        INSERT INTO property_photos (id, property_id, storage_path, caption, is_cover, is_moderated)
        VALUES (?, ?, ?, ?, 1, 1)
      `, [db.uuid(), prop.id, h.img, h.title]);
    }

    loaded++;
  }

  return { vendor, totalLoaded: loaded };
}

const CORE_TOUR_OPERATORS = [
  {
    id: '2f9816f8-f5e9-4f65-bee1-4b378133da81',
    businessName: 'Aman Vishwakarma Tours & Travels',
    contactEmail: 'amanvishwakarma8016@gmail.com',
    contactPhone: '+919876548016',
    contactPerson: 'Aman Vishwakarma',
    city: 'All Destinations',
    state: 'Delhi',
    lat: 28.6139,
    lng: 77.2090,
    propertyName: 'Aman Vishwakarma Tour Fleet & Luxury Stays',
    description: 'Premier customized tour operator specializing in North & South India luxury holiday circuits.'
  },
  {
    id: '30913fc5-870f-44a9-a077-99a5bfbd9f6e',
    businessName: 'TripMozy Verified Hospitality Partners',
    contactEmail: 'partners@tripmozy.com',
    contactPhone: '+919876500001',
    contactPerson: 'TripMozy Verified Partner Desk',
    city: 'All Destinations',
    state: 'Pan-India',
    lat: 28.6139,
    lng: 77.2090,
    propertyName: 'TripMozy Central Partner Fleet',
    description: 'TripMozy verified primary hospitality and fleet partner network across 30+ destinations.'
  },
  {
    id: '3dd3f50b-70ee-476c-93b9-7ae9dfad8a18',
    businessName: 'Himalayan Tours & Travels',
    contactEmail: 'himalayan.tours@gmail.com',
    contactPhone: '+919816012345',
    contactPerson: 'Rajesh Sharma',
    city: 'Manali',
    state: 'Himachal Pradesh',
    lat: 32.2396,
    lng: 77.1887,
    propertyName: 'Himalayan Expeditions & Mountain Stays',
    description: 'Specialist Himalayan expeditions, hill station holidays, and mountain resort packages.'
  },
  {
    id: '4a123bc8-99ee-476c-83b9-7ae9dfad8a19',
    businessName: 'Goa Royal Expeditions',
    contactEmail: 'goa.expeditions@gmail.com',
    contactPhone: '+919822154321',
    contactPerson: 'Carlos Fernandes',
    city: 'Goa',
    state: 'Goa',
    lat: 15.2993,
    lng: 74.1240,
    propertyName: 'Goa Royal Coastal Stays & Fleet',
    description: 'Exclusive beach resorts, luxury catamarans, and coastal holiday tours in Goa.'
  },
  {
    id: '5b234cd9-11ff-487d-94c0-8bf0e0be9b20',
    businessName: 'Rajasthan Heritage Tours',
    contactEmail: 'rajasthan.heritage@gmail.com',
    contactPhone: '+919414098765',
    contactPerson: 'Vikram Singh Rathore',
    city: 'Jaipur',
    state: 'Rajasthan',
    lat: 26.9124,
    lng: 75.7873,
    propertyName: 'Rajasthan Heritage Haveli & Palace Stays',
    description: 'Royal desert safaris, authentic heritage havelis, and royal cultural circuits across Rajasthan.'
  },
  {
    id: '6c345de0-22aa-498e-a5d1-9cf1f1cf0c21',
    businessName: 'Kerala Backwaters Expeditions',
    contactEmail: 'kerala.backwaters@gmail.com',
    contactPhone: '+919847012345',
    contactPerson: 'Mathew Kurian',
    city: 'Alleppey',
    state: 'Kerala',
    lat: 9.4981,
    lng: 76.3388,
    propertyName: 'Kerala Backwaters Houseboats & Resorts',
    description: 'Scenic backwater cruises, luxury houseboats, and Ayurvedic wellness retreats in Kerala.'
  },
  {
    id: 'ccfdb39c-13e5-4556-9070-e763625ff970',
    businessName: 'Royal Kashmir Expeditions',
    contactEmail: 'kashmir.expeditions@gmail.com',
    contactPhone: '+919584115225',
    contactPerson: 'Farooq Ahmed',
    city: 'Srinagar',
    state: 'Jammu and Kashmir',
    lat: 34.0837,
    lng: 74.7973,
    propertyName: 'Royal Kashmir Houseboats & Alpine Stays',
    description: 'Dal Lake luxury houseboats, Gulmarg ski tours, and scenic Kashmir valley circuits.'
  }
];

function seedCoreTourOperators(db) {
  for (const op of CORE_TOUR_OPERATORS) {
    // 1. Ensure user_profile exists
    let user = db.queryOne(
      'SELECT id FROM user_profiles WHERE id = ? OR LOWER(email) = LOWER(?) LIMIT 1',
      [op.id, op.contactEmail]
    );
    let userId = user ? user.id : op.id;
    if (!user) {
      db.execute(`
        INSERT INTO user_profiles (
          id, email, phone, role, display_name, status, is_phone_verified, is_email_verified
        ) VALUES (?, ?, ?, 'vendor', ?, 'active', 1, 1)
      `, [userId, op.contactEmail, op.contactPhone, op.contactPerson]);
    } else {
      db.execute(`
        UPDATE user_profiles
        SET role = 'vendor', status = 'active', display_name = ?
        WHERE id = ?
      `, [op.contactPerson, userId]);
    }

    // 2. Ensure vendor_account exists
    let vendor = db.queryOne(
      'SELECT id FROM vendor_accounts WHERE id = ? OR LOWER(contact_email) = LOWER(?) LIMIT 1',
      [op.id, op.contactEmail]
    );
    let vendorId = vendor ? vendor.id : op.id;
    if (!vendor) {
      db.execute(`
        INSERT INTO vendor_accounts (
          id, user_id, business_name, contact_email, contact_phone, contact_person,
          verification_status, commission_rate_basis_points, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'verified', 1500, 'active')
      `, [vendorId, userId, op.businessName, op.contactEmail, op.contactPhone, op.contactPerson]);
    } else {
      db.execute(`
        UPDATE vendor_accounts
        SET business_name = ?, contact_phone = ?, contact_person = ?, verification_status = 'verified', status = 'active'
        WHERE id = ?
      `, [op.businessName, op.contactPhone, op.contactPerson, vendorId]);
    }

    // 3. Ensure property exists
    let prop = db.queryOne(
      "SELECT id FROM properties WHERE vendor_id = ? AND status = 'active' LIMIT 1",
      [vendorId]
    );
    let propId = prop ? prop.id : null;
    if (!prop) {
      propId = db.uuid();
      const slug = op.propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + vendorId.slice(0, 8);
      db.execute(`
        INSERT INTO properties (
          id, vendor_id, name, slug, property_type, star_rating,
          description, address_line, city, state, pincode, country,
          latitude, longitude, timezone, check_in_time, check_out_time,
          status, inventory_mode
        ) VALUES (?, ?, ?, ?, 'hotel', 4.8, ?, ?, ?, ?, '110001', 'India', ?, ?, 'Asia/Kolkata', '12:00', '11:00', 'active', 'vendor_confirmed')
      `, [
        propId, vendorId, op.propertyName, slug, op.description,
        `${op.propertyName}, ${op.city}`, op.city, op.state,
        op.lat || 28.6139, op.lng || 77.2090
      ]);
    }

    // 4. Ensure room type and rate exist
    let room = db.queryOne(
      'SELECT id FROM room_types WHERE property_id = ? AND is_active = 1 LIMIT 1',
      [propId]
    );
    let roomTypeId = room ? room.id : null;
    if (!room) {
      roomTypeId = db.uuid();
      db.execute(`
        INSERT INTO room_types (
          id, property_id, name, bed_type, max_adults, max_children, total_inventory,
          is_ac, is_accessible, is_active
        ) VALUES (?, ?, 'Deluxe Tour Package', 'King', 4, 2, 20, 1, 1, 1)
      `, [roomTypeId, propId]);

      const rateId = db.uuid();
      db.execute(`
        INSERT INTO room_rates (
          id, room_type_id, rate_plan_name, base_nightly_rate_paise, tax_rate_basis_points,
          meal_plan, cancellation_rule, is_active
        ) VALUES (?, ?, 'Standard Package', 350000, 500, 'Breakfast Included', 'moderate', 1)
      `, [rateId, roomTypeId]);
    }
  }
}

module.exports = { loadCatalogIntoDb, seedCoreTourOperators, CORE_TOUR_OPERATORS };
