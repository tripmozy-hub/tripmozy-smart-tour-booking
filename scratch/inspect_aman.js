const path = require('path');
const { TripMozyDatabase } = require('../src/db/database');
const db = new TripMozyDatabase(path.join(__dirname, '../tripmozy.db'));

const email = 'amanvishwakarma8016@gmail.com';
console.log('--- USER PROFILES ---');
console.log(db.query('SELECT * FROM user_profiles WHERE LOWER(email) LIKE ?', [`%aman%`]));

console.log('--- VENDOR ACCOUNTS ---');
console.log(db.query('SELECT * FROM vendor_accounts WHERE LOWER(contact_email) LIKE ? OR LOWER(business_name) LIKE ?', [`%aman%`, `%aman%`]));

console.log('--- AUTH OTPS ---');
console.log(db.query('SELECT * FROM auth_otps WHERE LOWER(identifier) LIKE ? ORDER BY created_at DESC LIMIT 5', [`%aman%`]));

console.log('--- ALL RECENT VENDOR ACCOUNTS ---');
console.log(db.query('SELECT id, user_id, business_name, contact_email, contact_phone, created_at FROM vendor_accounts ORDER BY created_at DESC LIMIT 5'));

console.log('--- ALL RECENT USER PROFILES ---');
console.log(db.query('SELECT id, email, phone, role, display_name, created_at FROM user_profiles ORDER BY created_at DESC LIMIT 5'));
