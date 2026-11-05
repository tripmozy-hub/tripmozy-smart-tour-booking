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
    const isKnownPartner = cleanId.toLowerCase().includes('tripmozy@gmail.com') ||
                           cleanId.toLowerCase().includes('sujansutradhar2004@gmail.com');
    if (isKnownPartner) return 'vendor';

    // 2. Check vendor_accounts table (case-insensitive email + normalized phone digits)
    const vendorMatch = this.db.queryOne(`
      SELECT v.id FROM vendor_accounts v
      LEFT JOIN user_profiles u ON v.user_id = u.id
      WHERE LOWER(v.contact_email) = LOWER(?)
         OR replace(replace(replace(replace(v.contact_phone, ' ', ''), '-', ''), '+', ''), '(', '') = ?
         OR LOWER(u.email) = LOWER(?)
         OR replace(replace(replace(replace(u.phone, ' ', ''), '-', ''), '+', ''), '(', '') = ?
         OR (length(?) = 10 AND (
               replace(replace(replace(replace(v.contact_phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE ?
            OR replace(replace(replace(replace(u.phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE ?
         ))
    `, [
      cleanId, cleanDigits, cleanId, cleanDigits,
      cleanDigits, `%${cleanDigits}%`, `%${cleanDigits}%`
    ]);
    if (vendorMatch) return 'vendor';

    // 3. Check customer user_profiles
    const customerMatch = this.db.queryOne(`
      SELECT id FROM user_profiles
      WHERE (
        LOWER(email) = LOWER(?)
        OR replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '(', '') = ?
        OR (length(?) = 10 AND replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE ?)
      ) AND role = 'customer'
    `, [cleanId, cleanDigits, cleanDigits, `%${cleanDigits}%`]);
    if (customerMatch) return 'customer';

    // 4. Check general user_profiles
    const generalUser = this.db.queryOne(`
      SELECT role FROM user_profiles
      WHERE (
        LOWER(email) = LOWER(?)
        OR replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '(', '') = ?
        OR (length(?) = 10 AND replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE ?)
      )
    `, [cleanId, cleanDigits, cleanDigits, `%${cleanDigits}%`]);
    if (generalUser) return generalUser.role;

    return null; // Brand new user
  }

  // Send 6-digit OTP code to Customer or Tour Operator
  sendOtp({ identifier, email = null, phone = null, name = null, fullName = null, role = 'customer', mode = 'any', businessName = null, restoreProfile = false }) {
    const cleanId = this.normalizeIdentifier(identifier || email || phone);
    if (!cleanId) {
      throw new Error('Please enter a valid email address or mobile number');
    }

    const inputEmail = email ? this.normalizeIdentifier(email) : (cleanId && cleanId.includes('@') ? cleanId : null);
    const inputPhone = phone ? this.normalizeIdentifier(phone) : (cleanId && !cleanId.includes('@') ? cleanId : null);
    const inputName = (name || fullName || '').trim();

    const isEmail = cleanId.includes('@');
    const cleanDigits = (inputPhone || cleanId).replace(/\D/g, '').slice(-10);

    let existingRole = this.getExistingRole(cleanId);
    if (!existingRole && inputEmail) existingRole = this.getExistingRole(inputEmail);
    if (!existingRole && inputPhone) existingRole = this.getExistingRole(inputPhone);
    let autoSwitchedToLogin = false;

    // 1. If mode === 'login' (user is logging into an existing account):
    if (mode === 'login') {
      if (existingRole) {
        // Automatically adapt to the registered role (customer or vendor)
        role = existingRole;
      } else if (restoreProfile) {
        // Re-hydrate registered account into database (e.g. across serverless restarts)
        console.log(`[AuthService] Re-hydrating account for ${cleanId} (role: ${role})`);
      } else {
        const err = new Error('No account found with this Gmail address or phone number. Please sign up to create a new account.');
        err.needsSignup = true;
        err.accountExists = false;
        throw err;
      }
    }

    // 2. If mode === 'signup' (user is registering as a new user):
    // "if acc is already made then the user should automaticaly redirect to log in page"
    if (mode === 'signup' || mode === 'register') {
      if (existingRole) {
        role = existingRole;
        autoSwitchedToLogin = true;
      }
    }

    // 3. Fallback for generic requests: adopt existing role if already made
    if (mode === 'any' && existingRole) {
      role = existingRole;
    }

    // STRICT ROLE LOCKING (when explicitly requesting opposite role):
    if (existingRole && existingRole !== role && !autoSwitchedToLogin) {
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
      const isKnownPartner = cleanId.toLowerCase().includes('tripmozy@gmail.com') ||
                             cleanId.toLowerCase().includes('sujansutradhar2004@gmail.com');

      if (isKnownPartner) {
        targetVendor = this.db.queryOne("SELECT v.*, u.email as u_email, u.phone as u_phone FROM vendor_accounts v JOIN user_profiles u ON v.user_id = u.id WHERE v.id = '30913fc5-870f-44a9-a077-99a5bfbd9f6e'");
      } else {
        targetVendor = this.db.queryOne(`
          SELECT v.*, u.email as u_email, u.phone as u_phone
          FROM vendor_accounts v
          LEFT JOIN user_profiles u ON v.user_id = u.id
          WHERE LOWER(v.contact_email) = LOWER(?)
             OR replace(replace(replace(replace(v.contact_phone, ' ', ''), '-', ''), '+', ''), '(', '') = ?
             OR LOWER(u.email) = LOWER(?)
             OR replace(replace(replace(replace(u.phone, ' ', ''), '-', ''), '+', ''), '(', '') = ?
             OR (length(?) = 10 AND (
                   replace(replace(replace(replace(v.contact_phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE ?
                OR replace(replace(replace(replace(u.phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE ?
             ))
        `, [
          cleanId, cleanDigits, cleanId, cleanDigits,
          cleanDigits, `%${cleanDigits}%`, `%${cleanDigits}%`
        ]);

        if (!targetVendor && inputEmail) {
          targetVendor = this.db.queryOne(`
            SELECT v.*, u.email as u_email, u.phone as u_phone
            FROM vendor_accounts v
            LEFT JOIN user_profiles u ON v.user_id = u.id
            WHERE LOWER(v.contact_email) = LOWER(?) OR LOWER(u.email) = LOWER(?)
          `, [inputEmail, inputEmail]);
        }

        if (!targetVendor && inputPhone) {
          const inDigits = inputPhone.replace(/\D/g, '').slice(-10);
          if (inDigits.length === 10) {
            targetVendor = this.db.queryOne(`
              SELECT v.*, u.email as u_email, u.phone as u_phone
              FROM vendor_accounts v
              LEFT JOIN user_profiles u ON v.user_id = u.id
              WHERE replace(replace(replace(replace(v.contact_phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE ?
                 OR replace(replace(replace(replace(u.phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE ?
            `, [`%${inDigits}%`, `%${inDigits}%`]);
          }
        }
      }

      if (targetVendor) {
        if (inputPhone && (!targetVendor.contact_phone || targetVendor.contact_phone.includes('0001') || targetVendor.contact_phone.includes('43210'))) {
          this.db.execute("UPDATE vendor_accounts SET contact_phone = ? WHERE id = ?", [inputPhone, targetVendor.id]);
          if (targetVendor.user_id) {
            this.db.execute("UPDATE user_profiles SET phone = ? WHERE id = ?", [inputPhone, targetVendor.user_id]);
          }
          targetVendor.contact_phone = inputPhone;
        }
        if (inputEmail && (!targetVendor.contact_email || targetVendor.contact_email.includes('@tripmozy.local'))) {
          this.db.execute("UPDATE vendor_accounts SET contact_email = ? WHERE id = ?", [inputEmail, targetVendor.id]);
          if (targetVendor.user_id) {
            this.db.execute("UPDATE user_profiles SET email = ? WHERE id = ?", [inputEmail, targetVendor.user_id]);
          }
          targetVendor.contact_email = inputEmail;
        }
      } else {
        // Automatically register new vendor account & tour fleet profile so any vendor can register
        targetVendor = this.registerNewVendor({
          cleanId,
          isEmail,
          cleanDigits,
          name: inputName,
          phone: inputPhone,
          email: inputEmail,
          businessName
        });
      }
    } else {
      // Customer: find or prepare user profile
      const userEmail = inputEmail || (isEmail ? cleanId : null);
      const userPhone = inputPhone || (!isEmail ? cleanId : null);
      const displayName = inputName || (userEmail ? userEmail.split('@')[0] : 'Traveler');

      targetUser = this.db.queryOne(
        "SELECT * FROM user_profiles WHERE (email = ? OR phone = ? OR (length(?) >= 10 AND phone LIKE ?)) AND role = 'customer'",
        [userEmail || '__none__', userPhone || '__none__', cleanDigits, `%${cleanDigits}%`]
      );

      if (!targetUser) {
        // Register new customer profile permanently locked to role 'customer'
        const newId = this.db.uuid();
        this.db.execute(`
          INSERT INTO user_profiles (id, email, phone, role, display_name, status)
          VALUES (?, ?, ?, 'customer', ?, 'active')
        `, [
          newId,
          userEmail || `traveler_${cleanDigits || Date.now()}@tripmozy.local`,
          userPhone || null,
          displayName
        ]);
        targetUser = this.db.queryOne('SELECT * FROM user_profiles WHERE id = ?', [newId]);
      } else {
        if (userPhone && (!targetUser.phone || targetUser.phone === '')) {
          this.db.execute("UPDATE user_profiles SET phone = ? WHERE id = ?", [userPhone, targetUser.id]);
          targetUser.phone = userPhone;
        }
        if (userEmail && (!targetUser.email || targetUser.email.includes('@tripmozy.local'))) {
          this.db.execute("UPDATE user_profiles SET email = ? WHERE id = ?", [userEmail, targetUser.id]);
          targetUser.email = userEmail;
        }
        if (inputName && (!targetUser.display_name || targetUser.display_name === 'Traveler')) {
          this.db.execute("UPDATE user_profiles SET display_name = ? WHERE id = ?", [displayName, targetUser.id]);
          targetUser.display_name = displayName;
        }
      }
    }

    // Generate secure dynamic 6-digit OTP code (unique every time)
    const otpCode = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

    // Invalidate prior unused OTPs and record for all linked identifiers
    const linkedIds = Array.from(new Set([cleanId, inputEmail, inputPhone].filter(Boolean)));
    for (const lid of linkedIds) {
      this.db.execute('UPDATE auth_otps SET is_used = 1 WHERE identifier = ? AND is_used = 0', [lid]);
      const otpId = this.db.uuid();
      this.db.execute(`
        INSERT INTO auth_otps (id, identifier, otp_code, role, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `, [otpId, lid, otpCode, role, expiresAt]);
    }

    // Dispatch directly to user's Gmail and/or mobile phone
    if (this.notifService) {
      try {
        const targetEmail = inputEmail || (isEmail ? cleanId : null) || (targetVendor && targetVendor.contact_email && !targetVendor.contact_email.includes('@tripmozy.local') ? targetVendor.contact_email : null) || (targetUser && targetUser.email && !targetUser.email.includes('@tripmozy.local') ? targetUser.email : null);
        const targetPhone = inputPhone || (!isEmail ? cleanId : null) || (targetVendor && targetVendor.contact_phone ? targetVendor.contact_phone : null) || (targetUser && targetUser.phone ? targetUser.phone : null);

        // 1. Deliver OTP directly to Gmail / Email whenever email is provided or linked
        if (targetEmail && targetEmail.includes('@') && !targetEmail.includes('@tripmozy.local')) {
          console.log(`[AuthService] Delivering OTP ${otpCode} to Gmail: ${targetEmail}`);
          this.notifService.send({
            destination: targetEmail,
            channel: 'email',
            templateCode: 'auth_otp_code',
            eventType: 'auth.otp_sent',
            payload: { otpCode, destination: targetEmail }
          });
        }

        // 2. Deliver OTP via SMS and WhatsApp whenever mobile phone is provided
        if (targetPhone && targetPhone.replace(/\D/g, '').length >= 10) {
          console.log(`[AuthService] Delivering OTP ${otpCode} to Mobile: ${targetPhone}`);
          this.notifService.send({
            destination: targetPhone,
            channel: 'sms',
            templateCode: 'auth_otp_code',
            eventType: 'auth.otp_sent',
            payload: { otpCode }
          });
          this.notifService.send({
            destination: targetPhone,
            channel: 'whatsapp',
            templateCode: 'auth_otp_code',
            eventType: 'auth.otp_sent',
            payload: { otpCode }
          });
        }
      } catch (err) {
        console.error('[AuthService] Notification dispatch error:', err.message);
      }
    }

    const hasEmail = !!(inputEmail || isEmail);
    const primaryTarget = inputEmail || (isEmail ? cleanId : (inputPhone || cleanId));

    return {
      success: true,
      accountExists: !!existingRole,
      autoSwitchedToLogin,
      message: autoSwitchedToLogin
        ? `An account is already registered. Automatically switched to Log In. Verification code sent to ${this.maskIdentifier(primaryTarget)}.`
        : (hasEmail
            ? `Verification code sent to your Gmail (${this.maskIdentifier(primaryTarget)})`
            : `Verification code sent via SMS to ${this.maskIdentifier(primaryTarget)}`),
      identifier: primaryTarget,
      email: inputEmail || (isEmail ? cleanId : null),
      phone: inputPhone || (!isEmail ? cleanId : null),
      channel: hasEmail ? 'email' : 'sms',
      role,
      otpCode: process.env.NODE_ENV !== 'production' ? otpCode : undefined
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

    // Look up OTP - if role is provided, try that first; otherwise fall back to identifier + code
    let otpRecord = null;
    if (role) {
      otpRecord = this.db.queryOne(`
        SELECT * FROM auth_otps
        WHERE identifier = ? AND otp_code = ? AND role = ? AND is_used = 0
          AND datetime('now') <= datetime(expires_at)
        ORDER BY created_at DESC LIMIT 1
      `, [cleanId, code, role]);
    }

    if (!otpRecord) {
      otpRecord = this.db.queryOne(`
        SELECT * FROM auth_otps
        WHERE identifier = ? AND otp_code = ? AND is_used = 0
          AND datetime('now') <= datetime(expires_at)
        ORDER BY created_at DESC LIMIT 1
      `, [cleanId, code]);
    }

    if (!otpRecord) {
      throw new Error('Invalid or expired verification code. Please check and try again.');
    }

    // Adopt the role from the valid OTP record
    role = otpRecord.role;

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

    // Mark consumed
    this.db.execute('UPDATE auth_otps SET is_used = 1 WHERE id = ?', [otpRecord.id]);

    // Create session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
    const sessionId = this.db.uuid();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

    if (role === 'vendor') {
      const isKnownPartner = cleanId.toLowerCase().includes('tripmozy@gmail.com') ||
                             cleanId.toLowerCase().includes('sujansutradhar2004@gmail.com');

      let vendor = null;
      if (isKnownPartner) {
        vendor = this.db.queryOne("SELECT v.*, u.id as user_id, u.display_name FROM vendor_accounts v JOIN user_profiles u ON v.user_id = u.id WHERE v.id = '30913fc5-870f-44a9-a077-99a5bfbd9f6e'");
      } else {
        vendor = this.db.queryOne(`
          SELECT v.*, u.id as user_id, u.display_name, u.email as u_email, u.phone as u_phone
          FROM vendor_accounts v
          LEFT JOIN user_profiles u ON v.user_id = u.id
          WHERE LOWER(v.contact_email) = LOWER(?)
             OR replace(replace(replace(replace(v.contact_phone, ' ', ''), '-', ''), '+', ''), '(', '') = ?
             OR LOWER(u.email) = LOWER(?)
             OR replace(replace(replace(replace(u.phone, ' ', ''), '-', ''), '+', ''), '(', '') = ?
             OR (length(?) = 10 AND (
                   replace(replace(replace(replace(v.contact_phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE ?
                OR replace(replace(replace(replace(u.phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE ?
             ))
        `, [
          cleanId, cleanDigits, cleanId, cleanDigits,
          cleanDigits, `%${cleanDigits}%`, `%${cleanDigits}%`
        ]);
      }

      if (!vendor) {
        vendor = this.registerNewVendor({ cleanId, isEmail: cleanId.includes('@'), cleanDigits });
      }

      let sessionUserId = vendor.user_id;
      if (!sessionUserId) {
        const u = this.db.queryOne('SELECT id FROM user_profiles WHERE LOWER(email) = LOWER(?) LIMIT 1', [vendor.contact_email || cleanId]);
        if (u) {
          sessionUserId = u.id;
          this.db.execute('UPDATE vendor_accounts SET user_id = ? WHERE id = ?', [sessionUserId, vendor.id]);
        } else {
          sessionUserId = this.db.uuid();
          this.db.execute(`
            INSERT INTO user_profiles (id, email, phone, role, display_name, status)
            VALUES (?, ?, ?, 'vendor', ?, 'active')
          `, [sessionUserId, vendor.contact_email || cleanId, vendor.contact_phone || null, vendor.contact_person || 'Partner']);
          this.db.execute('UPDATE vendor_accounts SET user_id = ? WHERE id = ?', [sessionUserId, vendor.id]);
        }
      }

      this.db.execute(`
        INSERT INTO auth_sessions (id, user_id, role, token_hash, expires_at)
        VALUES (?, ?, 'vendor', ?, ?)
      `, [sessionId, sessionUserId, tokenHash, expiresAt]);

      return {
        success: true,
        sessionToken,
        token: sessionToken,
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
      let user = this.db.queryOne(
        "SELECT * FROM user_profiles WHERE (email = ? OR phone = ? OR (length(?) >= 10 AND phone LIKE ?)) AND role = 'customer'",
        [cleanId, cleanId, cleanDigits, `%${cleanDigits}%`]
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
        token: sessionToken,
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
  registerNewVendor({ cleanId, isEmail, cleanDigits, name = null, fullName = null, phone = null, email = null, businessName = null }) {
    return this.db.transaction((tx) => {
      const inputName = (name || fullName || '').trim();
      const userEmail = email || (isEmail ? cleanId : `partner_${cleanDigits || Date.now()}@tripmozy.local`);
      const userPhone = phone || (!isEmail ? cleanId : '+91 98765 43210');
      const rawName = inputName || (isEmail ? cleanId.split('@')[0] : (cleanDigits && cleanDigits.length >= 4 ? `Partner_${cleanDigits.slice(-4)}` : 'Partner'));
      const displayName = rawName.charAt(0).toUpperCase() + rawName.slice(1);

      // 1. Check if user profile already exists
      let user = tx.queryOne(`
        SELECT * FROM user_profiles
        WHERE email = ? OR phone = ? OR (length(?) >= 10 AND phone LIKE ?)
      `, [userEmail, userPhone, cleanDigits, `%${cleanDigits}%`]);

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
          userEmail.includes('@') && !userEmail.includes('@tripmozy.local') ? 1 : 0,
          userPhone && !userPhone.includes('98765 43210') ? 1 : 0
        ]);
        user = tx.queryOne('SELECT * FROM user_profiles WHERE id = ?', [userId]);
      } else {
        if (user.role !== 'vendor') {
          tx.execute("UPDATE user_profiles SET role = 'vendor' WHERE id = ?", [user.id]);
          user.role = 'vendor';
        }
        if (phone && (!user.phone || user.phone === '' || user.phone === '+91 98765 43210')) {
          tx.execute("UPDATE user_profiles SET phone = ? WHERE id = ?", [phone, user.id]);
          user.phone = phone;
        }
        if (email && (!user.email || user.email.includes('@tripmozy.local'))) {
          tx.execute("UPDATE user_profiles SET email = ? WHERE id = ?", [email, user.id]);
          user.email = email;
        }
        if (inputName && (!user.display_name || user.display_name === 'Partner' || user.display_name === 'Traveler')) {
          tx.execute("UPDATE user_profiles SET display_name = ? WHERE id = ?", [displayName, user.id]);
          user.display_name = displayName;
        }
      }

      // 2. Check if vendor account already exists for this user
      let vendor = tx.queryOne('SELECT * FROM vendor_accounts WHERE user_id = ?', [user.id]);
      if (!vendor) {
        const vendorId = tx.uuid();
        const bName = (businessName && businessName.trim()) || `${displayName} Tours & Travels`;
        const contactEmail = (userEmail || 'tripmozy@gmail.com').trim();
        // NEVER NULL: guarantees SQLite NOT NULL constraint is always satisfied
        const contactPhone = (phone || (!isEmail ? cleanId : '') || (user && user.phone) || '+91 98765 43210').trim();

        tx.execute(`
          INSERT INTO vendor_accounts (
            id, user_id, business_name, contact_person, contact_phone, contact_email,
            verification_status, commission_rate_basis_points, status
          ) VALUES (?, ?, ?, ?, ?, ?, 'verified', 1500, 'active')
        `, [
          vendorId,
          user.id,
          bName,
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
          `${bName} - Tour Fleet & Operations`,
          propSlug,
          `Verified TripMozy Tour Operator Partner (${bName}) providing premium guided tours, vehicle rentals, and customized holiday packages across India.`,
          `Partner Operations Center, ${bName}`
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

        // Add facilities & backfill active tour requests for new partner
        const defaultFacs = ['wifi', 'parking', 'breakfast', 'mountain_view', 'ac', 'sightseeing', 'cab_transfer', 'hot_water'];
        for (const f of defaultFacs) {
          tx.execute('INSERT OR IGNORE INTO property_facilities (id, property_id, facility_code) VALUES (?, ?, ?)', [tx.uuid(), propId, f]);
        }

        const activeRequests = tx.query("SELECT id, expires_at FROM hotel_booking_requests WHERE status IN ('awaiting_responses', 'offers_available') ORDER BY created_at DESC LIMIT 10");
        for (const req of activeRequests) {
          const recipientId = tx.uuid();
          const rawToken = crypto.randomBytes(16).toString('hex');
          const actionTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
          tx.execute(`
            INSERT INTO booking_request_recipients (
              id, request_id, property_id, vendor_id, delivery_status, response_status,
              expires_at, action_token_hash
            ) VALUES (?, ?, ?, ?, 'delivered', 'pending', ?, ?)
          `, [recipientId, req.id, propId, vendorId, req.expires_at, actionTokenHash]);
        }

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
