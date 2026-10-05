const http = require('http');
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const Database = require('better-sqlite3');
const moment = require('moment');
const { csrfProtection } = require('./lib/csrf');
const { ensureTeamSchema } = require('./lib/team/schema');
const { loadTeamConfig, resolveMaxHops } = require('./lib/team/config');
const { createTeamService } = require('./lib/team/service');
const { createHub, attachTeamRealtime } = require('./lib/team/realtime');
const { createRateLimiter } = require('./lib/team/ratelimit');
const { createVoiceProvider, voiceRetentionEnabled } = require('./lib/team/voice');
const { createWatcherClient, watcherOrigin } = require('./lib/team/trading/watcher');
const mountTeam = require('./routes/team');

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
  const teamConfig = loadTeamConfig();
  ensureTeamSchema(db, teamConfig);
  const maxHops = resolveMaxHops(teamConfig, process.env, options.maxHops);
  const voice = options.voice || createVoiceProvider(process.env);
  const retainVoiceAudio = voiceRetentionEnabled(teamConfig, process.env, options.retainVoiceAudio);
  const flagsToken = options.flagsToken !== undefined ? options.flagsToken : (process.env.TEAM_FLAGS_TOKEN || '');
  const messageLimiter = createRateLimiter({
    windowMs: options.messageRateLimit?.windowMs || 60_000,
    max: options.messageRateLimit?.max || teamConfig.messageRateLimit,
  });
  const flagLimiter = createRateLimiter({
    windowMs: options.flagRateLimit?.windowMs || 60_000,
    max: options.flagRateLimit?.max || teamConfig.flagRateLimit,
  });
  const tradingLimiter = createRateLimiter({
    windowMs: options.tradingRateLimit?.windowMs || 60_000,
    max: options.tradingRateLimit?.max || teamConfig.tradingAlertRateLimit || 10,
  });
  const tradingAlertsToken = options.tradingAlertsToken !== undefined
    ? options.tradingAlertsToken
    : (process.env.TRADING_ALERTS_TOKEN || '');
  const tradingWatcherUrl = options.tradingWatcherUrl !== undefined
    ? options.tradingWatcherUrl
    : (process.env.TRADING_WATCHER_URL || '');
  const tradingExcludeFile = options.tradingExcludeFile !== undefined
    ? options.tradingExcludeFile
    : (process.env.TRADING_EXCLUDE_FILE || '');
  const ownerUsername = options.ownerUsername !== undefined
    ? options.ownerUsername
    : (process.env.TEAM_OWNER_USERNAME || '');
  const minLiquidityUsd = options.tradingMinLiquidity !== undefined
    ? Number(options.tradingMinLiquidity)
    : Number(process.env.TRADING_MIN_LIQUIDITY_USD || teamConfig.tradingMinLiquidityUsd || 10000);
  const quietHours = options.tradingQuietHours !== undefined
    ? options.tradingQuietHours
    : (process.env.TRADING_QUIET_HOURS || '0-7');
  const origin = watcherOrigin(tradingWatcherUrl);
  if (tradingWatcherUrl && !origin) {
    console.warn('TRADING_WATCHER_URL is invalid. Trading pull stays off.');
  }
  const watcherState = {
    configured: Boolean(origin),
    pumpportalConnected: null,
    lastEventMs: 0,
    streamConnected: false,
  };
  const hub = createHub();
  const teamService = createTeamService(db, {
    config: teamConfig,
    dataDir,
    maxHops,
    hub,
    ownerUsername,
    excludeFile: tradingExcludeFile,
    minLiquidityUsd,
    tradingLimiter,
    now: options.tradingNow,
    quietHours,
    watcherState,
  });
  let tradingWatcher = null;
  if (origin) {
    tradingWatcher = createWatcherClient({
      origin,
      sinceMs: teamService.trading.latestTs(),
      onAlert: (payload) => teamService.trading.ingest(payload),
      onStats: (stats) => teamService.trading.noteStats(stats),
      onStream: (connected) => teamService.trading.noteStream(connected),
      baseDelayMs: options.tradingReconnect?.baseDelayMs,
      maxDelayMs: options.tradingReconnect?.maxDelayMs,
      statsIntervalMs: options.tradingReconnect?.statsIntervalMs,
    });
  }

  const app = express();
  const port = process.env.PORT || 3000;
  const csrf = csrfProtection();
  const sessionMiddleware = session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
    },
  });

  app.disable('x-powered-by');
  app.locals.db = db;
  app.locals.dataDir = dataDir;
  app.locals.teamHub = hub;
  app.locals.teamService = teamService;
  app.locals.watcherState = watcherState;
  app.locals.tradingWatcher = tradingWatcher;
  app.locals.stopTradingWatcher = () => {
    if (tradingWatcher) tradingWatcher.stop();
  };
  app.locals.teamMessageLimiter = messageLimiter;
  app.locals.voice = voice;
  app.locals.retainVoiceAudio = retainVoiceAudio;
  app.locals.sessionMiddleware = sessionMiddleware;
  app.locals.attachRealtime = (server) => attachTeamRealtime(server, app);

  app.use(compression());
  app.use(express.json({
    limit: '4mb',
    type: (req) => req.path.startsWith('/api/team') && /^application\/json/i.test(req.headers['content-type'] || ''),
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use(sessionMiddleware);
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
    next();
  });

  app.use('/', require('./routes/auth')(db, { loginRateLimit: options.loginRateLimit }));
  app.use('/', require('./routes/git')(db, { dataDir }));
  mountTeam(app, {
    service: teamService,
    voice,
    config: teamConfig,
    dataDir,
    retainVoiceAudio,
    flagsToken,
    messageLimiter,
    flagLimiter,
    tradingAlertsToken,
    tradingLimiter,
  });
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
    const server = http.createServer(app);
    app.locals.attachRealtime(server);
    server.listen(port, () => {
      console.log('🚀 GITGRAM running on http://localhost:' + port);
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { createApp };
