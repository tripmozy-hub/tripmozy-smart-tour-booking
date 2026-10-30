# TripMozy — Smart Tour & Holiday Booking Marketplace

TripMozy is a real-time tour booking marketplace that connects travelers directly with verified local tour operators across India. Travelers set their destination, dates, and budget in INR (₹), and eligible local tour operators submit custom tour packages and quotes in real time.

---

## Key Features

1. **Smart Tour Request Engine (`/` & `/smart-tour-booking`)**:
   - Custom destination search with regional state matching (e.g. Srinagar, Manali, Dalhousie, Kerala).
   - Traveler budget in INR (₹), dates, vehicle/room preference, and tour inclusions.
   - Real-time dispatch to verified tour operators.

2. **Transparent 30% Advance + 5% GST Payment Model (`/booking`)**:
   - **TripMozy Advance (30% + 5% GST)**: Collected upfront to confirm tour bookings.
   - **70% Balance**: Scheduled to be paid directly to the local tour driver upon arrival or via TripMozy online before departure.
   - 15-minute concurrency hold protection prevents overbooking.

3. **Unified Sign In with Strict Role Locking (`/login`)**:
   - Two categories: **🎒 Customer / Traveler** and **🤝 TripMozy Partner (Tour Operator)**.
   - Accounts are permanently locked to their registered role to prevent cross-portal access.
   - 1-click tab switcher with auto-fill test codes and WhatsApp OTP delivery.

4. **Tour Operator Partner Dashboard (`/partner/dashboard`)**:
   - Dispatched request cards with countdown timers, traveler budget, and inclusions.
   - Custom quote input with live advance and balance calculation.
   - 1-click **Accept & Send Tour Quote**, **Decline**, and **WhatsApp Direct Chat** actions.

5. **Mobile-First Responsive Design**:
   - Fully optimized for phone browsers (iOS Safari, Android Chrome, and mobile web views down to 320px).
   - 16px minimum font size to eliminate iOS auto-zoom.
   - Fluid 6-digit OTP boxes with native mobile numeric keypad trigger.

---

## Deploy to Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and log in with your Vercel account.
2. Select **Import Git Repository** -> **`tripmozy-hub/tripmozy-smart-tour-booking`**.
3. Framework Preset: **Other** (Root directory: `./`).
4. Click **Deploy**!

---

## Local Development

```bash
# Install dependencies
npm install

# Start local development server
npm start
# Server runs on http://localhost:8080

# Run automated test suites (55 unit & integration tests)
npm test
```
