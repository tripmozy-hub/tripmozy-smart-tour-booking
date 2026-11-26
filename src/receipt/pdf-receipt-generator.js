// ============================================================================
// TripMozy Pure Vector PDF Receipt & Escrow Tax Invoice Generator
// Zero external dependencies (valid PDF 1.4 with monospaced tabular columns)
// ============================================================================

const PricingEngine = require('../matching/pricing-engine');

/**
 * Sanitize string into clean 7-bit printable ASCII for PDF Type-1 core fonts
 * and compute-exact byte offsets in xref table.
 */
function toPdfAscii(val, fallback = '-') {
  if (val === null || val === undefined || val === '') return fallback;
  let str = String(val)
    .replace(/₹/g, 'Rs. ')
    .replace(/→|➜|➝/g, ' -> ')
    .replace(/[•·]/g, ' | ')
    .replace(/[—–]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\r?\n+/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return str || fallback;
}

function escapePdfStr(val) {
  return toPdfAscii(val, '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function truncateStr(str, maxLen) {
  const s = toPdfAscii(str, '-');
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(1, maxLen - 3)).trim() + '...';
}

function wrapLines(text, maxChars, maxLines = 2) {
  const clean = toPdfAscii(text, '-');
  const words = clean.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if ((cur + ' ' + w).length <= maxChars) {
      cur += ' ' + w;
    } else {
      lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.length > 1) {
    const joined = lines.join(' ');
    if (joined.length < clean.length) {
      lines[maxLines - 1] = truncateStr(lines[maxLines - 1], maxChars);
    }
  }
  return lines;
}

function fmtDateAscii(isoDate) {
  if (!isoDate) return '-';
  const datePart = String(isoDate).split('T')[0];
  const parts = datePart.split('-');
  if (parts.length !== 3) return toPdfAscii(isoDate);
  const [y, m, d] = parts;
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIdx = parseInt(m, 10) - 1;
  return `${parseInt(d, 10)} ${M[monthIdx] || m} ${y}`;
}

function fmtInrAscii(amount) {
  const num = Math.round(Number(amount) || 0);
  return 'Rs. ' + num.toLocaleString('en-IN');
}

function rgbFill(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`;
}

function rgbStroke(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`;
}

/**
 * Normalize requestDetails (`getRequestDetails(id, true)`) into structured receipt payload
 */
function buildReceiptModel(details) {
  if (!details || !details.request) {
    throw new Error('Request details required to generate receipt');
  }

  const req = details.request;
  const offers = details.offers || [];
  const firstOffer = offers[0] || null;
  const b = details.booking || null;

  let terms = {};
  if (b && b.terms_snapshot) {
    if (typeof b.terms_snapshot === 'string') {
      try { terms = JSON.parse(b.terms_snapshot); } catch (_) {}
    } else if (typeof b.terms_snapshot === 'object') {
      terms = b.terms_snapshot;
    }
  }

  const totalPaise = (b && b.total_amount_paise) || (firstOffer && firstOffer.total_payable_paise) || req.total_budget_paise || 0;
  const pricing = terms.tourPricing || (firstOffer && firstOffer.tourPricing) || PricingEngine.calculateTourPricing(totalPaise);

  const totalTourINR = pricing.totalTourINR ?? Math.round(totalPaise / 100);
  const advancePaidINR = pricing.payableNowINR ?? Math.round(totalTourINR * 0.315);
  const advanceBaseINR = terms.advanceBaseINR || pricing.advanceBaseINR || Math.round(advancePaidINR / 1.05);
  const advanceGstINR = terms.advanceGstINR || pricing.advanceGstINR || Math.max(0, advancePaidINR - advanceBaseINR);
  const remainingBalanceINR = pricing.remainingBalanceINR ?? Math.max(0, totalTourINR - advanceBaseINR);

  const vendorSnap = terms.vendorSnapshot || {};
  const vendorName =
    (b && b.vendor && b.vendor.businessName) ||
    vendorSnap.businessName ||
    (b && b.vendor_business_name) ||
    (firstOffer && firstOffer.vendor && firstOffer.vendor.businessName) ||
    (firstOffer && (firstOffer.vendor_business_name || firstOffer.property_name)) ||
    (b && b.property_name) ||
    'TripMozy Verified Tour Operator';

  const vendorPhone =
    (b && b.vendor && b.vendor.contactPhone) ||
    vendorSnap.contactPhone ||
    (b && b.vendor_contact_phone) ||
    (firstOffer && firstOffer.vendor && firstOffer.vendor.contactPhone) ||
    (firstOffer && firstOffer.vendor_contact_phone) ||
    '+91 98765 43210';

  const vendorEmail =
    (b && b.vendor && b.vendor.contactEmail) ||
    vendorSnap.contactEmail ||
    (b && b.vendor_contact_email) ||
    (firstOffer && firstOffer.vendor && firstOffer.vendor.contactEmail) ||
    (firstOffer && firstOffer.vendor_contact_email) ||
    'partners@tripmozy.com';

  const vendorContactPerson =
    (b && b.vendor && b.vendor.contactPerson) ||
    vendorSnap.contactPerson ||
    (b && b.vendor_contact_person) ||
    (firstOffer && firstOffer.vendor && firstOffer.vendor.contactPerson) ||
    (firstOffer && firstOffer.vendor_contact_person) ||
    'Tour Manager';

  const reqRef = req.request_reference || req.id || 'TM-REQ';
  const bookingRef = (b && b.booking_reference) || reqRef;
  const invoiceNumber = `TM-INV-${String(reqRef).replace(/^TM-REQ-/, '')}`;
  const paymentReference = terms.paymentReference || (b && b.payment_reference) || 'DIRECT_VERIFIED';
  const confirmedAtIso = terms.confirmedAt || (b && b.created_at) || new Date().toISOString();
  const isOnlineBalance = terms.remainingPaymentOption === 'tripmozy_online';
  const mealPlan = terms.mealPlan || (firstOffer && firstOffer.meal_plan) || 'Sightseeing, Transfers & Accommodation';
  const nights = Number(req.nights || (b && b.nights) || 1);

  return {
    invoiceNumber,
    bookingReference: bookingRef,
    requestReference: reqRef,
    paymentReference,
    isDemoSandbox: String(paymentReference).toLowerCase().includes('demo'),
    paymentDateFormatted: fmtDateAscii(confirmedAtIso),
    confirmedAtIso,
    destination: req.destination || 'India Tour',
    checkInFormatted: fmtDateAscii(req.check_in_date || (b && b.check_in_date)),
    checkOutFormatted: fmtDateAscii(req.check_out_date || (b && b.check_out_date)),
    nights,
    days: nights + 1,
    numAdults: Number(req.num_adults || (b && b.adults) || 2),
    numChildren: Number(req.num_children || (b && b.children) || 0),
    numRooms: Number(req.num_rooms || (b && b.num_rooms) || 1),
    traveler: {
      name: req.guest_name || (b && b.guest_name) || 'Verified Traveler',
      phone: req.guest_phone || (b && b.guest_phone) || '-',
      email: req.guest_email || (b && b.guest_email) || '-'
    },
    vendor: {
      businessName: vendorName,
      contactPerson: vendorContactPerson,
      contactPhone: vendorPhone,
      contactEmail: vendorEmail
    },
    pricing: {
      totalTourINR,
      advanceBaseINR,
      advanceGstINR,
      advancePaidINR,
      remainingBalanceINR,
      remainingModeLabel: isOnlineBalance
        ? 'Online settlement via TripMozy before departure'
        : `Pay directly to ${vendorName} upon tour arrival`
    },
    mealPlan
  };
}

/**
 * Render structured receipt model into an Adobe-compatible single-page A4 PDF Buffer
 */
function generateReceiptPdfBuffer(details) {
  const m = buildReceiptModel(details);

  const PAGE_W = 595;
  const PAGE_H = 842;
  const MARGIN = 36;
  const CONTENT_W = PAGE_W - MARGIN * 2; // 523
  const ops = [];

  const py = (topY) => PAGE_H - topY;
  const rect = (x, topY, w, h, fillHex, strokeHex = null, lineWidth = 0.75) => {
    const y = PAGE_H - topY - h;
    if (fillHex && strokeHex) {
      ops.push(`${lineWidth} w ${rgbFill(fillHex)} ${rgbStroke(strokeHex)} ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re B`);
    } else if (fillHex) {
      ops.push(`${rgbFill(fillHex)} ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
    } else if (strokeHex) {
      ops.push(`${lineWidth} w ${rgbStroke(strokeHex)} ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
    }
  };

  const line = (x1, topY1, x2, topY2, hex = '#E2DDD3', lineWidth = 0.75) => {
    ops.push(`${lineWidth} w ${rgbStroke(hex)} ${x1.toFixed(2)} ${py(topY1).toFixed(2)} m ${x2.toFixed(2)} ${py(topY2).toFixed(2)} l S`);
  };

  const text = (x, topY, str, { font = 'F1', size = 10, color = '#14171C' } = {}) => {
    ops.push(`BT /${font} ${size} Tf ${rgbFill(color)} 1 0 0 1 ${x.toFixed(2)} ${py(topY).toFixed(2)} Tm (${escapePdfStr(str)}) Tj ET`);
  };

  // Approximate horizontal width for right-aligned text; F4/F5 Courier is exact 0.6*size per char
  const textRight = (rightX, topY, str, { font = 'F5', size = 10, color = '#14171C' } = {}) => {
    const clean = toPdfAscii(str, '');
    const factor = (font === 'F4' || font === 'F5') ? 0.6 : 0.52;
    const width = clean.length * size * factor;
    text(rightX - width, topY, clean, { font, size, color });
  };

  // ── Page Paper Background ──
  rect(0, 0, PAGE_W, PAGE_H, '#FFFFFF');

  // ── 1. Dark Editorial Masthead ──
  rect(MARGIN, 28, CONTENT_W, 88, '#14171C');
  line(MARGIN, 116, MARGIN + CONTENT_W, 116, '#9E6B30', 2.2);

  text(MARGIN + 18, 56, 'TripMozy', { font: 'F2', size: 22, color: '#FFFFFF' });
  text(MARGIN + 116, 56, '.com', { font: 'F2', size: 13, color: '#C9A467' });
  text(MARGIN + 18, 76, 'OFFICIAL PAYMENT RECEIPT & ESCROW TAX BILL', { font: 'F2', size: 8.5, color: '#C9A467' });
  text(MARGIN + 18, 92, 'Commissioning Concierge & Protected Tour Escrow (SAC 998552)', { font: 'F1', size: 8, color: '#9CA3AF' });

  // Confirmed Pill on Masthead Right
  rect(394, 41, 148, 22, '#1B5E44', '#34D399', 0.6);
  text(406, 55, 'PAYMENT RECEIVED - CONFIRMED', { font: 'F2', size: 7.5, color: '#86EFAC' });
  textRight(MARGIN + CONTENT_W - 18, 82, m.invoiceNumber, { font: 'F5', size: 10, color: '#F7F5F0' });
  if (m.isDemoSandbox) {
    textRight(MARGIN + CONTENT_W - 18, 96, 'MODE: DEMO SANDBOX', { font: 'F4', size: 7.5, color: '#C9A467' });
  } else {
    textRight(MARGIN + CONTENT_W - 18, 96, 'MODE: RAZORPAY VERIFIED', { font: 'F4', size: 7.5, color: '#86EFAC' });
  }

  // ── 2. Metadata Strip (4 columns) ──
  const metaTop = 128;
  const metaH = 44;
  rect(MARGIN, metaTop, CONTENT_W, metaH, '#F7F5F0', '#E2DDD3', 0.8);
  const colW = CONTENT_W / 4;
  for (let i = 1; i < 4; i++) {
    line(MARGIN + colW * i, metaTop, MARGIN + colW * i, metaTop + metaH, '#E2DDD3', 0.75);
  }

  const metaCols = [
    { lbl: 'INVOICE NO.', val: truncateStr(m.invoiceNumber, 22), font: 'F5' },
    { lbl: 'BOOKING REFERENCE', val: truncateStr(m.bookingReference, 22), font: 'F5' },
    { lbl: 'PAYMENT DATE', val: truncateStr(m.paymentDateFormatted, 20), font: 'F2' },
    { lbl: 'PAYMENT REF', val: truncateStr(m.paymentReference, 22), font: 'F4' }
  ];
  metaCols.forEach((c, idx) => {
    const cx = MARGIN + colW * idx + 9;
    text(cx, metaTop + 15, c.lbl, { font: 'F2', size: 6.8, color: '#767B84' });
    text(cx, metaTop + 31, c.val, { font: c.font, size: 7.4, color: '#14171C' });
  });

  // ── 3. Parties Two-Column Cards ──
  const partyTop = 184;
  const partyH = 138;
  const boxW = (CONTENT_W - 14) / 2;
  const leftX = MARGIN;
  const rightX = MARGIN + boxW + 14;

  // Left: Traveler
  rect(leftX, partyTop, boxW, partyH, '#F7F5F0', '#E2DDD3', 0.8);
  text(leftX + 14, partyTop + 18, 'BILLED TO (TRAVELER)', { font: 'F2', size: 7.5, color: '#767B84' });
  const guestNameLines = wrapLines(m.traveler.name, 26, 2);
  guestNameLines.forEach((ln, i) => {
    text(leftX + 14, partyTop + 36 + i * 14, ln, { font: 'F2', size: 12, color: '#14171C' });
  });
  const guestBodyY = partyTop + (guestNameLines.length > 1 ? 68 : 56);
  text(leftX + 14, guestBodyY, `Phone:  ${truncateStr(m.traveler.phone, 26)}`, { font: 'F4', size: 8.5, color: '#484E57' });
  text(leftX + 14, guestBodyY + 15, `Email:  ${truncateStr(m.traveler.email, 32)}`, { font: 'F1', size: 8.2, color: '#484E57' });
  text(leftX + 14, guestBodyY + 30, `Route:  ${truncateStr(m.destination, 28)}`, { font: 'F2', size: 8.5, color: '#14171C' });
  text(leftX + 14, guestBodyY + 45, `Req ID: ${truncateStr(m.requestReference, 26)}`, { font: 'F4', size: 7.5, color: '#767B84' });

  // Right: Tour Operator Partner
  rect(rightX, partyTop, boxW, partyH, '#FFFFFF', '#14171C', 0.9);
  text(rightX + 14, partyTop + 18, 'ASSIGNED TOUR OPERATOR PARTNER', { font: 'F2', size: 7.5, color: '#7D5220' });
  const vendorNameLines = wrapLines(m.vendor.businessName, 29, 2);
  vendorNameLines.forEach((ln, i) => {
    text(rightX + 14, partyTop + 35 + i * 13, ln, { font: 'F2', size: 11, color: '#14171C' });
  });
  const phoneBoxY = partyTop + (vendorNameLines.length > 1 ? 58 : 48);
  rect(rightX + 14, phoneBoxY, boxW - 28, 30, '#F6EFE6', '#9E6B30', 0.65);
  text(rightX + 22, phoneBoxY + 11, 'DIRECT OPERATOR PHONE:', { font: 'F2', size: 6.8, color: '#7D5220' });
  text(rightX + 22, phoneBoxY + 23, truncateStr(m.vendor.contactPhone, 24), { font: 'F5', size: 9.5, color: '#14171C' });

  text(rightX + 14, phoneBoxY + 42, `Manager: ${truncateStr(m.vendor.contactPerson, 30)}`, { font: 'F1', size: 8.2, color: '#484E57' });
  text(rightX + 14, phoneBoxY + 55, `Email:   ${truncateStr(m.vendor.contactEmail, 34)}`, { font: 'F1', size: 7.8, color: '#484E57' });
  text(rightX + 14, partyTop + partyH - 10, 'TripMozy Verified Partner', { font: 'F2', size: 7.5, color: '#1B5E44' });

  // ── 4. Tour Schedule Strip ──
  const schTop = 336;
  const schH = 42;
  rect(MARGIN, schTop, CONTENT_W, schH, '#EFECE4', '#E2DDD3', 0.8);
  for (let i = 1; i < 4; i++) {
    line(MARGIN + colW * i, schTop, MARGIN + colW * i, schTop + schH, '#E2DDD3', 0.75);
  }
  const schCols = [
    { lbl: 'DEPARTURE (DAY 1)', val: m.checkInFormatted },
    { lbl: 'COMPLETION', val: m.checkOutFormatted },
    { lbl: 'DURATION', val: `${m.days} Days / ${m.nights} Nights` },
    { lbl: 'GROUP & FLEET', val: `${m.numAdults} Adults | ${m.numRooms} Veh.` }
  ];
  schCols.forEach((c, idx) => {
    const cx = MARGIN + colW * idx + 10;
    text(cx, schTop + 14, c.lbl, { font: 'F2', size: 7, color: '#767B84' });
    text(cx, schTop + 30, truncateStr(c.val, 20), { font: 'F2', size: 8.5, color: '#14171C' });
  });

  // ── 5. Itemized Escrow & Tax Breakdown Table ──
  text(MARGIN, 400, 'ITEMIZED TOUR & ESCROW PAYMENT LEDGER', { font: 'F2', size: 9.5, color: '#14171C' });

  const tblTop = 410;
  const rightPadX = MARGIN + CONTENT_W - 14;

  // Table Header
  rect(MARGIN, tblTop, CONTENT_W, 24, '#EFECE4', '#C9C2B4', 0.8);
  text(MARGIN + 14, tblTop + 15, 'PARTICULARS & INCLUSIONS', { font: 'F2', size: 8, color: '#484E57' });
  textRight(rightPadX - 115, tblTop + 15, 'TAX / BASIS', { font: 'F2', size: 8, color: '#484E57' });
  textRight(rightPadX, tblTop + 15, 'AMOUNT (INR)', { font: 'F2', size: 8, color: '#484E57' });

  // Row 1: Total Tour Package
  const r1Y = tblTop + 24;
  rect(MARGIN, r1Y, CONTENT_W, 40, '#FFFFFF', '#E2DDD3', 0.65);
  text(MARGIN + 14, r1Y + 15, `Custom Tour Package: ${truncateStr(m.destination, 40)}`, { font: 'F2', size: 9.5, color: '#14171C' });
  text(MARGIN + 14, r1Y + 29, `Inclusions: ${truncateStr(m.mealPlan, 54)}`, { font: 'F1', size: 8, color: '#767B84' });
  textRight(rightPadX - 115, r1Y + 21, '100% Package', { font: 'F4', size: 8, color: '#767B84' });
  textRight(rightPadX, r1Y + 22, fmtInrAscii(m.pricing.totalTourINR), { font: 'F5', size: 10.5, color: '#14171C' });

  // Row 2: 30% Base Advance
  const r2Y = r1Y + 40;
  rect(MARGIN, r2Y, CONTENT_W, 26, '#F7F5F0', '#E2DDD3', 0.65);
  text(MARGIN + 22, r2Y + 16, '30% Tour Advance Deposit (Base Escrow Deposit)', { font: 'F1', size: 8.8, color: '#484E57' });
  textRight(rightPadX - 115, r2Y + 16, '30% Advance', { font: 'F4', size: 8, color: '#767B84' });
  textRight(rightPadX, r2Y + 16, fmtInrAscii(m.pricing.advanceBaseINR), { font: 'F4', size: 9.5, color: '#484E57' });

  // Row 3: 5% GST
  const r3Y = r2Y + 26;
  rect(MARGIN, r3Y, CONTENT_W, 26, '#F7F5F0', '#E2DDD3', 0.65);
  text(MARGIN + 22, r3Y + 16, '5% GST on Tour Advance Deposit (Govt. of India)', { font: 'F1', size: 8.8, color: '#484E57' });
  textRight(rightPadX - 115, r3Y + 16, 'SAC 998552', { font: 'F4', size: 8, color: '#767B84' });
  textRight(rightPadX, r3Y + 16, fmtInrAscii(m.pricing.advanceGstINR), { font: 'F4', size: 9.5, color: '#484E57' });

  // Row 4: Total Received by TripMozy Escrow (Highlighted Botanical Sage Row)
  const r4Y = r3Y + 26;
  rect(MARGIN, r4Y, CONTENT_W, 38, '#EBF3EF', '#1B5E44', 0.9);
  text(MARGIN + 14, r4Y + 15, 'Total Advance Received by TripMozy.com', { font: 'F2', size: 10, color: '#1B5E44' });
  text(MARGIN + 14, r4Y + 28, 'Status: SUCCESS - Held securely inside TripMozy Escrow Account', { font: 'F1', size: 8, color: '#1B5E44' });
  textRight(rightPadX - 115, r4Y + 22, 'PAID NOW', { font: 'F5', size: 8.5, color: '#1B5E44' });
  textRight(rightPadX, r4Y + 23, fmtInrAscii(m.pricing.advancePaidINR), { font: 'F5', size: 12.5, color: '#1B5E44' });

  // Row 5: Remaining 70% Balance
  const r5Y = r4Y + 38;
  rect(MARGIN, r5Y, CONTENT_W, 34, '#FFFFFF', '#C9C2B4', 0.8);
  text(MARGIN + 14, r5Y + 14, 'Remaining 70% Tour Balance Due', { font: 'F2', size: 9.5, color: '#14171C' });
  text(MARGIN + 14, r5Y + 26, truncateStr(m.pricing.remainingModeLabel, 68), { font: 'F1', size: 8, color: '#767B84' });
  textRight(rightPadX - 115, r5Y + 20, '70% Balance', { font: 'F4', size: 8, color: '#767B84' });
  textRight(rightPadX, r5Y + 20, fmtInrAscii(m.pricing.remainingBalanceINR), { font: 'F5', size: 10.5, color: '#14171C' });

  // ── 6. Escrow Protection & Terms Box ──
  const boxTop = 612;
  const boxH = 104;
  rect(MARGIN, boxTop, CONTENT_W, boxH, '#F7F5F0', '#E2DDD3', 0.8);
  rect(MARGIN, boxTop, 3.2, boxH, '#9E6B30');

  text(MARGIN + 14, boxTop + 18, 'TRIPMOZY ESCROW PROTECTION & ITINERARY ATTESTATION', { font: 'F2', size: 8.5, color: '#7D5220' });
  text(MARGIN + 14, boxTop + 34, `1. Advance payment of ${fmtInrAscii(m.pricing.advancePaidINR)} is held inside TripMozy Escrow until tour commencement.`, { font: 'F1', size: 8.2, color: '#484E57' });
  text(MARGIN + 14, boxTop + 49, `2. Coordinate vehicle pickup & sightseeing directly with ${truncateStr(m.vendor.businessName, 28)} (${truncateStr(m.vendor.contactPhone, 16)}).`, { font: 'F1', size: 8.2, color: '#484E57' });
  text(MARGIN + 14, boxTop + 64, `3. Carry a valid government photo ID and quote reference ${truncateStr(m.requestReference, 24)} on Day 1.`, { font: 'F1', size: 8.2, color: '#484E57' });
  text(MARGIN + 14, boxTop + 79, '4. Remaining 70% operator settlement follows the checkout preference recorded on this invoice.', { font: 'F1', size: 8.2, color: '#484E57' });
  text(MARGIN + 14, boxTop + 94, `Payment Ref: ${truncateStr(m.paymentReference, 38)}   |   Escrow State: LOCKED & VERIFIED`, { font: 'F4', size: 7.5, color: '#767B84' });

  // ── 7. Footer Signature & Verification Line ──
  line(MARGIN, 756, MARGIN + CONTENT_W, 756, '#C9C2B4', 0.8);
  text(MARGIN, 773, 'ELECTRONICALLY ISSUED TAX RECEIPT - NO PHYSICAL SIGNATURE REQUIRED', { font: 'F2', size: 8, color: '#14171C' });
  text(MARGIN, 787, `Issued: ${m.paymentDateFormatted}   |   Portal: tripmozy.com/booking?id=${truncateStr(m.bookingReference, 26)}`, { font: 'F4', size: 7.5, color: '#767B84' });
  textRight(MARGIN + CONTENT_W, 773, 'TRIPMOZY ESCROW VERIFIED', { font: 'F2', size: 8.5, color: '#1B5E44' });
  textRight(MARGIN + CONTENT_W, 787, 'Page 1 of 1', { font: 'F1', size: 7.5, color: '#767B84' });

  const streamContent = ops.join('\n');
  const streamByteLen = Buffer.byteLength(streamContent, 'latin1');

  // Assemble PDF 1.4 Objects with Exact Byte Offsets
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R /F5 9 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${streamByteLen} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n',
    '7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>\nendobj\n',
    '8 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n',
    '9 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>\nendobj\n'
  ];

  const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const chunks = [Buffer.from(header, 'latin1')];
  let offset = chunks[0].length;
  const xrefOffsets = [0];

  for (const objStr of objects) {
    xrefOffsets.push(offset);
    const buf = Buffer.from(objStr, 'latin1');
    chunks.push(buf);
    offset += buf.length;
  }

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < xrefOffsets.length; i++) {
    xref += `${String(xrefOffsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, 'latin1'));

  return {
    buffer: Buffer.concat(chunks),
    model: m,
    filename: `TripMozy-Receipt-${m.invoiceNumber}.pdf`
  };
}

module.exports = {
  buildReceiptModel,
  generateReceiptPdfBuffer
};
