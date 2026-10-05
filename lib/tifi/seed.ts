const bcrypt = require('bcryptjs');
const { createSyntheticFeed } = require('../paper/feeds') as { createSyntheticFeed: (opts?: any) => any };
const { issueWelcomeGrant } = require('../ledger') as { issueWelcomeGrant: (db: any, userId: number) => any };
const { TifiError, iso } = require('./errors.ts') as {
  TifiError: new (code: string, message: string, status?: number) => Error;
  iso: (clock?: () => Date) => string;
};
const { hashOwnerPassword } = require('./auth.ts') as { hashOwnerPassword: (password: string) => { salt: string; hash: string } };
const { parseTigerSentence } = require('./parser.ts') as { parseTigerSentence: (text: string, opts?: any) => any };
const { fundTreasury, createTiger, allocateToSlots, getTreasury } = require('./treasury.ts') as {
  fundTreasury: (db: any, args: any) => any;
  createTiger: (db: any, userId: number, config: any, slot: number | null, clock?: () => Date) => number;
  allocateToSlots: (db: any, userId: number, key: string, clock?: () => Date) => number[];
  getTreasury: (db: any, userId: number) => any;
};
const { setRunning, stepMany } = require('./runner.ts') as {
  setRunning: (db: any, userId: number, running: boolean, clock?: () => Date) => any;
  stepMany: (db: any, userId: number, count: number, opts?: any) => Promise<any>;
};

const DEFAULT_SENTENCES = [
  'en otålig tiger som bara köper BTC när priset bryter ut över dagens högsta',
  'en lugn tiger som följer ETH-trenden och hellre väntar än jagar',
  'en snabb tiger som rider på momentum i SOL och kliver av när farten dör',
];

function upsertUser(db: any, username: string, password: string, email: string): number {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return Number(existing.id);
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').run(username, email, hash);
  return Number(info.lastInsertRowid);
}

async function seedDemo(db: any, opts: any = {}): Promise<any> {
  const username = opts.username || 'tifi';
  const password = opts.password || 'tifi-demo';
  const ownerPassword = opts.ownerPassword || 'tigerpapper-2026';
  const userId = upsertUser(db, username, password, opts.email || username + '@example.com');
  const setup = db.prepare('SELECT finished_at FROM tifi_setup WHERE user_id = ?').get(userId);
  if (setup && setup.finished_at && !opts.force) {
    return { userId, username, already: true };
  }
  issueWelcomeGrant(db, userId);
  const ts = iso(opts.clock);
  const secret = hashOwnerPassword(ownerPassword);
  db.prepare(`
    INSERT INTO tifi_setup (user_id, risk_accepted_at, password_salt, password_hash, finished_at, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      risk_accepted_at = excluded.risk_accepted_at,
      password_salt = excluded.password_salt,
      password_hash = excluded.password_hash
  `).run(userId, ts, secret.salt, secret.hash, ts);
  if (!getTreasury(db, userId)) {
    fundTreasury(db, {
      userId,
      amountMinor: opts.amountMinor || 100000,
      idempotencyKey: 'tifi-fund-' + userId,
      clock: opts.clock,
    });
  }
  const existingTigers = db.prepare('SELECT COUNT(*) AS n FROM tifi_tigers WHERE user_id = ?').get(userId).n;
  if (!existingTigers) {
    DEFAULT_SENTENCES.forEach((sentence, index) => {
      const slot = index + 1;
      const parsed = parseTigerSentence(sentence, { slot });
      if (!parsed.ok || !parsed.config) throw new TifiError('PARSE', parsed.errors.join(' '));
      parsed.config.portraitVariant = slot;
      createTiger(db, userId, parsed.config, slot, opts.clock);
    });
    allocateToSlots(db, userId, 'tifi-split-' + userId, opts.clock);
  }
  const feed = opts.feed || createSyntheticFeed({ seed: 20261001 });
  await stepMany(db, userId, opts.steps == null ? 48 : opts.steps, { feed, clock: opts.clock, env: {} });
  setRunning(db, userId, true, opts.clock);
  db.prepare('UPDATE tifi_setup SET finished_at = ? WHERE user_id = ?').run(iso(opts.clock), userId);
  return { userId, username, password, already: false };
}

module.exports = {
  DEFAULT_SENTENCES,
  seedDemo,
};
