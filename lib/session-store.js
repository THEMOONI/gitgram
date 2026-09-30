const { Store } = require('express-session');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// express-session's default MemoryStore leaks and drops every login on
// restart. The app already depends on better-sqlite3, so sessions are kept in
// the same database instead of adding another dependency.
function createSessionStore(db, { ttlMs = DEFAULT_TTL_MS } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  `);

  const statements = {
    get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
    set: db.prepare(
      `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
    ),
    destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
    touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
    prune: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    clear: db.prepare('DELETE FROM sessions'),
    length: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?'),
  };

  function expiryFor(session) {
    const cookieExpires = session && session.cookie && session.cookie.expires;
    if (cookieExpires) return new Date(cookieExpires).getTime();
    return Date.now() + ttlMs;
  }

  class SqliteStore extends Store {
    get(sid, callback) {
      try {
        const row = statements.get.get(sid);
        if (!row) return callback(null, null);
        if (row.expires_at <= Date.now()) {
          statements.destroy.run(sid);
          return callback(null, null);
        }
        return callback(null, JSON.parse(row.data));
      } catch (error) {
        return callback(error);
      }
    }

    set(sid, session, callback = () => {}) {
      try {
        statements.set.run(sid, JSON.stringify(session), expiryFor(session));
        return callback(null);
      } catch (error) {
        return callback(error);
      }
    }

    destroy(sid, callback = () => {}) {
      try {
        statements.destroy.run(sid);
        return callback(null);
      } catch (error) {
        return callback(error);
      }
    }

    touch(sid, session, callback = () => {}) {
      try {
        statements.touch.run(expiryFor(session), sid);
        return callback(null);
      } catch (error) {
        return callback(error);
      }
    }

    clear(callback = () => {}) {
      try {
        statements.clear.run();
        return callback(null);
      } catch (error) {
        return callback(error);
      }
    }

    length(callback = () => {}) {
      try {
        return callback(null, statements.length.get(Date.now()).count);
      } catch (error) {
        return callback(error);
      }
    }
  }

  const store = new SqliteStore();
  statements.prune.run(Date.now());
  const timer = setInterval(() => statements.prune.run(Date.now()), PRUNE_INTERVAL_MS);
  timer.unref();
  store.stopPruning = () => clearInterval(timer);

  return store;
}

module.exports = { createSessionStore };
