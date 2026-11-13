// ============================================================================
// TripMozy Vercel Serverless Function Handler
// Routes incoming /api/*, /health, /action requests through TripMozy core
// ============================================================================

let appHandler = null;
let bootError = null;
let applySecurityHeaders = null;

try {
  const security = require('../src/security/headers');
  applySecurityHeaders = security.applySecurityHeaders;
} catch (_) {}

try {
  const serverModule = require('../server');
  appHandler = serverModule.appHandler || serverModule;
} catch (err) {
  console.error('[TripMozy Vercel Boot Error]', err);
  bootError = err;
}

module.exports = (req, res) => {
  // Apply comprehensive security and CORS headers
  if (applySecurityHeaders) {
    applySecurityHeaders(req, res);
  } else {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Admin-Role');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Restore original URL when rewritten by Vercel
  const host = req.headers.host || 'localhost';

  // Canonical Redirect: If accessed via preview deployment hash URL, redirect to canonical production domain
  if (host.includes('-tripmozy.vercel.app') && !host.startsWith('tripmozy-smart-tour-booking.vercel.app')) {
    const prodUrl = `https://tripmozy-smart-tour-booking.vercel.app${req.url}`;
    res.writeHead(302, { Location: prodUrl });
    res.end();
    return;
  }

  try {
    const parsed = new URL(req.url, `http://${host}`);
    const originalUrl = parsed.searchParams.get('__url') || req.headers['x-matched-path'] || req.headers['x-now-route-matches'];
    if (originalUrl && !originalUrl.startsWith('/api/index.js')) {
      parsed.searchParams.delete('__url');
      const queryStr = parsed.searchParams.toString();
      req.url = originalUrl + (queryStr ? `?${queryStr}` : '');
    }
  } catch (_) {}

  if (bootError) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'TripMozy Serverless Boot Failure',
      message: bootError.message,
      stack: process.env.NODE_ENV === 'development' ? bootError.stack : undefined
    }));
    return;
  }

  try {
    return appHandler(req, res);
  } catch (err) {
    console.error('[TripMozy Vercel Invocation Error]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Internal Server Error',
        message: err.message
      }));
    }
  }
};
