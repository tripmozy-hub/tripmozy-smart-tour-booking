// ============================================================================
// TripMozy Property Onboarding & Catalog Management Service
// ============================================================================

const { AccessControlError, ROLES } = require('../auth/roles');

class PropertyService {
  constructor(db) {
    this.db = db;
  }

  // Register a new vendor and associated user profile
  createVendor({ email, phone, displayName, businessName, gstin, pan, contactPerson, commissionBps = 1500, actorContext }) {
    if (actorContext && !actorContext.isAdmin()) {
      throw new AccessControlError('Only administrators can create or onboard approved vendor accounts');
    }

    return this.db.transaction((tx) => {
      const userProfileId = tx.uuid();
      tx.execute(`
        INSERT INTO user_profiles (id, email, phone, role, display_name, status, is_phone_verified, is_email_verified)
        VALUES (?, ?, ?, 'vendor', ?, 'active', 1, 1)
      `, [userProfileId, email, phone, displayName]);

      const vendorAccountId = tx.uuid();
      tx.execute(`
        INSERT INTO vendor_accounts (id, user_id, business_name, gstin, pan, contact_person, contact_phone, contact_email, verification_status, commission_rate_basis_points)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?)
      `, [vendorAccountId, userProfileId, businessName, gstin || null, pan || null, contactPerson || displayName, phone, email, commissionBps]);

      tx.logAudit({
        actorId: actorContext ? actorContext.user?.id : null,
        actorRole: actorContext ? actorContext.role : 'system',
        action: 'vendor.create',
        entityType: 'vendor_account',
        entityId: vendorAccountId,
        afterState: { businessName, email, commissionBps }
      });

      return {
        userProfileId,
        vendorAccountId,
        businessName,
        email
      };
    });
  }

