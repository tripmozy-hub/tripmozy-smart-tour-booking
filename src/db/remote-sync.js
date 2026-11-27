// ============================================================================
// TripMozy Shared Remote Database Sync Engine (Zero-Dependency HTTP Oplog)
// Synchronizes mutations cleanly across ephemeral serverless containers using:
//   1. Turso / LibSQL HTTP Pipeline API (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN)
//   2. Upstash Redis / Vercel KV REST API (KV_REST_API_URL + KV_REST_API_TOKEN)
// ============================================================================

const crypto = require('node:crypto');

const CURSOR_META_KEY = 'remote_oplog_cursor';
const KV_OPLOG_KEY = 'tripmozy:sql_oplog:v1';

class RemoteSyncManager {
  constructor(db, options = {}) {
    this.db = db;
    this.instanceId = options.instanceId || crypto.randomUUID();
    this.fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

    const tursoUrl = (options.tursoUrl || process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '').trim();
    const tursoToken = (options.tursoToken || process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || '').trim();
    const kvUrl = (options.kvUrl || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim();
    const kvToken = (options.kvToken || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

    if (tursoUrl) {
      this.provider = 'turso';
      this.endpoint = RemoteSyncManager.normalizeTursoEndpoint(tursoUrl);
      this.authToken = tursoToken;
    } else if (kvUrl && kvToken) {
      this.provider = 'kv';
      this.endpoint = kvUrl.replace(/\/$/, '') + '/pipeline';
      this.authToken = kvToken;
    } else {
      this.provider = 'none';
      this.endpoint = '';
      this.authToken = '';
    }

    this._tursoSchemaReady = false;
    this._syncChain = Promise.resolve();
    this._lastPullAt = 0;
    this._lastError = null;
  }

  static normalizeTursoEndpoint(rawUrl) {
    const clean = rawUrl.trim().replace(/^libsql:\/\//i, 'https://').replace(/\/$/, '');
    return clean.endsWith('/v2/pipeline') ? clean : `${clean}/v2/pipeline`;
  }

  isEnabled() {
    return this.provider !== 'none' && Boolean(this.endpoint) && Boolean(this.fetchImpl);
  }

  getStatus() {
    return {
      enabled: this.isEnabled(),
      provider: this.provider,
      localCursor: this.getLocalCursor(),
      pendingWrites: this.db.hasPendingWrites(),
      lastError: this._lastError
    };
  }

  getLocalCursor() {
    const raw = this.db.getSyncMeta(CURSOR_META_KEY, '0');
    const num = parseInt(raw, 10);
    return Number.isFinite(num) && num >= 0 ? num : 0;
  }

  setLocalCursor(seq) {
    this.db.setSyncMeta(CURSOR_META_KEY, String(seq));
  }

  // Encode a primitive value for Turso Hrana v2 HTTP pipeline
  static toTursoArg(v) {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return { type: 'integer', value: String(v) };
      if (Number.isFinite(v)) return { type: 'float', value: v };
      return { type: 'null' };
    }
    return { type: 'text', value: String(v) };
  }

  static fromTursoCell(cell) {
    if (!cell || cell.type === 'null') return null;
    if (cell.type === 'integer') return parseInt(cell.value, 10);
    if (cell.type === 'float') return Number(cell.value);
    return cell.value;
  }

  async _tursoPipeline(requests) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;

    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requests: [...requests, { type: 'close' }]
      })
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Turso HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    const results = data.results || [];
    for (const r of results) {
      if (r.type === 'error') {
        throw new Error((r.error && r.error.message) || 'Turso pipeline error');
      }
    }
    return results;
  }

  async _kvPipeline(commands) {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify(commands)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`KV HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }

  async _ensureTursoSchema() {
    if (this._tursoSchemaReady) return;
    await this._tursoPipeline([
      {
        type: 'execute',
        stmt: {
          sql: `CREATE TABLE IF NOT EXISTS _tm_oplog (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            origin_id TEXT NOT NULL,
            sql TEXT NOT NULL,
            params TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )`
        }
      }
    ]);
    this._tursoSchemaReady = true;
  }

  _enqueue(task) {
    const next = this._syncChain.then(task, task);
    this._syncChain = next.catch(() => {});
    return next;
  }

  // Pull unseen mutations from shared remote store and apply cleanly to local SQLite
  pullLatest() {
    if (!this.isEnabled()) return Promise.resolve({ pulled: 0 });
    return this._enqueue(async () => {
      try {
        if (this.provider === 'turso') {
          return await this._pullFromTurso();
        }
        return await this._pullFromKv();
      } catch (err) {
        this._lastError = err.message;
        console.error('[TripMozy RemoteSync Pull Warning]', err.message);
        return { pulled: 0, error: err.message };
      }
    });
  }

  async _pullFromTurso() {
    await this._ensureTursoSchema();
    const cursor = this.getLocalCursor();

    const results = await this._tursoPipeline([
      {
        type: 'execute',
        stmt: {
          sql: 'SELECT seq, origin_id, sql, params FROM _tm_oplog WHERE seq > ? ORDER BY seq ASC LIMIT 500',
          args: [RemoteSyncManager.toTursoArg(cursor)]
        }
      }
    ]);

    const result = results[0]?.response?.result;
    const rawRows = (result && result.rows) || [];
    if (rawRows.length === 0) {
      this._lastError = null;
      this._lastPullAt = Date.now();
      return { pulled: 0 };
    }

    let maxSeq = cursor;
    const externalOps = [];
    for (const cells of rawRows) {
      const seq = RemoteSyncManager.fromTursoCell(cells[0]);
      const originId = RemoteSyncManager.fromTursoCell(cells[1]);
      const sql = RemoteSyncManager.fromTursoCell(cells[2]);
      const paramsJson = RemoteSyncManager.fromTursoCell(cells[3]);
      if (seq > maxSeq) maxSeq = seq;
      if (originId !== this.instanceId && sql) {
        let params = [];
        try { params = JSON.parse(paramsJson || '[]'); } catch (_) {}
        externalOps.push({ sql, params });
      }
    }

    this._applyExternalOps(externalOps, maxSeq);
    this._lastError = null;
    this._lastPullAt = Date.now();
    return { pulled: externalOps.length, cursor: maxSeq };
  }

  async _pullFromKv() {
    const cursor = this.getLocalCursor();
    const results = await this._kvPipeline([
      ['LRANGE', KV_OPLOG_KEY, cursor, -1]
    ]);
    const list = (results[0] && Array.isArray(results[0].result)) ? results[0].result : [];
    if (list.length === 0) {
      this._lastError = null;
      this._lastPullAt = Date.now();
      return { pulled: 0 };
    }

    const externalOps = [];
    for (const item of list) {
      try {
        const parsed = typeof item === 'string' ? JSON.parse(item) : item;
        if (parsed && parsed.originId !== this.instanceId && Array.isArray(parsed.ops)) {
          externalOps.push(...parsed.ops);
        }
      } catch (_) {}
    }

    const nextCursor = cursor + list.length;
    this._applyExternalOps(externalOps, nextCursor);
    this._lastError = null;
    this._lastPullAt = Date.now();
    return { pulled: externalOps.length, cursor: nextCursor };
  }

  _applyExternalOps(ops, nextCursor) {
    this.db.withSuppressedTracking(() => {
      this.db.transaction((tx) => {
        for (const op of ops) {
          try {
            tx.execute(op.sql, Array.isArray(op.params) ? op.params : []);
          } catch (err) {
            const msg = String(err.message || '');
            if (msg.includes('UNIQUE constraint failed') || msg.includes('PRIMARYKEY')) {
              continue;
            }
            throw err;
          }
        }
        this.setLocalCursor(nextCursor);
      });
    });
  }

  // Push locally recorded mutations atomically to shared remote store
  flushWrites() {
    if (!this.isEnabled() || !this.db.hasPendingWrites()) {
      return Promise.resolve({ pushed: 0 });
    }
    return this._enqueue(async () => {
      const ops = this.db.drainPendingWrites();
      if (ops.length === 0) return { pushed: 0 };

      try {
        if (this.provider === 'turso') {
          await this._ensureTursoSchema();
          const stmts = ops.map(op => ({
            type: 'execute',
            stmt: {
              sql: 'INSERT INTO _tm_oplog (origin_id, sql, params) VALUES (?, ?, ?)',
              args: [
                RemoteSyncManager.toTursoArg(this.instanceId),
                RemoteSyncManager.toTursoArg(op.sql),
                RemoteSyncManager.toTursoArg(JSON.stringify(op.params || []))
              ]
            }
          }));
          await this._tursoPipeline(stmts);
        } else {
          const payload = JSON.stringify({ originId: this.instanceId, ops, ts: Date.now() });
          await this._kvPipeline([
            ['RPUSH', KV_OPLOG_KEY, payload]
          ]);
        }
        this._lastError = null;
        return { pushed: ops.length };
      } catch (err) {
        this._lastError = err.message;
        this.db.requeuePendingWrites(ops);
        console.error('[TripMozy RemoteSync Flush Error]', err.message);
        return { pushed: 0, error: err.message };
      }
    });
  }
}

module.exports = { RemoteSyncManager, CURSOR_META_KEY, KV_OPLOG_KEY };
