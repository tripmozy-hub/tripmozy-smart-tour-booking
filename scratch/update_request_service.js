const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'src', 'requests', 'request-service.js');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Remove fallback to tripmozy@gmail.com in vendor dispatch loop
const oldTarget = `          const targetEmails = new Set();
          if (vendor.contact_email) targetEmails.add(vendor.contact_email.trim());
          if (targetEmails.size === 0) targetEmails.add('tripmozy@gmail.com');`;

const newTarget = `          const targetEmails = new Set();
          if (vendor.contact_email && vendor.contact_email.trim().toLowerCase() !== 'tripmozy@gmail.com') {
            targetEmails.add(vendor.contact_email.trim());
          }`;

if (!content.includes(oldTarget)) {
  throw new Error("Could not find oldTarget in request-service.js");
}
content = content.replace(oldTarget, newTarget);

// 2. Add admin_new_request email dispatch to tripmozy@gmail.com
const auditMarker = "      tx.logAudit({";
const adminDispatchCode = `      // Automated Written Details Email to Main Admin (tripmozy@gmail.com)
      if (this.notifService) {
        try {
          const notifiedVendorsList = Array.from(matchedVendors.values())
            .map(v => v.business_name || 'Verified Partner')
            .join(', ');

          this.notifService.send({
            recipientUserId: null,
            destination: 'tripmozy@gmail.com',
            channel: 'email',
            templateCode: 'admin_new_request',
            eventType: 'admin.request_created',
            payload: {
              requestId,
              requestReference: reference,
              guestName,
              guestPhone,
              guestEmail,
              destination,
              destinationLocality: destinationLocality || 'Not specified',
              checkInDate,
              checkOutDate,
              nights,
              numRooms,
              numAdults,
              numChildren: numChildren || 0,
              roomPreference: roomPreference || 'standard',
              requiredFacilities: JSON.parse(finalFacilitiesJson),
              totalBudgetINR: budgetNum,
              dispatchedVendorsCount: dispatchedCount,
              dispatchedVendorsList: notifiedVendorsList,
              createdAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
            }
          });
        } catch (adminErr) {
          console.error('[Admin Request Email Dispatch Error]', adminErr.message);
        }
      }

`;

content = content.replace(auditMarker, adminDispatchCode + auditMarker);

// 3. In getRequestDetails, sanitize vendor contact info before booking confirmation
const oldEnriched = `    const enrichedOffers = offers.map(o => {
      const tourPricing = PricingEngine.calculateTourPricing(o.total_payable_paise);
      return {
        ...o,
        tourPricing,
        vendor: {
          businessName: o.vendor_business_name || o.property_name,
          contactPerson: o.vendor_contact_person || 'Tour Manager',
          contactPhone: o.vendor_contact_phone || '',
          contactEmail: o.vendor_contact_email || ''
        }
      };
    });`;

const newEnriched = `    const enrichedOffers = offers.map(o => {
      const tourPricing = PricingEngine.calculateTourPricing(o.total_payable_paise);
      const isBooked = req.status === 'booked';
      return {
        ...o,
        tourPricing,
        vendor: {
          businessName: o.vendor_business_name || o.property_name,
          contactPerson: isBooked ? (o.vendor_contact_person || 'Tour Manager') : 'Verified Tour Partner',
          contactPhone: isBooked ? (o.vendor_contact_phone || '') : null,
          contactEmail: isBooked ? (o.vendor_contact_email || '') : null
        }
      };
    });`;

if (!content.includes(oldEnriched)) {
  throw new Error("Could not find oldEnriched in request-service.js");
}
content = content.replace(oldEnriched, newEnriched);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Successfully updated request-service.js!');
