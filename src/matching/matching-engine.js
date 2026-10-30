// ============================================================================
// TripMozy Server-Side Hotel Matching & Geographic Filter Engine
// ============================================================================

const { PricingEngine } = require('./pricing-engine');

class MatchingEngine {
  constructor(db) {
    this.db = db;
  }

  /**
   * Great-Circle Distance via Haversine formula (km)
   */
  static haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round((R * c) * 10) / 10;
  }

  /**
   * Find and rank all eligible properties for a customer stay request
   */
  findMatches({
    destination,
    targetCoords = null,
    radiusKm = 30,
    checkInDate,
    checkOutDate,
    numRooms = 1,
    numAdults = 2,
    numChildren = 0,
    totalBudgetPaise,
    propertyType = null,
    roomPreference = 'any',
    requiredFacilities = []
  }) {
    const nights = PricingEngine.calculateNights(checkInDate, checkOutDate);

    // 1. Fetch candidate properties in destination city or nationwide if coords provided
    let properties;
    if (targetCoords && targetCoords.lat && targetCoords.lng) {
      properties = this.db.query('SELECT * FROM properties');
    } else {
      const dest = destination.trim();
      // Build a set of search terms from the destination string.
      // e.g. "North Goa, Goa" → ["North Goa, Goa", "North Goa", "Goa"]
      //      "Baga Beach, Goa" → ["Baga Beach, Goa", "Baga Beach", "Goa"]
      //      "Srinagar, Jammu and Kashmir" → ["Srinagar", "Kashmir", "Jammu"]
      const searchTerms = [dest];
      const commaParts = dest.split(',').map(s => s.trim()).filter(Boolean);
      commaParts.forEach(p => { if (!searchTerms.includes(p)) searchTerms.push(p); });
      const STOP_WORDS = new Set(['and', 'the', 'for', 'with', 'near', 'via', 'from', 'in', 'of', 'to']);
      commaParts.forEach(p => {
        p.split(/\s+/).forEach(word => {
          const clean = word.toLowerCase().trim();
          if (clean.length > 2 && !STOP_WORDS.has(clean) && !searchTerms.includes(word)) searchTerms.push(word);
        });
      });

      // Build OR conditions dynamically across city, state, and property name
      const cityEq = searchTerms.map(() => 'LOWER(city) = LOWER(?)').join(' OR ');
      const cityLike = searchTerms.map(() => 'LOWER(city) LIKE LOWER(?)').join(' OR ');
      const stateEq = searchTerms.map(() => 'LOWER(state) = LOWER(?)').join(' OR ');
      const stateLike = searchTerms.map(() => 'LOWER(state) LIKE LOWER(?)').join(' OR ');
      const nameLike = searchTerms.map(() => 'LOWER(name) LIKE LOWER(?)').join(' OR ');

      const exactParams = searchTerms;
      const likeParams = searchTerms.map(t => `%${t}%`);

      properties = this.db.query(
        `SELECT * FROM properties WHERE (${cityEq} OR ${cityLike} OR ${stateEq} OR ${stateLike} OR ${nameLike})`,
        [...exactParams, ...likeParams, ...exactParams, ...likeParams, ...likeParams]
      );

      // If no properties found matching specific terms, fall back to active properties across the platform
      if (properties.length === 0) {
        properties = this.db.query("SELECT * FROM properties WHERE status = 'active' LIMIT 10");
      }
    }

    const matches = [];
    const diagnostics = [];

    for (const prop of properties) {
      const diag = {
        propertyId: prop.id,
        name: prop.name,
        city: prop.city,
        eligible: false,
        reasons: []
      };

      // Check 1: Active status
      if (prop.status !== 'active') {
        diag.reasons.push(`Property status is '${prop.status}' (requires 'active')`);
        diagnostics.push(diag);
        continue;
      }

      // Check 2: Property type filter (intelligent matching by type, name & graceful city fallback)
      if (propertyType && propertyType !== 'any') {
        const propType = (prop.property_type || '').toLowerCase();
        const propName = (prop.name || '').toLowerCase();
        const reqType = propertyType.toLowerCase();

        const isDirectMatch = propType === reqType;
        const isNameMatch =
          (reqType === 'resort' && (propName.includes('resort') || propName.includes('spa') || propName.includes('retreat'))) ||
          (reqType === 'homestay' && (propName.includes('homestay') || propName.includes('villa') || propName.includes('cottage'))) ||
          (reqType === 'hotel' && (propType === 'hotel' || propName.includes('hotel') || propName.includes('inn') || propName.includes('residency')));

        if (!isDirectMatch && !isNameMatch) {
          // Only exclude if there are actually dedicated matching properties in this destination
          const hasMatchingTypeInCity = properties.some(p => {
            const pType = (p.property_type || '').toLowerCase();
            const pName = (p.name || '').toLowerCase();
            return pType === reqType ||
              (reqType === 'resort' && (pName.includes('resort') || pName.includes('spa') || pName.includes('retreat'))) ||
              (reqType === 'homestay' && (pName.includes('homestay') || pName.includes('villa') || pName.includes('cottage')));
          });

          if (hasMatchingTypeInCity) {
            diag.reasons.push(`Property type '${prop.property_type}' does not match requested '${propertyType}'`);
            diagnostics.push(diag);
            continue;
          }
        }
      }

      // Check 3: Geographic proximity
      let distanceKm = 0;
      if (targetCoords && targetCoords.lat && targetCoords.lng) {
        distanceKm = MatchingEngine.haversineDistance(
          targetCoords.lat, targetCoords.lng,
          prop.latitude, prop.longitude
        );
        if (distanceKm > radiusKm) {
          diag.reasons.push(`Distance ${distanceKm} km exceeds max radius ${radiusKm} km`);
          diagnostics.push(diag);
          continue;
        }
      }

      // Check 4: Required facilities
      if (requiredFacilities && requiredFacilities.length > 0) {
        const propFacs = this.db.query(`
          SELECT facility_code FROM property_facilities WHERE property_id = ?
        `, [prop.id]).map(f => f.facility_code.toLowerCase());

        const missing = requiredFacilities.filter(rf => !propFacs.includes(rf.toLowerCase()));
        if (missing.length > 0) {
          diag.reasons.push(`Missing required facilities: ${missing.join(', ')}`);
          diagnostics.push(diag);
          continue;
        }
      }

      // Check 5: Room types, capacity, rates, and inventory for every night
      const roomTypes = this.db.query(`
        SELECT rt.*, rr.base_nightly_rate_paise, rr.tax_rate_basis_points, rr.meal_plan
        FROM room_types rt
        JOIN room_rates rr ON rt.id = rr.room_type_id
        WHERE rt.property_id = ? AND rt.is_active = 1 AND rr.is_active = 1
      `, [prop.id]);

      let eligibleRoom = null;
      let roomPricing = null;
      let availableRoomWithInventory = null;

      for (const rt of roomTypes) {
        // Inventory check on every night
        const startDate = new Date(checkInDate);
        const endDate = new Date(checkOutDate);
        let inventoryAvailable = true;

        for (let d = new Date(startDate); d < endDate; d.setDate(d.getDate() + 1)) {
          const dateStr = d.toISOString().split('T')[0];
          const inv = this.db.queryOne(`
            SELECT sellable_quantity, held_quantity, booked_quantity, stop_sell
            FROM room_inventory
            WHERE room_type_id = ? AND stay_date = ?
          `, [rt.id, dateStr]);

          if (!inv) {
            // Live vendor-confirmed mode: if no date record, vendor must confirm
            if (prop.inventory_mode !== 'vendor_confirmed') {
              inventoryAvailable = false;
              break;
            }
          } else {
            const available = inv.sellable_quantity - (inv.held_quantity + inv.booked_quantity);
            if (inv.stop_sell || available < numRooms) {
              inventoryAvailable = false;
              break;
            }
          }
        }

        if (!inventoryAvailable) continue;

        // Track that this property has at least one room with available inventory (not sold out)
        if (!availableRoomWithInventory) availableRoomWithInventory = rt;

        // Room preference (AC / non-AC)
        if (roomPreference === 'ac' && !rt.is_ac) continue;
        if (roomPreference === 'non_ac' && rt.is_ac) continue;

        // Capacity check
        const totalAdultCapacity = rt.max_adults * numRooms;
        if (totalAdultCapacity < numAdults) continue;

        // Pricing check
        const pricing = PricingEngine.calculateStayPrice({
          baseNightlyRatePaise: rt.base_nightly_rate_paise,
          nights,
          numRooms,
          taxBps: rt.tax_rate_basis_points
        });

        if (PricingEngine.isWithinBudget(pricing.totalPayablePaise, totalBudgetPaise)) {
          eligibleRoom = rt;
          roomPricing = pricing;
          break; // Found suitable room
        }
      }

      // Tour package adaptability: if a room has open inventory but failed only on rigid AC, capacity or nightly rate,
      // allow active verified properties in this destination to be matched as tour operator bases (operators quote custom packages)
      if (!eligibleRoom && availableRoomWithInventory) {
        eligibleRoom = availableRoomWithInventory;
        roomPricing = PricingEngine.calculateStayPrice({
          baseNightlyRatePaise: availableRoomWithInventory.base_nightly_rate_paise,
          nights,
          numRooms,
          taxBps: availableRoomWithInventory.tax_rate_basis_points || 1200
        });
      }

      if (!eligibleRoom) {
        diag.reasons.push('No rooms meeting capacity, inventory, and budget requirements');
        diagnostics.push(diag);
        continue;
      }

      diag.eligible = true;
      diagnostics.push(diag);

      // Get cover photo
      const coverPhoto = this.db.queryOne(`
        SELECT storage_path FROM property_photos WHERE property_id = ? AND is_cover = 1
      `, [prop.id]);

      matches.push({
        property: {
          id: prop.id,
          vendorId: prop.vendor_id,
          name: prop.name,
          slug: prop.slug,
          propertyType: prop.property_type,
          starRating: prop.star_rating,
          city: prop.city,
          state: prop.state,
          addressLine: prop.address_line,
          latitude: prop.latitude,
          longitude: prop.longitude,
          distanceKm,
          isNearby: distanceKm > 5,
          coverPhoto: coverPhoto ? coverPhoto.storage_path : null
        },
        matchedRoom: {
          id: eligibleRoom.id,
          name: eligibleRoom.name,
          bedType: eligibleRoom.bed_type,
          mealPlan: eligibleRoom.meal_plan
        },
        pricing: roomPricing
      });
    }

    // Rank matches: location proximity (exact locality first), then price, then star rating
    matches.sort((a, b) => {
      if (a.property.distanceKm !== b.property.distanceKm) {
        return a.property.distanceKm - b.property.distanceKm;
      }
      if (a.pricing.totalPayablePaise !== b.pricing.totalPayablePaise) {
        return a.pricing.totalPayablePaise - b.pricing.totalPayablePaise;
      }
      return b.property.starRating - a.property.starRating;
    });

    return {
      destination,
      nights,
      numRooms,
      totalBudgetPaise,
      totalMatches: matches.length,
      matches,
      diagnostics
    };
  }
}

module.exports = { MatchingEngine };
