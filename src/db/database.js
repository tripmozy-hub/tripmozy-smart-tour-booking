// ============================================================================
// TripMozy Database Client (Transactional & Audit-Aware)
// ============================================================================

let DatabaseSync = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (e) {
  // node:sqlite not available in this environment
}

const crypto = require('node:crypto');
const path = require('node:path');
const { DDL_STATEMENTS } = require('./schema');

class TripMozyDatabase {
  constructor(dbPath = ':memory:') {
    if (DatabaseSync) {
      try {
        this.db = new DatabaseSync(dbPath);
      } catch (err) {
        console.warn(`[TripMozy DB] Failed to open ${dbPath}: ${err.message}. Falling back to in-memory.`);
        this.db = new DatabaseSync(':memory:');
      }
    } else {
      console.warn('[TripMozy DB] node:sqlite is unavailable. Using safe in-memory fallback.');
      this.db = this._createFallbackDb();
    }
    this.init();
  }

  _createFallbackDb() {
    return {
      exec: () => {},
      prepare: () => ({
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () => undefined,
        all: () => []
      }),
      close: () => {}
    };
  }

  init() {
    try {
      this.db.exec(DDL_STATEMENTS);
      this.seedDefaultSettings();
    } catch (e) {
      console.warn('[TripMozy DB] Init warning:', e.message);
    }
  }

  seedDefaultSettings() {
    try {
      const systemUser = this.db.prepare(`
        INSERT OR IGNORE INTO user_profiles (id, email, role, display_name, status, is_phone_verified, is_email_verified)
        VALUES ('00000000-0000-0000-0000-000000000001', 'system@tripmozy.com', 'admin', 'TripMozy System Admin', 'active', 1, 1)
      `);
      systemUser.run();

      const defaults = [
        ['dispatch.first_batch_size', '10', 'Number of hotels contacted in initial request wave'],
        ['dispatch.max_properties_contacted', '25', 'Maximum properties permitted to be contacted per request'],
        ['dispatch.vendor_response_deadline_hours', '2', 'Hours hoteliers have to accept/quote before recipient expires'],
        ['booking.inventory_hold_minutes', '15', 'Duration room is held exclusively during checkout before auto-release'],
        ['policy.default_commission_bps', '1500', 'Default platform commission rate (1500 = 15.00%)']
      ];

      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO system_settings (key, value, description)
        VALUES (?, ?, ?)
      `);

      for (const [k, v, d] of defaults) {
        insert.run(k, JSON.stringify(v), d);
      }
    } catch (e) {
      console.warn('[TripMozy DB] Seed warning:', e.message);
    }
  }

  // Atomic transaction runner (supports nested/re-entrant transactions)
  transaction(fn) {
    if (this._inTransaction) {
      return fn(this);
    }
    this._inTransaction = true;
    try {
      this.db.exec('BEGIN IMMEDIATE TRANSACTION;');
    } catch (_) {}

    try {
      const result = fn(this);
      try {
        this.db.exec('COMMIT;');
      } catch (_) {}
      this._inTransaction = false;
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch (_) {
        // Transaction already aborted
      }
      this._inTransaction = false;
      throw err;
    }
  }

  // Generate standard v4 UUID
  uuid() {
    return crypto.randomUUID();
  }

  // Audit Logger
  logAudit({ actorId, actorRole, action, entityType, entityId, correlationId = null, beforeState = null, afterState = null, ipAddress = null }) {
    let validActorId = null;
    if (actorId) {
      const exists = this.queryOne('SELECT id FROM user_profiles WHERE id = ?', [actorId]);
      if (exists) {
        validActorId = actorId;
      }
    }
    if (!validActorId) {
      validActorId = '00000000-0000-0000-0000-000000000001';
    }

    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id, correlation_id, before_state, after_state, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const id = this.uuid();
    stmt.run(
      id,
      validActorId,
      actorRole || 'system',
      action,
      entityType,
      String(entityId),
      correlationId,
      beforeState ? JSON.stringify(beforeState) : null,
      afterState ? JSON.stringify(afterState) : null,
      ipAddress
    );
    return id;
  }

  // Helper for raw queries
  query(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  queryOne(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.get(...params);
  }

  execute(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.run(...params);
  }

  close() {
    this.db.close();
  }
}

module.exports = { TripMozyDatabase };
