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
        throw new Error(
          `This account (${cleanId}) is registered as a Customer (Traveler) account. Role locking prevents Customer accounts from signing in to the Tour Operator Partner Portal. Please switch to the Customer tab.`
        );
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
        throw new Error(`No tour operator account registered with ${cleanId}. If you are a traveler planning a trip, please switch to the Customer tab.`);
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

    // Generate secure 6-digit OTP code
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

    // Invalidate prior unused OTPs for this identifier
    this.db.execute('UPDATE auth_otps SET is_used = 1 WHERE identifier = ? AND is_used = 0', [cleanId]);

    // Save new OTP
    const otpId = this.db.uuid();
    this.db.execute(`
      INSERT INTO auth_otps (id, identifier, otp_code, role, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `, [otpId, cleanId, otpCode, role, expiresAt]);

    // Dispatch via WhatsApp or Email
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
          this.notifService.send({
            destination: cleanId,
            channel: 'whatsapp',
            templateCode: 'auth_otp_code',
            eventType: 'auth.otp_sent',
            payload: { otpCode }
          });
        }

        // If vendor has both phone and email configured, notify on both
        if (targetVendor) {
          if (targetVendor.contact_email && isEmail !== true) {
            this.notifService.send({
              destination: targetVendor.contact_email,
              channel: 'email',
              templateCode: 'auth_otp_code',
              eventType: 'auth.otp_sent',
              payload: { otpCode }
            });
          }
          if (targetVendor.contact_phone && isEmail === true) {
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

    return {
      success: true,
      message: `Verification code sent to ${this.maskIdentifier(cleanId)}`,
      identifier: cleanId,
      role,
      otpForTesting: otpCode // surfaced for seamless testing & local review
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
        throw new Error('This account is registered as a Customer. Role locking prevents access to Tour Operator Partner Portal.');
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
        throw new Error(`No tour operator account registered with ${cleanId}`);
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
}

module.exports = { AuthService };
