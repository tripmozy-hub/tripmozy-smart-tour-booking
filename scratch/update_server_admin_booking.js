const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'server.js');
let content = fs.readFileSync(filePath, 'utf8');

const target = `            if (b && b.contact_email) {
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
                  dashboardUrl: \`\${baseUrl}/partner/dashboard?vendorId=\${b.vendor_id}\`
                }
              });
            }
          } catch (_) {}
        }`;

const replacement = `            if (b && b.contact_email) {
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
                  guestEmail: result.guest ? result.guest.email : '',
                  dashboardUrl: \`\${baseUrl}/partner/dashboard?vendorId=\${b.vendor_id}\`
                }
              });
            }

            // 3. Official Bill & Payment Confirmation to Admin (tripmozy@gmail.com)
            try {
              notifService.send({
                destination: 'tripmozy@gmail.com',
                channel: 'email',
                templateCode: 'booking_confirmed',
                eventType: 'booking.confirmed_admin',
                payload: {
                  bookingReference: result.bookingReference,
                  propertyName: result.propertyName,
                  vendorName: vendorDisplayName,
                  vendorPhone: vendorPhoneNum,
                  vendorEmail: vendorEmailAddr,
                  guestName: result.guest ? result.guest.name : 'Traveler',
                  guestPhone: result.guest ? result.guest.phone : '',
                  guestEmail: result.guest ? result.guest.email : '',
                  destination: result.destination || result.propertyName,
                  checkInDate: result.checkInDate,
                  checkOutDate: result.checkOutDate,
                  nights: result.nights,
                  numRooms: result.numRooms,
                  totalAmountINR: result.totalAmountINR,
                  advancePaidINR: result.advancePaidINR,
                  advanceBaseINR: result.advanceBaseINR,
                  advanceGstINR: result.advanceGstINR,
                  remainingBalanceINR: result.remainingBalanceINR,
                  remainingPaymentOption: result.remainingPaymentOption,
                  paymentReference: result.paymentReference || body.paymentReference,
                  bookingUrl
                }
              });
            } catch (_) {}
          } catch (_) {}
        }`;

if (!content.includes(target)) {
  throw new Error("Could not find target in server.js");
}
content = content.replace(target, replacement);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Successfully updated server.js with admin booking confirmed email!');
