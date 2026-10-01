const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const Database = require('better-sqlite3');
const moment = require('moment');
const { csrfProtection } = require('./lib/csrf');
const { ensureLedgerSchema } = require('./lib/ledger');
const { ensurePaperSchema } = require('./lib/paper/schema');

const DEV_SESSION_SECRET = 'dev-only-insecure-session-secret';
let warnedAboutSessionSecret = false;

function resolveSessionSecret(explicit) {
  const provided = typeof explicit === 'string' ? explicit.trim() : '';
  const fromEnv = typeof process.env.SESSION_SECRET === 'string' ? process.env.SESSION_SECRET.trim() : '';
  const secret = provided || fromEnv;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required in production. Set it to a long random string.');
  }
  if (!warnedAboutSessionSecret) {
    warnedAboutSessionSecret = true;
    console.warn('WARNING: SESSION_SECRET is not set. Using an insecure development fallback. Set SESSION_SECRET to a long random string before deploying.');
  }
  return DEV_SESSION_SECRET;
}

function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      bio TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      full_name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      owner_id INTEGER NOT NULL,
      private INTEGER DEFAULT 0,
      default_branch TEXT DEFAULT 'main',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  return db;
}

function createApp(options = {}) {
  const sessionSecret = resolveSessionSecret(options.sessionSecret);
  const dbPath = options.dbPath || process.env.GITGRAM_DB || path.join(__dirname, 'db', 'gitgram.db');
  const dataDir = options.dataDir || process.env.GITGRAM_DATA || path.join(__dirname, 'data');
  fs.mkdirSync(path.join(dataDir, 'repos'), { recursive: true });

  const db = openDatabase(dbPath);
  ensureLedgerSchema(db);
  ensurePaperSchema(db);
  const app = express();
  const port = process.env.PORT || 3000;
  const csrf = csrfProtection();

  app.disable('x-powered-by');
  app.locals.db = db;
  app.locals.dataDir = dataDir;

  app.use(compression());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
    },
  }));
  app.use(csrf.ensure);
  app.use(csrf.verify);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use((req, res, next) => {
    res.locals.currentUser = req.session.userId
      ? db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.userId)
      : null;
    res.locals.moment = moment;
    res.locals.publicUrl = process.env.PUBLIC_URL || 'http://localhost:' + port;
    res.locals.navWallet = false;
    res.locals.navTrade = false;
    next();
  });

  app.use('/', require('./routes/auth')(db));
  // Wallet routes are registered before /:owner/:repo so /wallet is never a profile or repository.
  app.use('/', require('./routes/wallet')(db));
  app.use('/', require('./routes/paper')(db, {
    dataDir,
    priceFeed: options.priceFeed,
    clock: options.clock,
    geo: options.geo,
    priceCacheKey: options.priceCacheKey,
  }));
  app.use('/', require('./routes/git')(db, { dataDir }));
  app.use('/', require('./routes/repos')(db, { dataDir }));
  app.use('/api', require('./routes/api')(db));

  app.get('/', (req, res) => {
    const repos = db.prepare(`
      SELECT r.*, u.username as owner_name
      FROM repositories r
      JOIN users u ON r.owner_id = u.id
      WHERE r.private = 0
      ORDER BY r.updated_at DESC
      LIMIT 20
    `).all();
    res.render('index', { title: 'GITGRAM - Your Own Git Platform', repos });
  });

  app.use((req, res) => {
    res.status(404).render('404', { title: 'Not Found - GITGRAM' });
  });

  return app;
}

if (require.main === module) {
  try {
    const app = createApp();
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
      console.log('🚀 GITGRAM running on http://localhost:' + port);
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { createApp };
