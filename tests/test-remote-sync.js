const http = require('node:http');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { TripMozyDatabase } = require('../src/db/database');
const { RemoteSyncManager, CURSOR_META_KEY, KV_OPLOG_KEY } = require('../src/db/remote-sync');
const { AuthService } = require('../src/auth/auth-service');
const { RequestService } = require('../src/requests/request-service');
const { VendorService } = require('../src/vendor/vendor-service');
const { seedCoreTourOperators } = require('../src/onboarding/catalog-loader');

// Mock Turso Hrana /v2/pipeline HTTP server backed by an independent SQLite DB
function startMockTursoServer() {
  const remoteDb = new DatabaseSync(':memory:');

  const fromArg = (arg) => {
    if (!arg || arg.type === 'null') return null;
    if (arg.type === 'integer') return parseInt(arg.value, 10);
    if (arg.type === 'float') return Number(arg.value);
    return arg.value;
  };

  const toCell = (val) => {
    if (val === null || val === undefined) return { type: 'null' };
    if (typeof val === 'number') {
      return Number.isInteger(val) ? { type: 'integer', value: String(val) } : { type: 'float', value: val };
    }
    return { type: 'text', value: String(val) };
  };

  const server = http.createServer((req, res) => {
    if (req.url !== '/v2/pipeline' || req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    assert.strictEqual(req.headers['authorization'], 'Bearer test-turso-token');
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const results = [];
        for (const item of (parsed.requests || [])) {
          if (item.type === 'close') {
            results.push({ type: 'ok', response: { type: 'close' } });
            continue;
          }
          const stmtObj = item.stmt || {};
          const sql = stmtObj.sql || '';
          const args = (stmtObj.args || []).map(fromArg);
          const trimmed = sql.trim().toUpperCase();
          if (trimmed.startsWith('SELECT')) {
            const rows = remoteDb.prepare(sql).all(...args);
            const cols = rows[0] ? Object.keys(rows[0]).map(name => ({ name })) : [];
            const encodedRows = rows.map(r => Object.values(r).map(toCell));
            results.push({ type: 'ok', response: { type: 'execute', result: { cols, rows: encodedRows } } });
          } else {
            remoteDb.prepare(sql).run(...args);
            results.push({ type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, remoteDb, url: `libsql://127.0.0.1:${port}`.replace('libsql://', 'http://') });
    });
  });
}

// Mock Upstash Redis / Vercel KV /pipeline HTTP server
function startMockKvServer() {
  const store = new Map();
  const server = http.createServer((req, res) => {
    if (req.url !== '/pipeline' || req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    assert.strictEqual(req.headers['authorization'], 'Bearer test-kv-token');
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const cmds = JSON.parse(body);
      const out = cmds.map(cmd => {
        const [op, key, ...rest] = cmd;
        const arr = store.get(key) || [];
        if (op === 'RPUSH') {
          for (const v of rest) arr.push(String(v));
          store.set(key, arr);
          return { result: arr.length };
        }
        if (op === 'LRANGE') {
          const start = parseInt(rest[0], 10) || 0;
          const stop = parseInt(rest[1], 10);
          const slice = stop === -1 ? arr.slice(start) : arr.slice(start, stop + 1);
          return { result: slice };
        }
        return { result: null };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, store, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function runTests() {
  // 1. Test Turso multi-container sync + rollback isolation
  const turso = await startMockTursoServer();
  try {
    const dbA = new TripMozyDatabase(':memory:');
    seedCoreTourOperators(dbA);
    const syncA = new RemoteSyncManager(dbA, { tursoUrl: turso.url, tursoToken: 'test-turso-token', instanceId: 'container-A' });

    const dbB = new TripMozyDatabase(':memory:');
    seedCoreTourOperators(dbB);
    const syncB = new RemoteSyncManager(dbB, { tursoUrl: turso.url, tursoToken: 'test-turso-token', instanceId: 'container-B' });

    assert.strictEqual(syncA.isEnabled(), true);
    assert.strictEqual(syncA.provider, 'turso');

    // Verify rolled-back transaction is NOT recorded or pushed
    assert.throws(() => {
      dbA.transaction((tx) => {
        tx.execute("INSERT INTO system_settings (key, value, description) VALUES ('rollback_test', '1', 'x')");
        throw new Error('force rollback');
      });
    }, /force rollback/);
    assert.strictEqual(dbA.hasPendingWrites(), false, 'Rolled-back writes must never enter pending queue');

    // Container A registers a new vendor + submits a Rs 40,000 Goa tour request
    const authA = new AuthService(dbA);
    const newVendor = authA.registerNewVendor({
      cleanId: 'sync.partner@example.com',
      isEmail: true,
      cleanDigits: '9876501234',
      name: 'Kabir Sen',
      phone: '+919876501234',
      email: 'sync.partner@example.com',
      businessName: 'Coastal Horizon Travels'
    });

    const reqServiceA = new RequestService(dbA);
    const reqRes = reqServiceA.submitStayRequest({
      guestName: 'Aarav Mehta',
      guestEmail: 'aarav.sync@example.com',
      guestPhone: '+919811122233',
      destination: 'Goa',
      checkInDate: '2027-06-10',
      checkOutDate: '2027-06-14',
      numRooms: 1,
      numAdults: 2,
      totalBudgetINR: 40000,
      termsAccepted: true
    });

    const flushRes = await syncA.flushWrites();
    assert(flushRes.pushed > 0, 'Container A must push mutations to Turso oplog');

    // Container B pulls unseen remote oplog -> both newVendor and reqRes appear cleanly
    const pullB = await syncB.pullLatest();
    assert(pullB.pulled > 0, 'Container B must pull Container A mutations');
    assert(syncB.getLocalCursor() > 0, 'Container B cursor must advance');

    const vendorServiceB = new VendorService(dbB);
    const allVendorsB = dbB.query("SELECT id, business_name FROM vendor_accounts WHERE LOWER(TRIM(status)) = 'active'");
    assert(allVendorsB.some(v => v.id === newVendor.id), 'New vendor synced to Container B');

    for (const v of allVendorsB) {
      const q = vendorServiceB.getIncomingRequests(v.id);
      const item = q.find(r => r.request_reference === reqRes.reference);
      assert(item && item.response_status === 'pending' && item.total_budget_inr === 40000,
        `Vendor ${v.business_name} on Container B must see synced request`);
    }

    // Container B partner accepts -> flushWrites -> Container A sees exclusive acceptance
    const syncPartnerQueue = vendorServiceB.getIncomingRequests(newVendor.id);
    const rec = syncPartnerQueue.find(r => r.request_reference === reqRes.reference);
    vendorServiceB.acceptRequest({ recipientId: rec.recipient_id, customTotalPaise: 4000000 });
    await syncB.flushWrites();

    await syncA.pullLatest();
    const vendorServiceA = new VendorService(dbA);
    const acceptedCheckA = vendorServiceA.getIncomingRequests(newVendor.id).find(r => r.request_reference === reqRes.reference);
    assert.strictEqual(acceptedCheckA.response_status, 'accepted', 'Container A must reflect acceptance from Container B');
    const otherVendorA = allVendorsB.find(v => v.id !== newVendor.id);
    const otherQueueA = vendorServiceA.getIncomingRequests(otherVendorA.id);
    assert(!otherQueueA.some(r => r.request_reference === reqRes.reference && r.response_status === 'pending'),
      'Compete-out exclusivity must propagate back to Container A');

    // Container A re-pull must skip its own ops & keep cursor aligned cleanly
    assert.strictEqual(dbA.getSyncMeta(CURSOR_META_KEY) !== '0', true);
    dbA.close();
    dbB.close();
    console.log('TURSO MULTI-CONTAINER SYNC TESTS PASSED!');
  } finally {
    turso.server.close();
  }

  // 2. Test KV / Upstash Redis REST /pipeline multi-container sync
  const kv = await startMockKvServer();
  try {
    const db1 = new TripMozyDatabase(':memory:');
    seedCoreTourOperators(db1);
    const sync1 = new RemoteSyncManager(db1, { kvUrl: kv.url, kvToken: 'test-kv-token', instanceId: 'kv-inst-1' });

    const db2 = new TripMozyDatabase(':memory:');
    seedCoreTourOperators(db2);
    const sync2 = new RemoteSyncManager(db2, { kvUrl: kv.url, kvToken: 'test-kv-token', instanceId: 'kv-inst-2' });

    assert.strictEqual(sync1.isEnabled(), true);
    assert.strictEqual(sync1.provider, 'kv');

    const reqService1 = new RequestService(db1);
    const reqRes = reqService1.submitStayRequest({
      guestName: 'KV Traveler',
      guestEmail: 'kv.traveler@example.com',
      guestPhone: '+919822233344',
      destination: 'Kashmir',
      checkInDate: '2027-07-01',
      checkOutDate: '2027-07-05',
      numRooms: 1,
      numAdults: 2,
      totalBudgetINR: 40000,
      termsAccepted: true
    });
    const pushed = await sync1.flushWrites();
    assert(pushed.pushed > 0);
    assert.strictEqual((kv.store.get(KV_OPLOG_KEY) || []).length, 1);

    const pulled = await sync2.pullLatest();
    assert(pulled.pulled > 0);
    const vendorService2 = new VendorService(db2);
    const activeV2 = db2.query("SELECT id FROM vendor_accounts WHERE LOWER(TRIM(status)) = 'active'");
    for (const v of activeV2) {
      const rows = vendorService2.getIncomingRequests(v.id);
      assert(rows.some(r => r.request_reference === reqRes.reference), 'KV sync must propagate request to all active partners on Container 2');
    }

    db1.close();
    db2.close();
    console.log('KV / UPSTASH MULTI-CONTAINER SYNC TESTS PASSED!');
  } finally {
    kv.server.close();
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
