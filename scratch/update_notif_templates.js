const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'src', 'notifications', 'notification-service.js');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add admin_new_request and admin_request_accepted to generateEmailHtml
const marker = "    if (templateCode === 'auth_otp_code') {";
const adminTemplates = `    if (templateCode === 'admin_new_request') {
      return \`
        <div style="font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; max-width:620px; margin:20px auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden; box-shadow:0 10px 30px rgba(0,0,0,0.06);">
          <div style="background:#0f172a; padding:24px; text-align:center;">
            <div style="font-size:24px; font-weight:800; color:#ffffff;">Trip<span style="color:#f59e0b;">Mozy</span> Admin Portal</div>
            <div style="color:#94a3b8; font-size:12px; margin-top:4px; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">Main Platform Dispatch Oversight · tripmozy@gmail.com</div>
          </div>
          
          <div style="background:#2563eb; color:#ffffff; padding:12px 24px; text-align:center; font-weight:700; font-size:13px; letter-spacing:0.3px;">
            📋 NEW CUSTOMER TOUR REQUEST SUBMITTED
          </div>

          <div style="padding:28px 24px;">
            <p style="color:#475569; font-size:14px; line-height:1.6; margin:0 0 20px;">
              Hello <strong>TripMozy Administrator</strong>,<br>
              A customer has just submitted a new customized tour request on TripMozy. Here are the written details:
            </p>

            <!-- SECTION 1: CUSTOMER / TRAVELER CONTACT (ADMIN PRIVILEGE ONLY) -->
            <div style="background:#f0fdf4; border:1.5px solid #86efac; border-radius:12px; padding:18px; margin-bottom:20px;">
              <div style="font-size:12px; font-weight:800; color:#166534; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; border-bottom:1px solid #bbf7d0; padding-bottom:6px;">
                👤 Traveler Contact Info (Admin Only Privilege - Hidden from Vendors)
              </div>
              <table style="width:100%; font-size:13px; border-collapse:collapse;">
                <tr>
                  <td style="padding:5px 0; color:#475569; width:130px;">Traveler Name:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;">\${payload.guestName}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Direct Phone:</td>
                  <td style="padding:5px 0; font-weight:700; color:#059669;"><a href="tel:\${payload.guestPhone}" style="color:#059669; text-decoration:none;">\${payload.guestPhone}</a></td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Email Address:</td>
                  <td style="padding:5px 0; font-weight:700; color:#2563eb;"><a href="mailto:\${payload.guestEmail}" style="color:#2563eb; text-decoration:none;">\${payload.guestEmail}</a></td>
                </tr>
              </table>
            </div>

            <!-- SECTION 2: TOUR REQUIREMENTS -->
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:18px; margin-bottom:20px;">
              <div style="font-size:12px; font-weight:800; color:#475569; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; border-bottom:1px solid #e2e8f0; padding-bottom:6px;">
                📍 Tour Itinerary &amp; Specifications
              </div>
              <table style="width:100%; font-size:13px; border-collapse:collapse;">
                <tr>
                  <td style="padding:5px 0; color:#64748b; width:140px;">Request Reference:</td>
                  <td style="padding:5px 0; font-weight:800; font-family:monospace; color:#0f172a;">\${payload.requestReference}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Destination:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;">\${payload.destination}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Specific Locality:</td>
                  <td style="padding:5px 0; color:#0f172a;">\${payload.destinationLocality || 'Not specified'}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Dates of Travel:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;">\${payload.checkInDate} → \${payload.checkOutDate} (\${payload.nights + 1} Days / \${payload.nights} Nights)</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Travelers &amp; Setup:</td>
                  <td style="padding:5px 0; color:#0f172a;">\${payload.numAdults} Adults\${payload.numChildren ? ', ' + payload.numChildren + ' Children' : ''} · \${payload.numRooms} Dedicated Vehicle(s)</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Package Style:</td>
                  <td style="padding:5px 0; color:#0f172a;">\${payload.roomPreference}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Inclusions Requested:</td>
                  <td style="padding:5px 0; color:#0f172a;">\${payload.requiredFacilities && payload.requiredFacilities.length ? payload.requiredFacilities.join(', ') : 'Standard Sightseeing & Transfers'}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Customer Budget:</td>
                  <td style="padding:5px 0; font-weight:800; font-size:15px; color:#2563eb;">₹\${(payload.totalBudgetINR || 0).toLocaleString('en-IN')}</td>
                </tr>
              </table>
            </div>

            <!-- SECTION 3: BROADCAST STATUS -->
            <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:16px; margin-bottom:20px; font-size:13px; color:#1e40af;">
              <div style="font-weight:700; margin-bottom:4px;">📡 Broadcast Status:</div>
              <div>Dispatched simultaneously to <strong>\${payload.dispatchedVendorsCount} verified tour operator(s)</strong>:</div>
              <div style="font-size:12px; color:#3b82f6; margin-top:4px;">\${payload.dispatchedVendorsList || 'All matching verified operators in the region'}</div>
              <div style="font-size:11px; color:#64748b; margin-top:8px;">🔒 Note: Operators received anonymized request details only. Customer contact information is withheld until 30% advance confirmation.</div>
            </div>

            <div style="font-size:11px; color:#94a3b8; text-align:center; border-top:1px solid #e2e8f0; padding-top:14px;">
              TripMozy Platform Monitoring · Generated automatically at \${payload.createdAt || new Date().toLocaleString('en-IN')}
            </div>
          </div>
        </div>
      \`;
    }

    if (templateCode === 'admin_request_accepted') {
      return \`
        <div style="font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; max-width:620px; margin:20px auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden; box-shadow:0 10px 30px rgba(0,0,0,0.06);">
          <div style="background:#0f172a; padding:24px; text-align:center;">
            <div style="font-size:24px; font-weight:800; color:#ffffff;">Trip<span style="color:#f59e0b;">Mozy</span> Admin Portal</div>
            <div style="color:#94a3b8; font-size:12px; margin-top:4px; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">Main Platform Acceptance Oversight · tripmozy@gmail.com</div>
          </div>
          
          <div style="background:#059669; color:#ffffff; padding:12px 24px; text-align:center; font-weight:700; font-size:13px; letter-spacing:0.3px;">
            ✅ TOUR REQUEST ACCEPTED BY TOUR OPERATOR PARTNER
          </div>

          <div style="padding:28px 24px;">
            <p style="color:#475569; font-size:14px; line-height:1.6; margin:0 0 20px;">
              Hello <strong>TripMozy Administrator</strong>,<br>
              Tour Operator <strong>\${payload.vendorName}</strong> has accepted tour request <strong>\${payload.requestReference}</strong> and issued a tour quote. Here are the whole written details:
            </p>

            <!-- SECTION 1: ACCEPTING OPERATOR DETAILS -->
            <div style="background:#f0fdf4; border:1.5px solid #86efac; border-radius:12px; padding:18px; margin-bottom:20px;">
              <div style="font-size:12px; font-weight:800; color:#166534; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; border-bottom:1px solid #bbf7d0; padding-bottom:6px;">
                🏨 Assigned Tour Operator Partner (Accepted Request)
              </div>
              <table style="width:100%; font-size:13px; border-collapse:collapse;">
                <tr>
                  <td style="padding:5px 0; color:#475569; width:140px;">Business / Operator:</td>
                  <td style="padding:5px 0; font-weight:800; color:#0f172a;">\${payload.vendorName}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Manager / Contact:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;">\${payload.vendorContactPerson || 'Tour Manager'}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Operator Phone:</td>
                  <td style="padding:5px 0; font-weight:700; color:#059669;"><a href="tel:\${payload.vendorPhone}" style="color:#059669; text-decoration:none;">\${payload.vendorPhone}</a></td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Operator Email:</td>
                  <td style="padding:5px 0; font-weight:700; color:#2563eb;"><a href="mailto:\${payload.vendorEmail}" style="color:#2563eb; text-decoration:none;">\${payload.vendorEmail}</a></td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Fleet Base / Property:</td>
                  <td style="padding:5px 0; color:#0f172a;">\${payload.propertyName}</td>
                </tr>
              </table>
            </div>

            <!-- SECTION 2: QUOTE & FINANCIAL BREAKDOWN -->
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:18px; margin-bottom:20px;">
              <div style="font-size:12px; font-weight:800; color:#475569; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; border-bottom:1px solid #e2e8f0; padding-bottom:6px;">
                💰 Quote &amp; Financial Breakdown
              </div>
              <table style="width:100%; font-size:13px; border-collapse:collapse;">
                <tr>
                  <td style="padding:5px 0; color:#64748b; width:150px;">Offer Reference:</td>
                  <td style="padding:5px 0; font-weight:800; font-family:monospace; color:#0f172a;">\${payload.offerReference}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Total Tour Package:</td>
                  <td style="padding:5px 0; font-weight:800; font-size:16px; color:#059669;">₹\${(payload.totalAmountINR || 0).toLocaleString('en-IN')}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">30% Advance Base:</td>
                  <td style="padding:5px 0; font-weight:600; color:#0f172a;">₹\${(payload.advanceBaseINR || 0).toLocaleString('en-IN')}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">5% GST on Advance:</td>
                  <td style="padding:5px 0; font-weight:600; color:#0f172a;">₹\${(payload.advanceGstINR || 0).toLocaleString('en-IN')}</td>
                </tr>
                <tr style="border-top:1px dashed #cbd5e1;">
                  <td style="padding:6px 0; color:#1e40af; font-weight:700;">TripMozy Advance Payable:</td>
                  <td style="padding:6px 0; font-weight:800; color:#2563eb; font-size:15px;">₹\${(payload.advancePayableINR || 0).toLocaleString('en-IN')}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Remaining 70% Balance:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;">₹\${(payload.remainingBalanceINR || 0).toLocaleString('en-IN')} (Due on arrival)</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Package Style:</td>
                  <td style="padding:5px 0; color:#0f172a;">\${payload.roomTypeName || 'All-Inclusive Package'}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Inclusions:</td>
                  <td style="padding:5px 0; color:#0f172a;">\${payload.mealPlan || 'Daily Sightseeing, Dedicated Vehicle & Transfers'}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#64748b;">Cancellation Policy:</td>
                  <td style="padding:5px 0; color:#0f172a;">\${payload.cancellationTerms || 'Free cancellation up to 48 hours before tour start'}</td>
                </tr>
              </table>
            </div>

            <!-- SECTION 3: TRAVELER CONTACT (ADMIN PRIVILEGE ONLY) -->
            <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:12px; padding:18px; margin-bottom:20px;">
              <div style="font-size:12px; font-weight:800; color:#991b1b; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; border-bottom:1px solid #fee2e2; padding-bottom:6px;">
                👤 Traveler Details (Admin Visibility)
              </div>
              <table style="width:100%; font-size:13px; border-collapse:collapse;">
                <tr>
                  <td style="padding:5px 0; color:#475569; width:130px;">Traveler Name:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;">\${payload.guestName}</td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Traveler Phone:</td>
                  <td style="padding:5px 0; font-weight:700; color:#0f172a;"><a href="tel:\${payload.guestPhone}" style="color:#0f172a; text-decoration:none;">\${payload.guestPhone}</a></td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Traveler Email:</td>
                  <td style="padding:5px 0; font-weight:700; color:#2563eb;"><a href="mailto:\${payload.guestEmail}" style="color:#2563eb; text-decoration:none;">\${payload.guestEmail}</a></td>
                </tr>
                <tr>
                  <td style="padding:5px 0; color:#475569;">Destination:</td>
                  <td style="padding:5px 0; color:#0f172a;">\${payload.destination} (\${payload.checkInDate} to \${payload.checkOutDate})</td>
                </tr>
              </table>
              <div style="font-size:11px; color:#b91c1c; margin-top:8px;">🔒 Operator has NOT received traveler phone/email. Contact details will be released in the official PDF bill upon advance payment.</div>
            </div>

            <div style="text-align:center; margin-bottom:20px;">
              <a href="\${payload.paymentUrl}" target="_blank" style="display:inline-block; background:#0f172a; color:#ffffff; padding:12px 24px; border-radius:8px; font-weight:700; font-size:13px; text-decoration:none;">
                View Customer Quote &amp; Payment Portal →
              </a>
            </div>

            <div style="font-size:11px; color:#94a3b8; text-align:center; border-top:1px solid #e2e8f0; padding-top:14px;">
              TripMozy Platform Monitoring · Operator Acceptance Confirmed automatically
            </div>
          </div>
        </div>
      \`;
    }\n\n`;

// Find the last occurrence of marker (in generateEmailHtml)
const lastMarkerIdx = content.lastIndexOf(marker);
if (lastMarkerIdx === -1) {
  throw new Error("Could not find marker");
}
content = content.slice(0, lastMarkerIdx) + adminTemplates + content.slice(lastMarkerIdx);

// 2. Add subjects in email dispatch
const subjectTarget = "const subject = templateCode === 'hotel_offer_received'";
const subjectReplacement = `const subject = templateCode === 'admin_new_request'
          ? \`[TripMozy Admin] 📋 New Customer Tour Request: \${payload.destination} (\${payload.requestReference})\`
          : templateCode === 'admin_request_accepted'
          ? \`[TripMozy Admin] ✅ Tour Request Accepted by \${payload.vendorName} - \${payload.requestReference}\`
          : templateCode === 'hotel_offer_received'`;

content = content.replace(subjectTarget, subjectReplacement);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Successfully updated notification-service.js!');
