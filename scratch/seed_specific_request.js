const { TripMozyDatabase } = require('../src/db/database');
const { PricingEngine } = require('../src/matching/pricing-engine');
const path = require('path');

const db = new TripMozyDatabase(path.join(__dirname, '../tripmozy.db'));

const reqId = '466cb88d-df0d-47d7-8881-f1a8cc54e49f';
const existing = db.queryOne('SELECT id FROM hotel_booking_requests WHERE id = ?', [reqId]);
if (existing) {
  console.log('Request 466cb88d-df0d-47d7-8881-f1a8cc54e49f already exists in tripmozy.db');
} else {
  const amanVendorId = '2f9816f8-f5e9-4f65-bee1-4b378133da81';
  const amanProp = db.queryOne('SELECT id FROM properties WHERE vendor_id = ? LIMIT 1', [amanVendorId]);
  const amanRoom = db.queryOne('SELECT id FROM room_types WHERE property_id = ? LIMIT 1', [amanProp.id]);

  let customer = db.queryOne('SELECT id FROM user_profiles WHERE email = ?', ['aditiyadgp86@gmail.com']);
  let customerId = customer ? customer.id : db.uuid();
  if (!customer) {
    db.execute(`
      INSERT INTO user_profiles (id, email, phone, role, display_name, status, is_phone_verified, is_email_verified)
      VALUES (?, 'aditiyadgp86@gmail.com', '+919876548016', 'customer', 'Aditya Moitra', 'active', 1, 1)
    `, [customerId]);
  }

  const recipientId = db.uuid();
  const offerId = db.uuid();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  db.execute(`
    INSERT INTO hotel_booking_requests (
      id, request_reference, customer_id, guest_name, guest_email, guest_phone,
      destination, destination_locality, check_in_date, check_out_date,
      nights, num_rooms, num_adults, num_children, children_ages,
      total_budget_paise, property_type_preference, room_preference,
      required_facilities, communication_consent, terms_accepted,
      status, max_recipients, expires_at
    ) VALUES (?, 'TM-REQ-20261106-466C', ?, 'Aditya Moitra', 'aditiyadgp86@gmail.com', '+919876548016',
      'Kashmir & North India Tour', 'Srinagar, Gulmarg & Pahalgam', '2026-12-15', '2026-12-20',
      5, 1, 2, 0, '[]',
      5000000, 'hotel', 'Deluxe Tour Package',
      '["wifi","breakfast","ac"]', 1, 1,
      'offers_available', 10, ?)
  `, [reqId, customerId, expiresAt]);

  db.execute(`
    INSERT INTO booking_request_recipients (
      id, request_id, property_id, vendor_id, delivery_status, response_status,
      expires_at, action_token_hash, responded_at
    ) VALUES (?, ?, ?, ?, 'delivered', 'accepted', ?, 'seeded_hash', datetime('now'))
  `, [recipientId, reqId, amanProp.id, amanVendorId, expiresAt]);

  const totalPaise = 4500000;
  const tourPricing = PricingEngine.calculateTourPricing(totalPaise);
  const inclusions = {
    inclusions: ['Airport Pickup & Drop', 'Private AC Vehicle for all 6 Days', 'Daily Breakfast & Dinner', 'Gulmarg Gondola & Dal Lake Shikara Ride'],
    tourPricing
  };

  db.execute(`
    INSERT INTO hotel_offers (
      id, offer_reference, request_id, property_id, recipient_id, room_type_id,
      nightly_base_paise, total_nights, total_rooms, subtotal_paise, tax_paise,
      total_payable_paise, is_budget_match, meal_plan, cancellation_terms,
      special_inclusions, status, valid_until
    ) VALUES (?, 'TM-OFF-20261106-AMAN', ?, ?, ?, ?, 900000, 5, 1, 4500000, 225000, 4500000, 1,
      'Breakfast & Dinner Included', 'Free cancellation up to 48 hours before departure',
      ?, 'valid', ?)
  `, [offerId, reqId, amanProp.id, recipientId, amanRoom.id, JSON.stringify(inclusions), expiresAt]);

  console.log('Seeded request 466cb88d-df0d-47d7-8881-f1a8cc54e49f with Aman Vishwakarma accepted offer!');
}
