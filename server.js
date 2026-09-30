const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const compression = require('compression');
const moment = require('moment');
const Database = require('better-sqlite3');

const applySchema = require('./lib/schema');
const { createSessionStore } = require('./lib/session-store');
const { REPO_ROOT } = require('./lib/paths');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// A secret that changes between boots silently invalidates every session, so
// production requires an explicit one rather than falling back to a random value.
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (IS_PRODUCTION) {
    console.error('SESSION_SECRET must be set when NODE_ENV=production.');
    process.exit(1);
  }
  console.warn('SESSION_SECRET is not set; using a random secret. Sessions will not survive a restart.');
  return crypto.randomBytes(32).toString('hex');
}

const dbDirectory = path.join(__dirname, 'db');
fs.mkdirSync(dbDirectory, { recursive: true });
fs.mkdirSync(REPO_ROOT, { recursive: true });

const db = new Database(path.join(dbDirectory, 'gitgram.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
applySchema(db);

const sessionStore = createSessionStore(db, { ttlMs: SESSION_MAX_AGE_MS });

app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: IS_PRODUCTION ? '1d' : 0 }));

app.use(
  session({
    name: 'gitgram.sid',
    secret: resolveSessionSecret(),
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: SESSION_MAX_AGE_MS,
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PRODUCTION,
    },
  })
);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
  res.locals.currentUser = req.session.userId
    ? db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.userId)
    : null;
  res.locals.moment = moment;
  res.locals.publicUrl = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  next();
});

app.get('/', (req, res) => {
  const repos = db
    .prepare(
      `SELECT r.*, u.username as owner_name FROM repositories r
       JOIN users u ON r.owner_id = u.id
       WHERE r.private = 0 ORDER BY r.updated_at DESC LIMIT 20`
    )
    .all();
  res.render('index', { title: 'GITGRAM - Your Own Git Platform', repos });
});

app.use('/', require('./routes/auth')(db));
app.use('/', require('./routes/git')(db));
app.use('/', require('./routes/repos')(db));
app.use('/api', require('./routes/api')(db));

app.use((req, res) => {
  res.status(404).render('404', { title: 'Not Found - GITGRAM' });
});

// Without this, an unexpected throw renders Express's default handler, which
// returns a full stack trace to the browser.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.destroy();
  res.status(500).render('error', {
    title: 'Error - GITGRAM',
    detail: IS_PRODUCTION ? null : err && err.stack,
  });
});

const server = app.listen(PORT, () => {
  console.log(`GITGRAM running on http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  server.close(() => {
    sessionStore.stopPruning();
    db.close();
    process.exit(0);
  });
}

['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => shutdown(signal)));

module.exports = { app, server, db };
