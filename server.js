const express = require('express');
const session = require('express-session');
const path = require('path');
const compression = require('compression');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;

function initDatabase(db) {
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

function createApp(db, options = {}) {
  const app = express();

  app.use(compression());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use(session({
    secret: options.sessionSecret || ('gitgram-secret-' + Date.now()),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
  }));

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use((req, res, next) => {
    res.locals.currentUser = req.session.userId ? db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.userId) : null;
    res.locals.moment = require('moment');
    res.locals.publicUrl = process.env.PUBLIC_URL || 'http://localhost:' + PORT;
    next();
  });

  const authRoutes = require('./routes/auth')(db);
  const gitRoutes = require('./routes/git')(db);
  const repoRoutes = require('./routes/repos')(db);
  const apiRoutes = require('./routes/api')(db);

  app.use('/', authRoutes);
  app.use('/', gitRoutes);
  app.use('/', repoRoutes);
  app.use('/api', apiRoutes);

  app.get('/', (req, res) => {
    const repos = db.prepare(`SELECT r.*, u.username as owner_name FROM repositories r JOIN users u ON r.owner_id = u.id WHERE r.private = 0 ORDER BY r.updated_at DESC LIMIT 20`).all();
    res.render('index', { title: 'GITGRAM - Your Own Git Platform', repos });
  });

  return app;
}

if (require.main === module) {
  const db = initDatabase(new Database(path.join(__dirname, 'db', 'gitgram.db')));
  const app = createApp(db);
  app.listen(PORT, () => {
    console.log('🚀 GITGRAM running on http://localhost:' + PORT);
  });
}

module.exports = { createApp, initDatabase };
