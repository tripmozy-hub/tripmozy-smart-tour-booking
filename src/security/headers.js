// ============================================================================
// TripMozy Security Suite: HTTP Security Headers & Origin Validation
// Defense-in-depth: HSTS, Clickjacking, MIME-sniffing, XSS & Strict CORS
// ============================================================================

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/(?:[a-zA-Z0-9-]+\.)?tripmozy\.com$/,
  /^https:\/\/(?:[a-zA-Z0-9-]+\.)?tripmozy-smart-tour-booking\.vercel\.app$/,
  /^https:\/\/tripmozy-smart-tour-booking\.vercel\.app$/,
  /^http:\/\/localhost(?::\d+)?$/,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/
];

/**
 * Check if an origin is permitted
 * @param {string} origin
 * @returns {boolean}
 */
function isOriginAllowed(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERNS.some(regex => regex.test(origin));
}

/**
 * Apply hardened security and CORS headers to outgoing HTTP response
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function applySecurityHeaders(req, res) {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent Clickjacking (allow embedding only by same origin)
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // Cross-site scripting filter
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Strict referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Restrict sensitive browser features
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');

  // Strict Transport Security (HSTS) on HTTPS / Vercel
  const isSecure = req.connection?.encrypted || req.headers['x-forwarded-proto'] === 'https' || process.env.VERCEL;
  if (isSecure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // Content-Security-Policy (allows required CDNs and scripts while mitigating XSS)
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://checkout.razorpay.com https://*.razorpay.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
    "img-src 'self' data: blob: https:; " +
    "connect-src 'self' https: wss:; " +
    "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com;"
  );

  // Dynamic CORS: check origin against trusted patterns
  const origin = req.headers['origin'];
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else if (!origin) {
    // Same-origin browser requests do not have Origin header
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    // Disallowed origin: do not set CORS credentials, lock down
    res.setHeader('Access-Control-Allow-Origin', 'null');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Admin-Role');
}

module.exports = {
  applySecurityHeaders,
  isOriginAllowed
};
