// ============================================================================
// TripMozy Vercel Serverless Function Handler
// Routes incoming /api/*, /health, /action requests through TripMozy core
// ============================================================================

let appHandler = null;
let bootError = null;

try {
  const serverModule = require('../server');
  appHandler = serverModule.appHandler || serverModule;
} catch (err) {
  console.error('[TripMozy Vercel Boot Error]', err);
  bootError = err;
}

module.exports = (req, res) => {
  // Always attach CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Restore original URL when rewritten by Vercel
  const host = req.headers.host || 'localhost';
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
