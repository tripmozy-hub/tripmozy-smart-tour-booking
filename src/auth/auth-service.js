// ============================================================================
// TripMozy Authentication & Session Service
// Multi-channel OTP login for Customers and Verified Tour Operators
// Supports Phone (WhatsApp) & Email verification
// ============================================================================

const crypto = require('node:crypto');

class AuthService {
  constructor(db, notifService = null) {
    this.db = db;
    this.notifService = notifService;
  }

  // Normalize phone or email identifier
  normalizeIdentifier(raw) {
    if (!raw) return '';
    const str = String(raw).trim();
    if (str.includes('@')) {
      return str.toLowerCase();
    }
    // Clean phone number
    let digits = str.replace(/\D/g, '');
    if (digits.length === 10) {
      return `+91${digits}`;
    }
    if (digits.length === 12 && digits.startsWith('91')) {
      return `+${digits}`;
    }
    return str.startsWith('+') ? str : `+${digits}`;
  }

  // Mask identifier for UI display (e.g. t***y@gmail.com or +91 74782 ****0)
  maskIdentifier(idStr) {
    if (idStr.includes('@')) {
      const [user, domain] = idStr.split('@');
      const masked = user.length > 2 ? user[0] + '***' + user[user.length - 1] : user[0] + '***';
      return `${masked}@${domain}`;
    }
    if (idStr.length >= 10) {
      return idStr.slice(0, 6) + ' **** ' + idStr.slice(-2);
    }
    return idStr;
  }

  // Determine existing registered role of an identifier for Strict Role Locking
  getExistingRole(cleanId) {
    if (!cleanId) return null;
    const cleanDigits = cleanId.replace(/\D/g, '').slice(-10);

    // 1. Check known primary/verified partner credentials
    const isKnownPartner = cleanId.includes('7478290140') ||
                           cleanId.toLowerCase().includes('tripmozy@gmail.com') ||
                           cleanId.toLowerCase().includes('sujansutradhar2004@gmail.com');
    if (isKnownPartner) return 'vendor';

    // 2. Check vendor_accounts table
    const vendorMatch = this.db.queryOne(`
      SELECT v.id FROM vendor_accounts v
      JOIN user_profiles u ON v.user_id = u.id
      WHERE v.contact_email = ? OR v.contact_phone = ?
         OR u.email = ? OR u.phone = ?
         OR (length(?) >= 10 AND (v.contact_phone LIKE ? OR u.phone LIKE ?))
    `, [
      cleanId, cleanId, cleanId, cleanId,
      cleanDigits, `%${cleanDigits}%`, `%${cleanDigits}%`
    ]);
    if (vendorMatch) return 'vendor';

    // 3. Check customer user_profiles
    const customerMatch = this.db.queryOne(`
      SELECT id FROM user_profiles
      WHERE (email = ? OR phone = ? OR (length(?) >= 10 AND phone LIKE ?))
        AND role = 'customer'
    `, [cleanId, cleanId, cleanDigits, `%${cleanDigits}%`]);
    if (customerMatch) return 'customer';

    // 4. Check general user_profiles
    const generalUser = this.db.queryOne(`
      SELECT role FROM user_profiles
      WHERE email = ? OR phone = ? OR (length(?) >= 10 AND phone LIKE ?)
    `, [cleanId, cleanId, cleanDigits, `%${cleanDigits}%`]);
    if (generalUser) return generalUser.role;

    return null; // Brand new user
  }

