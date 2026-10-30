// ============================================================================
// TripMozy Smart Tour Booking Marketplace - Production Server
// Serves customer booking, vendor dashboard, API endpoints & legacy trip planner
// ============================================================================

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Load environment variables from .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
}

const { TripMozyDatabase } = require('./src/db/database');
const { ROLES, SecurityContext } = require('./src/auth/roles');
const { PropertyService } = require('./src/onboarding/property-service');
const { loadCatalogIntoDb } = require('./src/onboarding/catalog-loader');
const { RequestService } = require('./src/requests/request-service');
const { VendorService } = require('./src/vendor/vendor-service');
const { InventoryHoldEngine } = require('./src/booking/inventory-hold-engine');
const { BookingService } = require('./src/booking/booking-service');
const { PaymentGatewayAdapter } = require('./src/payments/payment-gateway-adapter');
const { NotificationService } = require('./src/notifications/notification-service');
const { AdminService } = require('./src/admin/admin-service');
const { AuthService } = require('./src/auth/auth-service');

const PORT = process.env.PORT || 8080;
let DB_PATH = process.env.DATABASE_FILE || path.join(__dirname, 'tripmozy.db');

// Vercel Serverless environment handling: copy db to /tmp for writable SQLite access
if (process.env.VERCEL) {
  const tmpDb = path.join('/tmp', 'tripmozy.db');
  try {
    if (!fs.existsSync(tmpDb)) {
      const sourceDb = path.join(__dirname, 'tripmozy.db');
      if (fs.existsSync(sourceDb)) {
        fs.copyFileSync(sourceDb, tmpDb);
      }
    }
  } catch (e) {
    console.error('[TripMozy Vercel] DB copy error:', e.message);
  }
  DB_PATH = tmpDb;
}

// Initialize database
const db = new TripMozyDatabase(DB_PATH);

// Initialize services
const propService = new PropertyService(db);
const notifService = new NotificationService(db);
const authService = new AuthService(db, notifService);
const reqService = new RequestService(db, notifService);
const vendorService = new VendorService(db, notifService);
const holdEngine = new InventoryHoldEngine(db);
const bookingService = new BookingService(db);
const paymentAdapter = new PaymentGatewayAdapter(db);
const adminService = new AdminService(db);

// System Admin Context
const systemAdminContext = new SecurityContext({
  user: { id: '00000000-0000-0000-0000-000000000001', email: 'system@tripmozy.com', role: ROLES.ADMIN },
  role: ROLES.ADMIN
});

// Load verified properties catalog on startup if empty
const propCount = db.queryOne('SELECT COUNT(*) as count FROM properties').count;
if (propCount === 0) {
  const catalogCandidates = [
    path.join(__dirname, 'tripmozy_hotels.json'),
    'C:\\Users\\user\\Documents\\GitHub\\AI-TRIP-PLANNER\\tripmozy_hotels.json',
    'C:\\Users\\user\\.gemini\\antigravity\\scratch\\ai-trip-planner\\tripmozy_hotels.json'
  ];
  for (const p of catalogCandidates) {
    if (fs.existsSync(p)) {
      console.log(`[TripMozy] Onboarding verified property network from: ${p}`);
      loadCatalogIntoDb(db, p);
      break;
    }
  }
}

// Background Cron: Release expired inventory holds every 60 seconds
setInterval(() => {
  try {
    const res = holdEngine.releaseExpiredHolds();
    if (res.releasedCount > 0) {
      console.log(`[TripMozy Cron] Released ${res.releasedCount} expired inventory holds`);
    }
  } catch (err) {
    console.error('[TripMozy Cron Error]', err.message);
  }
}, 60 * 1000);

// Path to legacy trip planner assets
const TRIP_PLANNER_DIR = 'C:\\Users\\user\\Documents\\GitHub\\AI-TRIP-PLANNER';

