// ============================================================================
// TripMozy Pricing Engine
// Calculates exact multi-night, multi-room totals, taxes and budget checks
// ============================================================================

class PricingEngine {
  /**
   * Calculate number of nights between check-in and check-out
   */
  static calculateNights(checkInDate, checkOutDate) {
    const start = new Date(checkInDate);
    const end = new Date(checkOutDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error('Invalid check-in or check-out date format');
    }

    const diffMs = end.getTime() - start.getTime();
    const nights = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (nights <= 0) {
      throw new Error('Check-out date must be strictly after check-in date');
    }

    return nights;
  }

  /**
   * Calculate Indian GST rate based on nightly room tariff (in paise)
   * Government of India GST slabs:
   * Tariff up to ₹7,500/night: 12% (1200 basis points)
   * Tariff above ₹7,500/night: 18% (1800 basis points)
   */
  static getGstBasisPoints(nightlyRatePaise) {
    const thresholdPaise = 750000; // ₹7,500
    return nightlyRatePaise > thresholdPaise ? 1800 : 1200;
  }

  /**
   * Calculate complete total stay price for a room type across all dates
   */
  static calculateStayPrice({ baseNightlyRatePaise, nights, numRooms = 1, taxBps = null }) {
    if (baseNightlyRatePaise <= 0) {
      throw new Error('Base nightly rate must be positive');
    }
    if (nights <= 0 || numRooms <= 0) {
      throw new Error('Nights and room count must be positive');
    }

    const effectiveTaxBps = taxBps !== null ? taxBps : this.getGstBasisPoints(baseNightlyRatePaise);

    // Total base tariff before tax: nightly rate * nights * rooms
    const subtotalPaise = baseNightlyRatePaise * nights * numRooms;

    // GST calculation: (subtotal * taxBps) / 10000
    const taxPaise = Math.round((subtotalPaise * effectiveTaxBps) / 10000);

    // Total final payable price
    const totalPayablePaise = subtotalPaise + taxPaise;

    return {
      baseNightlyRatePaise,
      nights,
      numRooms,
      subtotalPaise,
      taxBps: effectiveTaxBps,
      taxPaise,
      totalPayablePaise,
      // Human-readable formatted INR
      formatted: {
        nightly: `₹${(baseNightlyRatePaise / 100).toLocaleString('en-IN')}`,
        subtotal: `₹${(subtotalPaise / 100).toLocaleString('en-IN')}`,
        tax: `₹${(taxPaise / 100).toLocaleString('en-IN')} (${(effectiveTaxBps / 100).toFixed(0)}% GST)`,
        total: `₹${(totalPayablePaise / 100).toLocaleString('en-IN')}`
      }
    };
  }

  /**
   * Verify if a property quote or rate matches the customer's total budget
   * Strictly compares total payable price (including taxes/fees) against total budget
   */
  static isWithinBudget(totalPayablePaise, totalBudgetPaise) {
    return totalPayablePaise <= totalBudgetPaise;
  }

  /**
   * Calculate 30% advance deposit with 5% GST on the advance, and 70% remaining balance
   * @param {number} totalTourPaise - Total package price in paise (e.g. 2,200,000 paise for ₹22,000)
   */
  static calculateTourPricing(totalTourPaise) {
    const total = Math.max(0, Math.round(Number(totalTourPaise) || 0));
    // 30% Base Advance
    const advanceBasePaise = Math.round(total * 0.30);
    // 5% GST strictly on the 30% advance deposit amount
    const advanceGstPaise = Math.round(advanceBasePaise * 0.05);
    // Total payable now to TripMozy Account
    const payableNowPaise = advanceBasePaise + advanceGstPaise;
    // Remaining 70% balance
    const remainingBalancePaise = total - advanceBasePaise;

    return {
      totalTourPaise: total,
      totalTourINR: total / 100,
      advanceBasePaise,
      advanceBaseINR: advanceBasePaise / 100,
      advanceGstPaise,
      advanceGstINR: advanceGstPaise / 100,
      payableNowPaise,
      payableNowINR: payableNowPaise / 100,
      remainingBalancePaise,
      remainingBalanceINR: remainingBalancePaise / 100,
      advancePercent: 30,
      gstPercent: 5,
      remainingPercent: 70,
      formatted: {
        totalTour: `₹${(total / 100).toLocaleString('en-IN')}`,
        advanceBase: `₹${(advanceBasePaise / 100).toLocaleString('en-IN')}`,
        advanceGst: `₹${(advanceGstPaise / 100).toLocaleString('en-IN')}`,
        payableNow: `₹${(payableNowPaise / 100).toLocaleString('en-IN')}`,
        remainingBalance: `₹${(remainingBalancePaise / 100).toLocaleString('en-IN')}`
      }
    };
  }
}

module.exports = { PricingEngine };