  // Send 6-digit OTP code to Customer or Tour Operator
  sendOtp({ identifier, role = 'customer' }) {
    const cleanId = this.normalizeIdentifier(identifier);
    if (!cleanId) {
      throw new Error('Please enter a valid email address or mobile number');
    }

    const isEmail = cleanId.includes('@');
    const cleanDigits = cleanId.replace(/\D/g, '').slice(-10);
    const existingRole = this.getExistingRole(cleanId);

    // STRICT ROLE LOCKING:
    // Once an account exists as Customer or Vendor, they CANNOT log in as the opposite role
    if (existingRole && existingRole !== role) {
      if (existingRole === 'customer' && role === 'vendor') {
        const hasBookings = this.db.queryOne(`
          SELECT b.id FROM bookings b
          JOIN user_profiles u ON b.customer_id = u.id
          WHERE u.email = ? OR u.phone = ? OR (length(?) >= 10 AND u.phone LIKE ?)
        `, [cleanId, cleanId, cleanDigits, `%${cleanDigits}%`]);

        if (hasBookings) {
          throw new Error(
            `This account (${cleanId}) has confirmed traveler bookings. Role locking prevents Customer accounts with bookings from switching to the Tour Operator Partner Portal. Please switch to the Customer tab.`
          );
        } else {
          // Allow traveler without bookings to register as a Tour Operator Partner
          this.db.execute("UPDATE user_profiles SET role = 'vendor' WHERE email = ? OR phone = ?", [cleanId, cleanId]);
        }
      }
      if (existingRole === 'vendor' && role === 'customer') {
        throw new Error(
          `This account (${cleanId}) is registered as a TripMozy Tour Operator Partner account. Role locking prevents Partner accounts from signing in to the Customer Portal. Please switch to the TripMozy Partner tab.`
        );
      }
    }

    let targetVendor = null;
    let targetUser = null;

    if (role === 'vendor') {
      const isKnownPartner = cleanId.includes('7478290140') ||
                             cleanId.toLowerCase().includes('tripmozy@gmail.com') ||
                             cleanId.toLowerCase().includes('sujansutradhar2004@gmail.com');

      if (isKnownPartner) {
        targetVendor = this.db.queryOne("SELECT v.*, u.email as u_email, u.phone as u_phone FROM vendor_accounts v JOIN user_profiles u ON v.user_id = u.id WHERE v.id = '30913fc5-870f-44a9-a077-99a5bfbd9f6e'");
      } else {
        targetVendor = this.db.queryOne(`
          SELECT v.*, u.email as u_email, u.phone as u_phone
          FROM vendor_accounts v
          JOIN user_profiles u ON v.user_id = u.id
          WHERE v.contact_email = ? OR v.contact_phone = ?
             OR u.email = ? OR u.phone = ?
             OR (length(?) >= 10 AND (v.contact_phone LIKE ? OR u.phone LIKE ?))
        `, [
          cleanId, cleanId, cleanId, cleanId,
          cleanDigits, `%${cleanDigits}%`, `%${cleanDigits}%`
        ]);
      }

      if (!targetVendor) {
        // Automatically register new vendor account & tour fleet profile so any vendor can register
        targetVendor = this.registerNewVendor({ cleanId, isEmail, cleanDigits });
      }
    } else {
      // Customer: find or prepare user profile
      targetUser = this.db.queryOne(
        isEmail
          ? "SELECT * FROM user_profiles WHERE email = ? AND role = 'customer'"
          : "SELECT * FROM user_profiles WHERE phone = ? AND role = 'customer'",
        [cleanId]
      );

      if (!targetUser) {
        // Register new customer profile permanently locked to role 'customer'
        const newId = this.db.uuid();
        const displayName = isEmail ? cleanId.split('@')[0] : 'Traveler';
        this.db.execute(`
          INSERT INTO user_profiles (id, email, phone, role, display_name, status)
          VALUES (?, ?, ?, 'customer', ?, 'active')
        `, [
          newId,
          isEmail ? cleanId : `traveler_${cleanId.replace(/\D/g, '')}@tripmozy.local`,
          isEmail ? null : cleanId,
          displayName
        ]);
      }
    }

    // Generate secure dynamic 6-digit OTP code (unique every time)
    const otpCode = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

    // Invalidate prior unused OTPs for this identifier
    this.db.execute('UPDATE auth_otps SET is_used = 1 WHERE identifier = ? AND is_used = 0', [cleanId]);

    // Save new OTP
    const otpId = this.db.uuid();
    this.db.execute(`
      INSERT INTO auth_otps (id, identifier, otp_code, role, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `, [otpId, cleanId, otpCode, role, expiresAt]);

    // Dispatch directly to the exact email address or phone number entered
    if (this.notifService) {
      try {
        if (isEmail) {
          this.notifService.send({
            destination: cleanId,
            channel: 'email',
            templateCode: 'auth_otp_code',
            eventType: 'auth.otp_sent',
            payload: { otpCode }
          });
        } else {
          // 1. Dispatch OTP code directly via SMS text message
          this.notifService.send({
            destination: cleanId,
            channel: 'sms',
            templateCode: 'auth_otp_code',
            eventType: 'auth.otp_sent',
            payload: { otpCode }
          });

          // 2. Also dispatch via WhatsApp for multi-channel mobile verification
          this.notifService.send({
            destination: cleanId,
            channel: 'whatsapp',
            templateCode: 'auth_otp_code',
            eventType: 'auth.otp_sent',
            payload: { otpCode }
          });

          // 3. Also deliver to customer email if on file
          const userProf = this.db.queryOne("SELECT email FROM user_profiles WHERE phone LIKE ? AND email IS NOT NULL AND email != ''", [`%${cleanDigits}`]);
          if (userProf && userProf.email && !userProf.email.includes('@tripmozy.local')) {
            this.notifService.send({
              destination: userProf.email,
              channel: 'email',
              templateCode: 'auth_otp_code',
              eventType: 'auth.otp_sent',
              payload: { otpCode }
            });
          }
        }

        // If vendor account has linked contact email or phone, deliver there too
        if (targetVendor) {
          if (targetVendor.contact_phone && !isEmail && targetVendor.contact_phone !== cleanId) {
            this.notifService.send({
              destination: targetVendor.contact_phone,
              channel: 'sms',
              templateCode: 'auth_otp_code',
              eventType: 'auth.otp_sent',
              payload: { otpCode }
            });
          }
          if (targetVendor.contact_email && !isEmail) {
            this.notifService.send({
              destination: targetVendor.contact_email,
              channel: 'email',
              templateCode: 'auth_otp_code',
              eventType: 'auth.otp_sent',
              payload: { otpCode }
            });
          }
          if (targetVendor.contact_phone && isEmail) {
            this.notifService.send({
              destination: targetVendor.contact_phone,
              channel: 'sms',
              templateCode: 'auth_otp_code',
              eventType: 'auth.otp_sent',
              payload: { otpCode }
            });
            this.notifService.send({
              destination: targetVendor.contact_phone,
              channel: 'whatsapp',
              templateCode: 'auth_otp_code',
              eventType: 'auth.otp_sent',
              payload: { otpCode }
            });
          }
        }
      } catch (err) {
        console.error('[AuthService] Notification dispatch error:', err.message);
      }
    }

    const isSmsActive = this.notifService ? this.notifService.isSmsConfigured() : false;
    return {
      success: true,
      message: isEmail
        ? `Verification code sent to ${this.maskIdentifier(cleanId)}`
        : (isSmsActive
            ? `Verification code sent via SMS to ${this.maskIdentifier(cleanId)}`
            : `Verification code generated for ${this.maskIdentifier(cleanId)}`),
      identifier: cleanId,
      channel: isEmail ? 'email' : 'sms',
      smsGatewayConfigured: isEmail || isSmsActive,
      role,
      otpForTesting: (!isSmsActive && !isEmail) ? otpCode : undefined
    };
  }

