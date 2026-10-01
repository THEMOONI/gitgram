const crypto = require('node:crypto') as typeof import('node:crypto');
const { TifiError, iso } = require('./errors.ts') as {
  TifiError: new (code: string, message: string, status?: number) => Error;
  iso: (clock?: () => Date) => string;
};

const LOCK_AFTER = 8;
const LOCK_MS = 15 * 60 * 1000;

const MIN_PASSWORD = 12;

function hashOwnerPassword(password: string): { salt: string; hash: string } {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new TifiError('WEAK_PASSWORD', 'Ägarlösenordet måste vara minst 12 tecken.');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function verifyOwnerPassword(password: string, saltHex: string, hashHex: string): boolean {
  if (typeof password !== 'string' || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function recentFailures(db: any, userId: number, nowIso: string): number {
  const since = new Date(Date.parse(nowIso) - LOCK_MS).toISOString();
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM tifi_auth_attempts WHERE user_id = ? AND failed_at >= ?',
  ).get(userId, since);
  return row ? row.n : 0;
}

function assertOwnerPassword(db: any, userId: number, password: string, clock?: () => Date): void {
  const now = iso(clock);
  if (recentFailures(db, userId, now) >= LOCK_AFTER) {
    throw new TifiError('LOCKED', 'För många försök. Vänta en stund och prova igen.', 429);
  }
  const setup = db.prepare('SELECT password_salt, password_hash FROM tifi_setup WHERE user_id = ?').get(userId);
  if (!setup || !setup.password_hash || !verifyOwnerPassword(password, setup.password_salt, setup.password_hash)) {
    db.prepare('INSERT INTO tifi_auth_attempts (user_id, failed_at) VALUES (?, ?)').run(userId, now);
    throw new TifiError('BAD_PASSWORD', 'Ägarlösenordet stämmer inte.', 403);
  }
}

module.exports = {
  LOCK_AFTER,
  MIN_PASSWORD,
  hashOwnerPassword,
  verifyOwnerPassword,
  assertOwnerPassword,
  recentFailures,
};
