const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'src', 'vendor', 'vendor-service.js');
let content = fs.readFileSync(filePath, 'utf8');

const target = `        // 6b. Email alert to Customer
        if (recipient.guest_email) {
          try {
            this.notifService.send({
              destination: recipient.guest_email,
              channel: 'email',
              templateCode: 'hotel_offer_received',
              eventType: 'offer.received',
              payload: notifPayload
            });
          } catch (_) {}
        }`;

const replacement = `        // 6b. Email alert to Customer
        if (recipient.guest_email) {
          try {
            this.notifService.send({
              destination: recipient.guest_email,
              channel: 'email',
              templateCode: 'hotel_offer_received',
              eventType: 'offer.received',
              payload: notifPayload
            });
          } catch (_) {}
        }

        // 6c. Notification to Main Admin (tripmozy@gmail.com) with whole written details
        try {
          const vendorAccount = tx.queryOne('SELECT * FROM vendor_accounts WHERE id = ?', [recipient.vendor_id]);

          this.notifService.send({
            recipientUserId: null,
            destination: 'tripmozy@gmail.com',
            channel: 'email',
            templateCode: 'admin_request_accepted',
            eventType: 'admin.offer_created',
            payload: {
              requestReference: recipient.request_reference,
              offerReference,
              offerId,
              destination: recipient.destination,
              checkInDate: recipient.check_in_date,
              checkOutDate: recipient.check_out_date,
              nights: recipient.nights,
              numAdults: recipient.num_adults,
              numRooms: recipient.num_rooms,
              guestName: recipient.guest_name,
              guestPhone: recipient.guest_phone,
              guestEmail: recipient.guest_email,
              vendorName: vendorAccount ? vendorAccount.business_name : recipient.prop_name,
              vendorContactPerson: vendorAccount ? vendorAccount.contact_person : 'Tour Manager',
              vendorPhone: vendorAccount ? vendorAccount.contact_phone : 'Not provided',
              vendorEmail: vendorAccount ? vendorAccount.contact_email : 'Not provided',
              propertyName: recipient.prop_name,
              roomTypeName: room.name,
              mealPlan,
              cancellationTerms,
              totalAmountINR: totalINR,
              advanceBaseINR: tourPricing.advanceBaseINR,
              advanceGstINR: tourPricing.advanceGstINR,
              advancePayableINR: tourPricing.payableNowINR,
              remainingBalanceINR: tourPricing.remainingBalanceINR,
              validUntil,
              paymentUrl
            }
          });
        } catch (adminErr) {
          console.error('[Admin Offer Email Dispatch Error]', adminErr.message);
        }`;

if (!content.includes(target)) {
  throw new Error("Could not find target in vendor-service.js");
}
content = content.replace(target, replacement);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Successfully updated vendor-service.js!');