  // Verify OTP code and establish user/vendor session
  verifyOtp({ identifier, otpCode, role = 'customer' }) {
    const cleanId = this.normalizeIdentifier(identifier);
    const code = String(otpCode || '').trim();
    const cleanDigits = cleanId.replace(/\D/g, '').slice(-10);

    if (!code || code.length !== 6) {
      throw new Error('Please enter a valid 6-digit verification code');
    }

    const existingRole = this.getExistingRole(cleanId);
    if (existingRole && existingRole !== role) {
      if (existingRole === 'customer' && role === 'vendor') {
        const hasBookings = this.db.queryOne(`
          SELECT b.id FROM bookings b
          JOIN user_profiles u ON b.customer_id = u.id
          WHERE u.email = ? OR u.phone = ? OR (length(?) >= 10 AND u.phone LIKE ?)
        `, [cleanId, cleanId, cleanDigits, `%${cleanDigits}%`]);

        if (hasBookings) {
          throw new Error('This account has confirmed bookings as a Customer. Role locking prevents access to Tour Operator Partner Portal.');
        } else {
          this.db.execute("UPDATE user_profiles SET role = 'vendor' WHERE email = ? OR phone = ?", [cleanId, cleanId]);
        }
      }
      if (existingRole === 'vendor' && role === 'customer') {
        throw new Error('This account is registered as a TripMozy Tour Operator Partner. Role locking prevents access to Customer Portal.');
      }
    }

    // Verify OTP against database
    const otpRecord = this.db.queryOne(`
      SELECT * FROM auth_otps
      WHERE identifier = ? AND otp_code = ? AND role = ? AND is_used = 0
        AND datetime('now') <= datetime(expires_at)
      ORDER BY created_at DESC LIMIT 1
    `, [cleanId, code, role]);

    if (!otpRecord) {
      throw new Error('Invalid or expired verification code. Please check and try again.');
    }

    // Mark consumed
    this.db.execute('UPDATE auth_otps SET is_used = 1 WHERE id = ?', [otpRecord.id]);

    // Create session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
    const sessionId = this.db.uuid();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

    if (role === 'vendor') {
      const isKnownPartner = cleanId.includes('7478290140') ||
                             cleanId.toLowerCase().includes('tripmozy@gmail.com') ||
                             cleanId.toLowerCase().includes('sujansutradhar2004@gmail.com');

      let vendor = null;
      if (isKnownPartner) {
        vendor = this.db.queryOne("SELECT v.*, u.id as user_id, u.display_name FROM vendor_accounts v JOIN user_profiles u ON v.user_id = u.id WHERE v.id = '30913fc5-870f-44a9-a077-99a5bfbd9f6e'");
      } else {
        vendor = this.db.queryOne(`
          SELECT v.*, u.id as user_id, u.display_name, u.email as u_email, u.phone as u_phone
          FROM vendor_accounts v
          JOIN user_profiles u ON v.user_id = u.id
          WHERE v.contact_email = ? OR v.contact_phone = ?
             OR u.email = ? OR u.phone = ?
             OR (length(?) >= 10 AND (v.contact_phone LIKE ? OR u.phone LIKE ?))
        `, [
          cleanId, cleanId, cleanId, cleanId,
          cleanDigits, `%${cleanDigits}%`, `%${cleanDigits}%`
        ]);
      }

      if (!vendor) {
        vendor = this.registerNewVendor({ cleanId, isEmail: cleanId.includes('@'), cleanDigits });
      }

      this.db.execute(`
        INSERT INTO auth_sessions (id, user_id, role, token_hash, expires_at)
        VALUES (?, ?, 'vendor', ?, ?)
      `, [sessionId, vendor.user_id, tokenHash, expiresAt]);

      return {
        success: true,
        sessionToken,
        role: 'vendor',
        vendor: {
          id: vendor.id,
          businessName: vendor.business_name,
          contactPhone: vendor.contact_phone,
          contactEmail: vendor.contact_email
        },
        redirectUrl: `/partner/dashboard?vendorId=${vendor.id}`
      };
    } else {
      // Customer
      const isEmail = cleanId.includes('@');
      let user = this.db.queryOne(
        isEmail
          ? "SELECT * FROM user_profiles WHERE email = ? AND role = 'customer'"
          : "SELECT * FROM user_profiles WHERE phone = ? AND role = 'customer'",
        [cleanId]
      );

      if (!user) {
        const userId = this.db.uuid();
        this.db.execute(`
          INSERT INTO user_profiles (id, email, phone, role, display_name, status)
          VALUES (?, ?, ?, 'customer', 'Traveler', 'active')
        `, [userId, isEmail ? cleanId : `traveler_${cleanId.replace(/\D/g, '')}@tripmozy.local`, isEmail ? null : cleanId]);
        user = this.db.queryOne('SELECT * FROM user_profiles WHERE id = ?', [userId]);
      }

      this.db.execute(`
        INSERT INTO auth_sessions (id, user_id, role, token_hash, expires_at)
        VALUES (?, ?, 'customer', ?, ?)
      `, [sessionId, user.id, tokenHash, expiresAt]);

      return {
        success: true,
        sessionToken,
        role: 'customer',
        user: {
          id: user.id,
          displayName: user.display_name,
          email: user.email,
          phone: user.phone
        },
        redirectUrl: '/booking'
      };
    }
  }