const appHandler = (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const method = req.method;

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Helper for JSON responses
  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // Helper for HTML responses
  const sendHtml = (filePath) => {
    fs.readFile(filePath, 'utf8', (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File Not Found');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      }
    });
  };

  // Helper to read JSON request body
  const readBody = (callback) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsedData = body ? JSON.parse(body) : {};
        callback(null, parsedData);
      } catch (err) {
        callback(err);
      }
    });
  };

  // --------------------------------------------------------------------------
  // ROUTING: Customer UI & Partner Pages
  // --------------------------------------------------------------------------
  if (
    pathname === '/smart-tour-booking' ||
    pathname === '/smart-tour-booking.html'
  ) {
    sendHtml(path.join(__dirname, 'public', 'smart-tour-booking.html'));
    return;
  }

  if (pathname === '/smart-hotel-booking' || pathname === '/smart-hotel-booking.html') {
    sendHtml(path.join(__dirname, 'public', 'smart-hotel-booking.html'));
    return;
  }

  if (
    pathname === '/partner/dashboard' ||
    pathname === '/partner/requests' ||
    pathname === '/partner' ||
    pathname === '/vendor' ||
    pathname === '/vendor/dashboard' ||
    pathname === '/partner-dashboard' ||
    pathname === '/vendor-dashboard'
  ) {
    sendHtml(path.join(__dirname, 'public', 'partner-dashboard.html'));
    return;
  }

  // Common Unified Login Page (Customer & TripMozy Partner Categories)
  if (
    pathname === '/login' ||
    pathname === '/signin' ||
    pathname === '/login.html' ||
    pathname === '/customer/login' ||
    pathname === '/customer-login' ||
    pathname === '/customer-login.html' ||
    pathname === '/partner/login' ||
    pathname === '/partner-login' ||
    pathname === '/partner-login.html' ||
    pathname === '/vendor/login' ||
    pathname === '/vendor-login' ||
    pathname === '/vendor-login.html'
  ) {
    sendHtml(path.join(__dirname, 'public', 'login.html'));
    return;
  }

  // Customer Booking Portal & Stay / Tour Offers Page
  if (
    pathname === '/booking' ||
    pathname === '/booking.html' ||
    pathname === '/my-booking' ||
    pathname.startsWith('/hotel-requests')
  ) {
    sendHtml(path.join(__dirname, 'public', 'customer-booking.html'));
    return;
  }

  // --------------------------------------------------------------------------
  // ROUTING: WhatsApp 1-Click Action Portal (No Login Required)
  // Vendors tap this link in WhatsApp to Accept or Decline immediately
  // --------------------------------------------------------------------------
  if (pathname === '/action') {
    const token = reqUrl.searchParams.get('token') || '';
    const action = reqUrl.searchParams.get('action'); // 'accept' | 'reject' | null
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const recipient = db.queryOne(`
      SELECT r.*, req.request_reference, req.destination, req.check_in_date, req.check_out_date,
             req.nights, req.num_rooms, req.num_adults, req.total_budget_paise,
             p.name as property_name, p.city as property_city
      FROM booking_request_recipients r
      JOIN hotel_booking_requests req ON r.request_id = req.id
      JOIN properties p ON r.property_id = p.id
      WHERE r.action_token_hash = ?
    `, [tokenHash]);

    if (!recipient) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>TripMozy Action</title><style>body{font-family:-apple-system,sans-serif;padding:32px 16px;text-align:center;background:#f8fafc;color:#0f172a;margin:0}.card{background:#fff;border-radius:16px;padding:28px 20px;max-width:440px;margin:20px auto;box-shadow:0 10px 25px rgba(0,0,0,.08)}.badge{font-size:48px;margin-bottom:12px}h2{margin:0 0 8px;font-size:20px}p{color:#64748b;font-size:14px;line-height:1.5}</style></head><body><div class="card"><div class="badge">⚠️</div><h2>Link Expired or Invalid</h2><p>This TripMozy action link is either expired or has already been used. Please check your latest WhatsApp notification or open your Partner Portal.</p></div></body></html>`);
      return;
    }

    const budgetINR = (recipient.total_budget_paise / 100).toLocaleString('en-IN');

    // Handle instant Action: Accept
    if (action === 'accept') {
      try {
        const room = db.queryOne('SELECT rt.id FROM room_types rt JOIN room_rates rr ON rt.id = rr.room_type_id WHERE rt.property_id = ? AND rt.is_active=1 AND rr.is_active=1 LIMIT 1', [recipient.property_id]);
        const result = vendorService.acceptRequest({
          recipientId: recipient.id,
          roomTypeId: room ? room.id : null,
          customTotalPaise: recipient.total_budget_paise,
          actorContext: null
        });

        const tourP = result.tourPricing || PricingEngine.calculateTourPricing(recipient.total_budget_paise);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Quote Sent | TripMozy</title><style>body{font-family:-apple-system,sans-serif;padding:24px 16px;background:#f0fdf4;color:#0f172a;margin:0}.card{background:#fff;border-radius:16px;padding:32px 24px;max-width:440px;margin:30px auto;box-shadow:0 12px 30px rgba(0,0,0,.08);text-align:center;border-top:6px solid #10b981}.icon{font-size:52px;margin-bottom:12px}h2{color:#065f46;margin:0 0 6px;font-size:22px}.ref{font-family:monospace;font-size:12px;color:#64748b;margin-bottom:20px}.detail{background:#f8fafc;border-radius:10px;padding:16px;text-align:left;font-size:14px;margin-bottom:20px}.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #e2e8f0}.row:last-child{border:none}.lbl{color:#64748b}.val{font-weight:700}.btn{display:inline-block;background:#10b981;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:14px}</style></head><body><div class="card"><div class="icon">✅</div><h2>Tour Quote Sent to Traveler!</h2><div class="ref">${recipient.request_reference} · ${recipient.property_name}</div><div class="detail"><div class="row"><span class="lbl">Destination</span><span class="val">${recipient.destination}</span></div><div class="row"><span class="lbl">Tour Dates</span><span class="val">${recipient.check_in_date} → ${recipient.check_out_date} (${recipient.nights + 1}d / ${recipient.nights}n)</span></div><div class="row"><span class="lbl">Total Tour Package</span><span class="val" style="color:#059669">₹${tourP.totalTourINR.toLocaleString('en-IN')}</span></div><div class="row"><span class="lbl">TripMozy Advance (30% + 5% GST)</span><span class="val" style="color:#2563eb">₹${tourP.payableNowINR.toLocaleString('en-IN')}</span></div><div class="row"><span class="lbl">Remaining Balance (70%)</span><span class="val">₹${tourP.remainingBalanceINR.toLocaleString('en-IN')}</span></div><div class="row"><span class="lbl">Quote Validity</span><span class="val" style="color:#10b981">Valid for 4 Hours</span></div></div><p style="color:#64748b;font-size:13px;line-height:1.5">The customer has received your tour quote. You will receive an instant WhatsApp update when they pay the advance and confirm.</p></div></body></html>`);
        return;
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:30px;text-align:center;"><h2>Could Not Accept</h2><p>${err.message}</p></body></html>`);
        return;
      }
    }

    // Handle instant Action: Reject
    if (action === 'reject') {
      try {
        vendorService.rejectRequest({
          recipientId: recipient.id,
          reason: 'unavailable',
          note: 'Declined via WhatsApp 1-Click Action',
          actorContext: null
        });

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Request Declined | TripMozy</title><style>body{font-family:-apple-system,sans-serif;padding:24px 16px;background:#fef2f2;color:#0f172a;margin:0}.card{background:#fff;border-radius:16px;padding:32px 24px;max-width:440px;margin:30px auto;box-shadow:0 12px 30px rgba(0,0,0,.08);text-align:center;border-top:6px solid #ef4444}.icon{font-size:52px;margin-bottom:12px}h2{color:#991b1b;margin:0 0 6px;font-size:22px}.ref{font-family:monospace;font-size:12px;color:#64748b;margin-bottom:20px}p{color:#64748b;font-size:14px;line-height:1.5}</style></head><body><div class="card"><div class="icon">❌</div><h2>Tour Request Declined</h2><div class="ref">${recipient.request_reference} · ${recipient.property_name}</div><p>You have declined this tour request for <strong>${recipient.destination}</strong>. It has been removed from your active queue without affecting your partner score.</p></div></body></html>`);
        return;
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:30px;text-align:center;"><h2>Could Not Decline</h2><p>${err.message}</p></body></html>`);
        return;
      }
    }

    // Default: Show 1-Click Decision Screen (if no action param specified)
    const tourP = PricingEngine.calculateTourPricing(recipient.total_budget_paise);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>TripMozy Tour Request Alert</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#fff;padding:20px 14px;margin:0}.header{text-align:center;padding:16px 0}.brand{font-size:22px;font-weight:800;letter-spacing:-.5px}.brand span{color:#f59e0b}.card{background:#fff;color:#0f172a;border-radius:16px;padding:24px 20px;max-width:440px;margin:10px auto;box-shadow:0 15px 35px rgba(0,0,0,.25)}.badge{display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;margin-bottom:10px}.title{font-size:18px;font-weight:800;margin:0 0 4px}.hotel{color:#64748b;font-size:13px;margin-bottom:16px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;background:#f8fafc;padding:14px;border-radius:12px;margin-bottom:20px}.lbl{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase}.val{font-size:14px;font-weight:700;margin-top:2px}.val.big{color:#2563eb;font-size:18px}.actions{display:flex;flex-direction:column;gap:10px}.btn{display:block;text-align:center;text-decoration:none;padding:14px;border-radius:10px;font-size:15px;font-weight:700}.btn-acc{background:#10b981;color:#fff}.btn-rej{background:#fee2e2;color:#991b1b}</style></head><body><div class="header"><div class="brand">Trip<span>Mozy</span> Tour Partner Alert</div></div><div class="card"><div class="badge">⚡ Instant WhatsApp Action</div><div class="title">Tour Request · ${recipient.destination}</div><div class="hotel">Matched Operator / Base: ${recipient.property_name}</div><div class="grid"><div><div class="lbl">Tour Dates</div><div class="val">${recipient.check_in_date} → ${recipient.check_out_date} (${recipient.nights + 1}d / ${recipient.nights}n)</div></div><div><div class="lbl">Traveler Budget</div><div class="val big">₹${budgetINR}</div></div><div><div class="lbl">TripMozy Advance (30%+5%)</div><div class="val" style="color:#059669">₹${tourP.payableNowINR.toLocaleString('en-IN')}</div></div><div><div class="lbl">Remaining Balance (70%)</div><div class="val">₹${tourP.remainingBalanceINR.toLocaleString('en-IN')}</div></div><div><div class="lbl">Travelers & Setup</div><div class="val">${recipient.num_adults} Adults · ${recipient.num_rooms} Vehicle</div></div><div><div class="lbl">Ref ID</div><div class="val" style="font-family:monospace;font-size:12px">${recipient.request_reference}</div></div></div><div class="actions"><a href="/action?token=${token}&action=accept" class="btn btn-acc">✅ Accept &amp; Send Tour Quote (₹${budgetINR})</a><a href="/action?token=${token}&action=reject" class="btn btn-rej">❌ Decline Tour Request</a></div></div></body></html>`);
    return;
  }

  // --------------------------------------------------------------------------
  // ROUTING: REST API Endpoints
  // --------------------------------------------------------------------------
  if (pathname === '/health' && method === 'GET') {
    const metrics = adminService.getOperationalMetrics(systemAdminContext);
    sendJson(200, { status: 'healthy', version: '1.0.0', metrics });
    return;
  }

  // --------------------------------------------------------------------------
  // AUTHENTICATION & LOGIN API ENDPOINTS (Customer & Tour Operator)
  // --------------------------------------------------------------------------
  if (pathname === '/api/auth/send-otp' && method === 'POST') {
    readBody((err, body) => {
      if (err) return sendJson(400, { error: 'Invalid JSON request body' });
      try {
        const result = authService.sendOtp(body);
        sendJson(200, result);
      } catch (e) {
        sendJson(400, { error: e.message });
      }
    });
    return;
  }

  if (pathname === '/api/auth/verify-otp' && method === 'POST') {
    readBody((err, body) => {
      if (err) return sendJson(400, { error: 'Invalid JSON request body' });
      try {
        const result = authService.verifyOtp(body);
        res.setHeader('Set-Cookie', `tm_session_token=${result.sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
        sendJson(200, result);
      } catch (e) {
        sendJson(400, { error: e.message });
      }
    });
    return;
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const authHeader = req.headers['authorization'] || '';
    const cookieHeader = req.headers['cookie'] || '';
    let token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token && cookieHeader) {
      const match = cookieHeader.match(/(^|;\s*)tm_session_token=([^;]*)/);
      if (match) token = decodeURIComponent(match[2]);
    }
    const session = authService.validateSession(token);
    sendJson(200, session);
    return;
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const authHeader = req.headers['authorization'] || '';
    const cookieHeader = req.headers['cookie'] || '';
    let token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token && cookieHeader) {
      const match = cookieHeader.match(/(^|;\s*)tm_session_token=([^;]*)/);
      if (match) token = decodeURIComponent(match[2]);
    }
    authService.logout(token);
    res.setHeader('Set-Cookie', 'tm_session_token=; Path=/; HttpOnly; Max-Age=0');
    sendJson(200, { success: true, message: 'Logged out successfully' });
    return;
  }

  // Update vendor profile (phone, email, business name)
  if (pathname === '/api/vendor/profile/update' && method === 'POST') {
    readBody((err, body) => {
      if (err) return sendJson(400, { error: 'Invalid JSON' });
      try {
        const vendorId = body.vendorId;
        const updated = authService.updateVendorProfile(vendorId, body);
        sendJson(200, { success: true, vendor: updated });
      } catch (e) {
        sendJson(400, { error: e.message });
      }
    });
    return;
  }

  // Get customer's submitted tour requests and quotes
  if (pathname === '/api/customer/my-requests' && method === 'GET') {
    const identifier = reqUrl.searchParams.get('identifier') || '';
    try {
      const requests = authService.getCustomerActivity(identifier);
      sendJson(200, { success: true, requests });
    } catch (e) {
      sendJson(400, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/requests' && method === 'POST') {
    readBody((err, body) => {
      if (err) return sendJson(400, { error: 'Invalid JSON request body' });
      try {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const result = reqService.submitStayRequest({ ...body, ipAddress: ip });
        sendJson(201, result);
      } catch (e) {
        sendJson(400, { error: e.message });
      }
    });
    return;
  }

  if (pathname.startsWith('/api/requests/') && method === 'GET') {
    const id = pathname.replace('/api/requests/', '');
    const details = reqService.getRequestDetails(id);
    if (!details) return sendJson(404, { error: 'Request not found' });
    sendJson(200, details);
    return;
  }

  if (pathname.startsWith('/api/offers/') && pathname.endsWith('/hold') && method === 'POST') {
    const offerId = pathname.split('/')[3];
    readBody((err, body) => {
      if (err) return sendJson(400, { error: 'Invalid JSON' });
      const result = holdEngine.createHold({ offerId, customerId: body.customerId });
      sendJson(result.success ? 200 : 409, result);
    });
    return;
  }

  if (pathname === '/api/bookings/confirm' && method === 'POST') {
    readBody((err, body) => {
      if (err) return sendJson(400, { error: 'Invalid JSON' });
      try {
        const result = bookingService.confirmBooking(body);

        // Automated WhatsApp & Email Notification: Booking Confirmed to Customer & Vendor
        if (notifService && result.guest && result.guest.phone) {
          try {
            notifService.send({
              destination: result.guest.phone,
              channel: 'whatsapp',
              templateCode: 'booking_confirmed',
              eventType: 'booking.confirmed',
              payload: {
                bookingReference: result.bookingReference,
                propertyName: result.propertyName,
                checkInDate: result.checkInDate,
                checkOutDate: result.checkOutDate,
                totalAmountINR: result.totalAmountINR,
                advancePaidINR: result.advancePaidINR,
                remainingBalanceINR: result.remainingBalanceINR,
                remainingPaymentOption: result.remainingPaymentOption
              }
            });
          } catch (_) {}
        }

        if (notifService && result.guest && result.guest.email) {
          try {
            notifService.send({
              destination: result.guest.email,
              channel: 'email',
              templateCode: 'booking_confirmed',
              eventType: 'booking.confirmed',
              payload: {
                bookingReference: result.bookingReference,
                propertyName: result.propertyName,
                checkInDate: result.checkInDate,
                checkOutDate: result.checkOutDate,
                totalAmountINR: result.totalAmountINR,
                advancePaidINR: result.advancePaidINR,
                remainingBalanceINR: result.remainingBalanceINR,
                remainingPaymentOption: result.remainingPaymentOption
              }
            });
          } catch (_) {}
        }

        // Automated notification to Vendor via WhatsApp & Email
        if (notifService && result.bookingId) {
          try {
            const b = db.queryOne(`
              SELECT p.vendor_id, v.contact_phone, v.contact_email, v.business_name
              FROM bookings bk
              JOIN properties p ON bk.property_id = p.id
              JOIN vendor_accounts v ON p.vendor_id = v.id
              WHERE bk.id = ?
            `, [result.bookingId]);

            if (b && b.contact_phone) {
              notifService.send({
                destination: b.contact_phone,
                channel: 'whatsapp',
                templateCode: 'booking_confirmed_vendor',
                eventType: 'booking.confirmed_vendor',
                payload: {
                  bookingReference: result.bookingReference,
                  propertyName: result.propertyName,
                  checkInDate: result.checkInDate,
                  checkOutDate: result.checkOutDate,
                  totalAmountINR: result.totalAmountINR,
                  advancePaidINR: result.advancePaidINR,
                  remainingBalanceINR: result.remainingBalanceINR,
                  remainingPaymentOption: result.remainingPaymentOption,
                  guestName: result.guest ? result.guest.name : 'Traveler',
                  guestPhone: result.guest ? result.guest.phone : '',
                  dashboardUrl: `http://localhost:8080/partner/dashboard?vendorId=${b.vendor_id}`
                }
              });
            }

            if (b && b.contact_email) {
              notifService.send({
                destination: b.contact_email,
                channel: 'email',
                templateCode: 'booking_confirmed_vendor',
                eventType: 'booking.confirmed_vendor',
                payload: {
                  bookingReference: result.bookingReference,
                  propertyName: result.propertyName,
                  checkInDate: result.checkInDate,
                  checkOutDate: result.checkOutDate,
                  totalAmountINR: result.totalAmountINR,
                  advancePaidINR: result.advancePaidINR,
                  remainingBalanceINR: result.remainingBalanceINR,
                  remainingPaymentOption: result.remainingPaymentOption,
                  guestName: result.guest ? result.guest.name : 'Traveler',
                  guestPhone: result.guest ? result.guest.phone : '',
                  dashboardUrl: `http://localhost:8080/partner/dashboard?vendorId=${b.vendor_id}`
                }
              });
            }
          } catch (_) {}
        }

        sendJson(200, result);
      } catch (e) {
        sendJson(400, { error: e.message });
      }
    });
    return;
  }

  // GET /api/bookings/:id  — Retrieve confirmed booking details
  if (pathname.startsWith('/api/bookings/') && pathname !== '/api/bookings/confirm' && method === 'GET') {
    const idOrRef = pathname.replace('/api/bookings/', '');
    try {
      const booking = db.queryOne(`
        SELECT b.*, p.name as property_name, p.city as property_city, p.address_line,
               p.check_in_time, p.check_out_time, p.star_rating,
               rt.name as room_type_name,
               v.contact_phone as hotel_contact_phone, v.business_name as hotel_vendor_name
        FROM bookings b
        JOIN properties p ON b.property_id = p.id
        JOIN room_types rt ON b.room_type_id = rt.id
        JOIN vendor_accounts v ON p.vendor_id = v.id
        WHERE b.id = ? OR b.booking_reference = ?
      `, [idOrRef, idOrRef]);

      if (!booking) return sendJson(404, { error: 'Booking not found' });
      sendJson(200, { success: true, booking });
    } catch (e) {
      sendJson(500, { error: e.message });
    }
    return;
  }

  // --------------------------------------------------------------------------
  // ROUTING: Vendor API Endpoints
  // --------------------------------------------------------------------------

  // GET /api/vendor/requests?vendorId=xxx  — List all incoming requests for a vendor
  if (pathname === '/api/vendor/requests' && method === 'GET') {
    let vendorId = reqUrl.searchParams.get('vendorId');
    if (!vendorId || vendorId === 'null' || vendorId === 'undefined' || vendorId === '3dd3f50b-70ee-476c-93b9-7ae9dfad8a18') {
      vendorId = '30913fc5-870f-44a9-a077-99a5bfbd9f6e';
    }
    try {
      const requests = vendorService.getIncomingRequests(vendorId, null);
      const enriched = requests.map(r => {
        const text = notifService.generateWhatsAppText('hotel_request_received', {
          propertyName: r.property_name,
          destination: r.destination,
          checkInDate: r.check_in_date,
          checkOutDate: r.check_out_date,
          nights: r.nights,
          numAdults: r.num_adults,
          numRooms: r.num_rooms,
          totalBudgetINR: r.total_budget_inr,
          rawToken: r.recipient_id
        });
        const cleanPhone = '917478290140';
        const waLink = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}`;
        return {
          ...r,
          waDirectLink: waLink
        };
      });
      sendJson(200, { success: true, requests: enriched });
    } catch (e) {
      sendJson(400, { error: e.message });
    }
    return;
  }

  // GET /api/vendor/info?vendorId=xxx  — Get vendor and property info
  if (pathname === '/api/vendor/info' && method === 'GET') {
    let vendorId = reqUrl.searchParams.get('vendorId');
    if (!vendorId || vendorId === 'null' || vendorId === 'undefined' || vendorId === '3dd3f50b-70ee-476c-93b9-7ae9dfad8a18') {
      vendorId = '30913fc5-870f-44a9-a077-99a5bfbd9f6e';
    }
    try {
      const vendor = db.queryOne('SELECT id, business_name, contact_person, contact_email, contact_phone, verification_status, status FROM vendor_accounts WHERE id = ?', [vendorId]);
      if (!vendor) return sendJson(404, { error: 'Vendor not found' });
      const properties = db.query('SELECT id, name, city, state, property_type, star_rating, status FROM properties WHERE vendor_id = ?', [vendorId]);
      sendJson(200, { success: true, vendor, properties });
    } catch (e) {
      sendJson(400, { error: e.message });
    }
    return;
  }

  // GET /api/vendor/list  — List all vendors (for dashboard login/selection)
  if (pathname === '/api/vendor/list' && method === 'GET') {
    try {
      const vendors = db.query('SELECT id, business_name, contact_person, verification_status, status FROM vendor_accounts WHERE status = \'active\'');
      sendJson(200, { success: true, vendors });
    } catch (e) {
      sendJson(400, { error: e.message });
    }
    return;
  }

  // POST /api/vendor/recipients/:id/accept  — Accept a request (generate offer)
  if (pathname.match(/^\/api\/vendor\/recipients\/[^/]+\/accept$/) && method === 'POST') {
    const recipientId = pathname.split('/')[4];
    readBody((err, body) => {
      if (err) return sendJson(400, { error: 'Invalid JSON' });
      try {
        const recipient = db.queryOne('SELECT r.property_id, req.total_budget_paise FROM booking_request_recipients r JOIN hotel_booking_requests req ON r.request_id = req.id WHERE r.id = ?', [recipientId]);
        if (!recipient) return sendJson(404, { error: 'Recipient not found' });

        // Get the first active room type for this recipient's property if not specified
        let roomTypeId = body.roomTypeId;
        if (!roomTypeId) {
          const room = db.queryOne('SELECT rt.id FROM room_types rt JOIN room_rates rr ON rt.id = rr.room_type_id WHERE rt.property_id = ? AND rt.is_active=1 AND rr.is_active=1 LIMIT 1', [recipient.property_id]);
          if (!room) return sendJson(400, { error: 'No active room types found for this property' });
          roomTypeId = room.id;
        }

        const customTotalPaise = body.customTotalPaise || body.totalQuotePaise || (body.customNightlyRatePaise ? null : recipient.total_budget_paise);

        const result = vendorService.acceptRequest({
          recipientId,
          roomTypeId,
          customNightlyRatePaise: body.customNightlyRatePaise || null,
          customTotalPaise,
          mealPlan: body.mealPlan || 'Breakfast Included',
          actorContext: null
        });
        sendJson(200, result);
      } catch (e) {
        sendJson(400, { error: e.message });
      }
    });
    return;
  }

  // POST /api/vendor/recipients/:id/reject  — Reject a request
  if (pathname.match(/^\/api\/vendor\/recipients\/[^/]+\/reject$/) && method === 'POST') {
    const recipientId = pathname.split('/')[4];
    readBody((err, body) => {
      if (err) return sendJson(400, { error: 'Invalid JSON' });
      try {
        const result = vendorService.rejectRequest({
          recipientId,
          reason: body.reason || 'unavailable',
          note: body.note || '',
          actorContext: null
        });
        sendJson(200, result);
      } catch (e) {
        sendJson(400, { error: e.message });
      }
    });
    return;
  }

  // GET /api/notifications  — View dispatched WhatsApp, Email and SMS notifications
  if (pathname === '/api/notifications' && method === 'GET') {
    try {
      const limit = parseInt(reqUrl.searchParams.get('limit') || '20', 10);
      const rows = db.query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?', [limit]);
      sendJson(200, { success: true, count: rows.length, notifications: rows });
    } catch (e) {
      sendJson(500, { error: e.message });
    }
    return;
  }

  // --------------------------------------------------------------------------

  if (pathname === '/api/admin/metrics' && method === 'GET') {
    try {
      const metrics = adminService.getOperationalMetrics(systemAdminContext);
      sendJson(200, metrics);
    } catch (e) {
      sendJson(403, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/cron/release-holds' && method === 'POST') {
    try {
      const res = holdEngine.releaseExpiredHolds();
      sendJson(200, res);
    } catch (e) {
      sendJson(500, { error: e.message });
    }
    return;
  }

  // --------------------------------------------------------------------------
  // ROUTING: Legacy AI Trip Planner Static Assets
  // --------------------------------------------------------------------------
  let staticFile = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  let resolvedPath = path.join(__dirname, 'public', staticFile);

  if (!fs.existsSync(resolvedPath)) {
    resolvedPath = path.join(TRIP_PLANNER_DIR, staticFile);
  }

  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(resolvedPath).pipe(res);
    return;
  }

  // Fallback 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('TripMozy Page Not Found');
};

const server = http.createServer(appHandler);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(` TripMozy Smart Tour Booking Marketplace is Live!`);
    console.log(` Server running at:          http://localhost:${PORT}`);
    console.log(` Customer Tour Request Form: http://localhost:${PORT}/smart-tour-booking`);
    console.log(` Unified Sign In Portal:     http://localhost:${PORT}/login`);
    console.log(` Tour Operator Dashboard:   http://localhost:${PORT}/partner/dashboard`);
    console.log(` AI Trip Planner (Intact):   http://localhost:${PORT}/`);
    console.log(`====================================================`);
  });
}

module.exports = { server, db, appHandler };