  // Create property under a vendor
  createProperty({
    vendorId,
    name,
    slug,
    propertyType = 'hotel',
    starRating = 4.0,
    description = '',
    addressLine,
    city,
    state,
    pincode,
    country = 'India',
    latitude,
    longitude,
    checkInTime = '14:00',
    checkOutTime = '11:00',
    inventoryMode = 'vendor_confirmed',
    facilities = [],
    actorContext
  }) {
    if (actorContext && !actorContext.canManageProperty({ vendor_id: vendorId })) {
      throw new AccessControlError('Not authorized to create property for this vendor');
    }

    return this.db.transaction((tx) => {
      const propertyId = tx.uuid();
      const cleanSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      // Verify vendor exists
      const vendor = tx.queryOne('SELECT id, verification_status FROM vendor_accounts WHERE id = ?', [vendorId]);
      if (!vendor) {
        throw new Error(`Vendor with ID ${vendorId} not found`);
      }

      // Initial status: if created by admin and vendor verified, can be active; else under_review
      const initialStatus = actorContext?.isAdmin() ? 'active' : 'under_review';

      tx.execute(`
        INSERT INTO properties (
          id, vendor_id, name, slug, property_type, star_rating, description,
          address_line, city, state, pincode, country, latitude, longitude,
          check_in_time, check_out_time, status, inventory_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        propertyId, vendorId, name, cleanSlug, propertyType, starRating, description,
        addressLine, city, state, pincode, country, latitude, longitude,
        checkInTime, checkOutTime, initialStatus, inventoryMode
      ]);

      // Add facilities
      if (Array.isArray(facilities) && facilities.length > 0) {
        const insertFacility = tx.db.prepare(`
          INSERT OR IGNORE INTO property_facilities (id, property_id, facility_code, is_highlight)
          VALUES (?, ?, ?, ?)
        `);
        for (const code of facilities) {
          insertFacility.run(tx.uuid(), propertyId, code.toLowerCase().trim(), 1);
        }
      }

      tx.logAudit({
        actorId: actorContext ? actorContext.user?.id : null,
        actorRole: actorContext ? actorContext.role : 'system',
        action: 'property.create',
        entityType: 'property',
        entityId: propertyId,
        afterState: { name, city, initialStatus }
      });

      return {
        id: propertyId,
        vendorId,
        name,
        slug: cleanSlug,
        city,
        status: initialStatus
      };
    });
  }

  // Update property verification & active status (Admin only)
  setPropertyStatus(propertyId, newStatus, actorContext) {
    if (actorContext && !actorContext.isAdmin()) {
      throw new AccessControlError('Only administrators can approve or change property status');
    }

    const validStatuses = ['draft', 'under_review', 'active', 'suspended', 'archived'];
    if (!validStatuses.includes(newStatus)) {
      throw new Error(`Invalid property status: ${newStatus}`);
    }

    const before = this.db.queryOne('SELECT id, name, status FROM properties WHERE id = ?', [propertyId]);
    if (!before) throw new Error(`Property ${propertyId} not found`);

    this.db.execute("UPDATE properties SET status = ?, updated_at = datetime('now') WHERE id = ?", [newStatus, propertyId]);

    this.db.logAudit({
      actorId: actorContext ? actorContext.user?.id : null,
      actorRole: actorContext ? actorContext.role : 'system',
      action: 'property.status_update',
      entityType: 'property',
      entityId: propertyId,
      beforeState: { status: before.status },
      afterState: { status: newStatus }
    });

    return { id: propertyId, status: newStatus };
  }

  // Add room type & standard rate plan
  addRoomType({
    propertyId,
    name,
    bedType = 'King',
    maxAdults = 2,
    maxChildren = 1,
    totalInventory = 5,
    isAc = true,
    isAccessible = false,
    baseNightlyRatePaise,
    taxBps = 1200,
    mealPlan = 'Room Only',
    cancellationRule = 'Free cancellation up to 48 hours before check-in',
    actorContext
  }) {
    const prop = this.db.queryOne('SELECT id, vendor_id FROM properties WHERE id = ?', [propertyId]);
    if (!prop) throw new Error(`Property ${propertyId} not found`);

    if (actorContext && !actorContext.canManageProperty(prop)) {
      throw new AccessControlError('Not authorized to add rooms to this property');
    }

    return this.db.transaction((tx) => {
      const roomTypeId = tx.uuid();
      tx.execute(`
        INSERT INTO room_types (
          id, property_id, name, bed_type, max_adults, max_children,
          total_inventory, is_ac, is_accessible, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `, [roomTypeId, propertyId, name, bedType, maxAdults, maxChildren, totalInventory, isAc ? 1 : 0, isAccessible ? 1 : 0]);

      const rateId = tx.uuid();
      tx.execute(`
        INSERT INTO room_rates (
          id, room_type_id, rate_plan_name, base_nightly_rate_paise,
          tax_rate_basis_points, meal_plan, cancellation_rule, is_active
        ) VALUES (?, ?, 'Standard EP', ?, ?, ?, ?, 1)
      `, [rateId, roomTypeId, baseNightlyRatePaise, taxBps, mealPlan, cancellationRule]);

      return {
        roomTypeId,
        rateId,
        propertyId,
        name,
        baseNightlyRatePaise,
        totalInventory
      };
    });
  }

  // Populate/refresh room inventory for a date range
  setInventoryForDates({ roomTypeId, startDate, endDate, quantity, stopSell = false, actorContext }) {
    const room = this.db.queryOne(`
      SELECT rt.id, p.vendor_id
      FROM room_types rt
      JOIN properties p ON rt.property_id = p.id
      WHERE rt.id = ?
    `, [roomTypeId]);

    if (!room) throw new Error(`Room type ${roomTypeId} not found`);
    if (actorContext && !actorContext.canManageProperty(room)) {
      throw new AccessControlError('Not authorized to modify inventory for this room type');
    }

    return this.db.transaction((tx) => {
      const start = new Date(startDate);
      const end = new Date(endDate);
      const upsert = tx.db.prepare(`
        INSERT INTO room_inventory (id, room_type_id, stay_date, sellable_quantity, stop_sell, last_updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(room_type_id, stay_date) DO UPDATE SET
          sellable_quantity = excluded.sellable_quantity,
          stop_sell = excluded.stop_sell,
          last_updated_at = datetime('now')
      `);

      let daysCount = 0;
      for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        upsert.run(tx.uuid(), roomTypeId, dateStr, quantity, stopSell ? 1 : 0);
        daysCount++;
      }

      return { roomTypeId, daysUpdated: daysCount, quantity };
    });
  }

  // CSV Importer: preview, validate, deduplicate, and import properties
  processCsvImport({ csvContent, defaultVendorId, dryRun = true, actorContext }) {
    if (actorContext && !actorContext.isAdmin()) {
      throw new AccessControlError('Only administrators can import property data');
    }

    const lines = csvContent.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length < 2) {
      return { success: false, error: 'CSV file is empty or missing data rows' };
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const requiredHeaders = ['name', 'city', 'state', 'latitude', 'longitude', 'base_rate_inr'];
    const missing = requiredHeaders.filter(rh => !headers.includes(rh));

    if (missing.length > 0) {
      return { success: false, error: `Missing required CSV headers: ${missing.join(', ')}` };
    }

    const validRows = [];
    const errors = [];
    const duplicates = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      if (cols.length < headers.length) continue;

      const row = {};
      headers.forEach((h, idx) => { row[h] = cols[idx]; });

      const lineNum = i + 1;
      const rateNum = parseFloat(row.base_rate_inr);
      const lat = parseFloat(row.latitude);
      const lng = parseFloat(row.longitude);

      if (!row.name || !row.city) {
        errors.push({ line: lineNum, reason: 'Property name and city are required' });
        continue;
      }

      if (isNaN(lat) || lat < -90 || lat > 90 || isNaN(lng) || lng < -180 || lng > 180) {
        errors.push({ line: lineNum, reason: `Invalid coordinates (lat: ${row.latitude}, lng: ${row.longitude})` });
        continue;
      }

      if (isNaN(rateNum) || rateNum <= 0) {
        errors.push({ line: lineNum, reason: `Invalid base_rate_inr: ${row.base_rate_inr}` });
        continue;
      }

      const slug = row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const existing = this.db.queryOne('SELECT id, name FROM properties WHERE slug = ?', [slug]);

      if (existing) {
        duplicates.push({ line: lineNum, name: row.name, slug, existingId: existing.id });
        continue;
      }

      validRows.push({
        name: row.name,
        slug,
        propertyType: row.property_type || 'hotel',
        starRating: parseFloat(row.star_rating) || 4.0,
        addressLine: row.address || `${row.name}, ${row.city}`,
        city: row.city,
        state: row.state,
        pincode: row.pincode || '100001',
        country: 'India',
        latitude: lat,
        longitude: lng,
        baseRatePaise: Math.round(rateNum * 100),
        facilities: (row.facilities || 'wifi,parking').split(';').map(f => f.trim())
      });
    }

    if (dryRun) {
      return {
        dryRun: true,
        totalLines: lines.length - 1,
        validCount: validRows.length,
        errorCount: errors.length,
        duplicateCount: duplicates.length,
        preview: validRows.slice(0, 5),
        errors,
        duplicates
      };
    }

    // Execute import in atomic transaction
    return this.db.transaction((tx) => {
      let importedCount = 0;
      for (const row of validRows) {
        const prop = this.createProperty({
          vendorId: defaultVendorId,
          name: row.name,
          slug: row.slug,
          propertyType: row.propertyType,
          starRating: row.starRating,
          addressLine: row.addressLine,
          city: row.city,
          state: row.state,
          pincode: row.pincode,
          country: row.country,
          latitude: row.latitude,
          longitude: row.longitude,
          facilities: row.facilities,
          actorContext
        });

        // Add standard room type
        this.addRoomType({
          propertyId: prop.id,
          name: 'Standard Room',
          baseNightlyRatePaise: row.baseRatePaise,
          actorContext
        });

        importedCount++;
      }

      return {
        success: true,
        importedCount,
        errorCount: errors.length,
        duplicateCount: duplicates.length,
        errors,
        duplicates
      };
    });
  }
}

module.exports = { PropertyService };