  // Validate session token from Cookie or Bearer header
  validateSession(token) {
    if (!token) return { authenticated: false };
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const session = this.db.queryOne(`
      SELECT s.*, u.email, u.phone, u.display_name, u.role as user_role,
             v.id as vendor_id, v.business_name, v.contact_phone, v.contact_email
      FROM auth_sessions s
      JOIN user_profiles u ON s.user_id = u.id
      LEFT JOIN vendor_accounts v ON u.id = v.user_id
      WHERE s.token_hash = ? AND datetime('now') <= datetime(s.expires_at)
    `, [tokenHash]);

    if (!session) return { authenticated: false };

    return {
      authenticated: true,
      role: session.role,
      user: {
        id: session.user_id,
        email: session.email,
        phone: session.phone,
        displayName: session.display_name
      },
      vendorId: session.vendor_id || null,
      vendor: session.vendor_id ? {
        id: session.vendor_id,
        businessName: session.business_name,
        contactPhone: session.contact_phone,
        contactEmail: session.contact_email
      } : null
    };
  }

  // Invalidate session
  logout(token) {
    if (!token) return true;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    this.db.execute('DELETE FROM auth_sessions WHERE token_hash = ?', [tokenHash]);
    return true;
  }

  // Update vendor profile (phone or email)
  updateVendorProfile(vendorId, { contactPhone, contactEmail, businessName }) {
    return this.db.transaction((tx) => {
      const v = tx.queryOne('SELECT * FROM vendor_accounts WHERE id = ?', [vendorId]);
      if (!v) throw new Error('Vendor account not found');

      const updates = [];
      const params = [];

      if (contactPhone) {
        const cleanPhone = this.normalizeIdentifier(contactPhone);
        updates.push('contact_phone = ?');
        params.push(cleanPhone);
        tx.execute('UPDATE user_profiles SET phone = ? WHERE id = ?', [cleanPhone, v.user_id]);
      }

      if (contactEmail) {
        const cleanEmail = contactEmail.trim().toLowerCase();
        updates.push('contact_email = ?');
        params.push(cleanEmail);
        tx.execute('UPDATE user_profiles SET email = ? WHERE id = ?', [cleanEmail, v.user_id]);
      }

      if (businessName) {
        updates.push('business_name = ?');
        params.push(businessName.trim());
      }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        params.push(vendorId);
        tx.execute(`UPDATE vendor_accounts SET ${updates.join(', ')} WHERE id = ?`, params);
      }

      return tx.queryOne('SELECT * FROM vendor_accounts WHERE id = ?', [vendorId]);
    });
  }

  // Retrieve customer's active requests and bookings
  getCustomerActivity(userIdentifier) {
    const cleanId = this.normalizeIdentifier(userIdentifier);
    const requests = this.db.query(`
      SELECT req.*, 
             (SELECT COUNT(*) FROM hotel_offers o WHERE o.request_id = req.id AND o.status = 'valid') as valid_offers_count,
             (SELECT b.id FROM bookings b WHERE b.request_id = req.id LIMIT 1) as booking_id,
             (SELECT b.booking_reference FROM bookings b WHERE b.request_id = req.id LIMIT 1) as booking_reference
      FROM hotel_booking_requests req
      WHERE req.guest_email = ? OR req.guest_phone = ? OR req.customer_id = ?
      ORDER BY req.created_at DESC
      LIMIT 20
    `, [cleanId, cleanId, cleanId]);

    return requests;
  }

  // Register a new Tour Operator Partner account and initial nationwide tour fleet profile
  registerNewVendor({ cleanId, isEmail, cleanDigits }) {
    return this.db.transaction((tx) => {
      // 1. Check if user profile already exists
      let user = tx.queryOne(`
        SELECT * FROM user_profiles
        WHERE email = ? OR phone = ? OR (length(?) >= 10 AND phone LIKE ?)
      `, [cleanId, cleanId, cleanDigits, `%${cleanDigits}%`]);

      const rawName = isEmail ? cleanId.split('@')[0] : (cleanDigits && cleanDigits.length >= 4 ? `Partner_${cleanDigits.slice(-4)}` : 'Partner');
      const displayName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
      const userEmail = isEmail ? cleanId : `partner_${cleanDigits || Date.now()}@tripmozy.local`;
      const userPhone = isEmail ? null : cleanId;

      if (!user) {
        const userId = tx.uuid();
        tx.execute(`
          INSERT INTO user_profiles (id, email, phone, role, display_name, status, is_email_verified, is_phone_verified)
          VALUES (?, ?, ?, 'vendor', ?, 'active', ?, ?)
        `, [
          userId,
          userEmail,
          userPhone,
          displayName,
          isEmail ? 1 : 0,
          isEmail ? 0 : 1
        ]);
        user = tx.queryOne('SELECT * FROM user_profiles WHERE id = ?', [userId]);
      } else if (user.role !== 'vendor') {
        tx.execute("UPDATE user_profiles SET role = 'vendor' WHERE id = ?", [user.id]);
        user.role = 'vendor';
      }

      // 2. Check if vendor account already exists for this user
      let vendor = tx.queryOne('SELECT * FROM vendor_accounts WHERE user_id = ?', [user.id]);
      if (!vendor) {
        const vendorId = tx.uuid();
        const businessName = `${displayName} Tours & Travels`;
        const contactEmail = isEmail ? cleanId : (user.email && !user.email.includes('@tripmozy.local') ? user.email : 'tripmozy@gmail.com');
        const contactPhone = !isEmail ? cleanId : (user.phone || '+917478290140');

        tx.execute(`
          INSERT INTO vendor_accounts (
            id, user_id, business_name, contact_person, contact_phone, contact_email,
            verification_status, commission_rate_basis_points, status
          ) VALUES (?, ?, ?, ?, ?, ?, 'verified', 1500, 'active')
        `, [
          vendorId,
          user.id,
          businessName,
          displayName,
          contactPhone,
          contactEmail
        ]);

        // 3. Create initial nationwide tour fleet profile for marketplace matching
        const propId = tx.uuid();
        const slugPrefix = (cleanDigits && cleanDigits.length >= 4) ? cleanDigits : (cleanId.split('@')[0].replace(/[^a-zA-Z0-9]/g, '') || 'tour');
        const propSlug = `partner-${slugPrefix.toLowerCase()}-${Date.now()}`;

        tx.execute(`
          INSERT INTO properties (
            id, vendor_id, name, slug, property_type, star_rating,
            description, address_line, city, state, pincode, country,
            latitude, longitude, timezone, check_in_time, check_out_time,
            status, inventory_mode
          ) VALUES (?, ?, ?, ?, 'hotel', 4.8, ?, ?, 'All Destinations', 'India', '110001', 'India', 28.6139, 77.2090, 'Asia/Kolkata', '12:00', '11:00', 'active', 'vendor_confirmed')
        `, [
          propId,
          vendorId,
          `${businessName} - Tour Fleet & Operations`,
          propSlug,
          `Verified TripMozy Tour Operator Partner (${businessName}) providing premium guided tours, vehicle rentals, and customized holiday packages across India.`,
          `Partner Operations Center, ${businessName}`
        ]);

        const roomTypeId = tx.uuid();
        tx.execute(`
          INSERT INTO room_types (
            id, property_id, name, bed_type, max_adults, max_children, total_inventory, is_ac, is_active
          ) VALUES (?, ?, 'Custom Tour Package', 'Tour Vehicle + Hotel', 10, 5, 20, 1, 1)
        `, [roomTypeId, propId]);

        const rateId = tx.uuid();
        tx.execute(`
          INSERT INTO room_rates (
            id, room_type_id, rate_plan_name, base_nightly_rate_paise, tax_rate_basis_points, meal_plan, cancellation_rule, is_active
          ) VALUES (?, ?, 'All Inclusions Tour Plan', 250000, 500, 'Breakfast, Dinner & Sightseeing', 'Free cancellation up to 48 hours before tour start', 1)
        `, [rateId, roomTypeId]);

        vendor = tx.queryOne('SELECT * FROM vendor_accounts WHERE id = ?', [vendorId]);
      }

      return tx.queryOne(`
        SELECT v.*, u.email as u_email, u.phone as u_phone, u.display_name
        FROM vendor_accounts v
        JOIN user_profiles u ON v.user_id = u.id
        WHERE v.id = ?
      `, [vendor.id]);
    });
  }
}

module.exports = { AuthService };
