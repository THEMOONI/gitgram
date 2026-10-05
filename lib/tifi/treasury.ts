const engine = require('../paper/engine');
const { appendAudit } = require('../paper/audit') as { appendAudit: (db: any, entry: any) => string };
const { microToMinorFloor } = require('../paper/money') as { microToMinorFloor: (value: bigint) => bigint };
const { TifiError, iso, userActor } = require('./errors.ts') as {
  TifiError: new (code: string, message: string, status?: number) => Error;
  iso: (clock?: () => Date) => string;
  userActor: (userId: number) => any;
};
const { validateLimits } = require('./guard.ts') as { validateLimits: (limits: any) => string[] };
const { marketCopy } = require('./labels.ts') as {
  marketCopy: (env?: Record<string, string | undefined>) => { venueOption: string };
};

const WHITELIST = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'];

function treasuryRisk(): any {
  return {
    maxPositionPct: 1,
    maxOpenPositions: 1,
    maxOrderValuePct: 1,
    maxTradesPerDay: 1,
    defaultStopLossPct: 1,
    maxDrawdownPct: 20,
    minCashPct: 5,
    whitelist: WHITELIST,
  };
}

function tigerRisk(config: any): any {
  const symbols = Array.isArray(config.symbols) ? config.symbols : [];
  const position = Math.min(10, Math.max(1, Math.round(Number(config.maxPositionPct) || 10)));
  return {
    maxPositionPct: position,
    maxOpenPositions: Math.min(3, Math.max(1, symbols.length || 1)),
    maxOrderValuePct: position,
    maxTradesPerDay: config.maxTradesPerDay,
    defaultStopLossPct: config.stopPct,
    maxDrawdownPct: 20,
    minCashPct: 5,
    whitelist: symbols,
  };
}

function limitsOf(config: any): any {
  return {
    maxLeverage: config.maxLeverage,
    maxStopPct: config.stopPct,
    dailyLossPct: config.dailyLossPct,
    maxTradesPerDay: config.maxTradesPerDay,
    cooldownSec: config.cooldownSec,
    maxPositionPct: config.maxPositionPct,
    feeBudgetPct: config.feeBudgetPct,
    symbols: config.symbols,
  };
}

function getTreasury(db: any, userId: number): any {
  return db.prepare('SELECT * FROM tifi_treasury WHERE user_id = ?').get(userId) || null;
}

function ensureTreasury(db: any, userId: number, clock?: () => Date): any {
  const existing = getTreasury(db, userId);
  if (existing) return existing;
  const portfolioId = engine.createPortfolio(db, {
    userId,
    agentLabel: 'tifi:treasury',
    risk: treasuryRisk(),
    actor: userActor(userId),
    clock,
  });
  const ts = iso(clock);
  db.prepare(
    'INSERT INTO tifi_treasury (user_id, portfolio_id, weights_json, created_at) VALUES (?, ?, ?, ?)',
  ).run(userId, portfolioId, JSON.stringify([34, 33, 33]), ts);
  return getTreasury(db, userId);
}

function freeMinor(state: any): number {
  if (!state) return 0;
  const cash = Number(microToMinorFloor(state.cashMicro));
  return Math.max(0, Math.min(cash, state.parkedMinor));
}

function recordTransfer(db: any, userId: number, fromRef: string, toRef: string, amountMinor: number, note: string, clock?: () => Date): string {
  const ts = iso(clock);
  const hash = appendAudit(db, {
    ts,
    actorType: 'user',
    actorId: 'user:' + userId,
    action: 'tifi_transfer',
    payload: {
      userId,
      from: fromRef,
      to: toRef,
      amountMinor,
      unit: 'GGT (demo)',
      note,
    },
  });
  db.prepare(`
    INSERT INTO tifi_transfers (user_id, from_ref, to_ref, amount_minor, note, created_at, audit_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, fromRef, toRef, amountMinor, note, ts, hash);
  return hash;
}

function alreadyNoted(db: any, userId: number, note: string): boolean {
  return !!db.prepare('SELECT id FROM tifi_transfers WHERE user_id = ? AND note = ?').get(userId, note);
}

function fundTreasury(db: any, args: { userId: number; amountMinor: number; idempotencyKey: string; clock?: () => Date }): any {
  if (!Number.isInteger(args.amountMinor) || args.amountMinor <= 0) {
    throw new TifiError('AMOUNT', 'Beloppet måste vara ett positivt antal DEMO-cent.');
  }
  const treasury = ensureTreasury(db, args.userId, args.clock);
  const note = 'fund:' + args.idempotencyKey;
  const state = engine.allocate(db, {
    portfolioId: treasury.portfolio_id,
    amountMinor: args.amountMinor,
    idempotencyKey: args.idempotencyKey,
    actor: userActor(args.userId),
    clock: args.clock,
  });
  if (!alreadyNoted(db, args.userId, note)) {
    recordTransfer(db, args.userId, 'wallet', 'treasury', args.amountMinor, note, args.clock);
  }
  return state;
}

function portfolioFor(db: any, userId: number, ref: string): { portfolioId: number; tigerId: number | null } {
  if (ref === 'treasury') {
    const treasury = getTreasury(db, userId);
    if (!treasury) throw new TifiError('NO_TREASURY', 'Kassan finns inte ännu.');
    return { portfolioId: treasury.portfolio_id, tigerId: null };
  }
  const tiger = db.prepare('SELECT * FROM tifi_tigers WHERE user_id = ? AND id = ?').get(userId, Number(ref));
  if (!tiger) throw new TifiError('NOT_FOUND', 'Tigern finns inte.', 404);
  return { portfolioId: tiger.portfolio_id, tigerId: tiger.id };
}

function adjustAllocated(db: any, tigerId: number | null, delta: number): void {
  if (tigerId == null) return;
  db.prepare('UPDATE tifi_tigers SET allocated_minor = MAX(0, allocated_minor + ?) WHERE id = ?').run(delta, tigerId);
}

function hop(db: any, args: {
  userId: number;
  fromRef: string;
  toRef: string;
  amountMinor: number;
  idempotencyKey: string;
  clock?: () => Date;
}): void {
  const from = portfolioFor(db, args.userId, args.fromRef);
  const to = portfolioFor(db, args.userId, args.toRef);
  const state = engine.readState(db, from.portfolioId);
  if (args.amountMinor > freeMinor(state)) {
    throw new TifiError('FREE_CASH', 'Bara ledig kassa kan flyttas. Öppna positioner stannar.');
  }
  const actor = userActor(args.userId);
  engine.withdraw(db, {
    portfolioId: from.portfolioId,
    amountMinor: args.amountMinor,
    idempotencyKey: args.idempotencyKey + '-w',
    actor,
    clock: args.clock,
  });
  engine.allocate(db, {
    portfolioId: to.portfolioId,
    amountMinor: args.amountMinor,
    idempotencyKey: args.idempotencyKey + '-a',
    actor,
    clock: args.clock,
  });
  adjustAllocated(db, from.tigerId, -args.amountMinor);
  adjustAllocated(db, to.tigerId, args.amountMinor);
  recordTransfer(db, args.userId, args.fromRef, args.toRef, args.amountMinor, 'move:' + args.idempotencyKey, args.clock);
}

function moveCash(db: any, args: {
  userId: number;
  fromRef: string;
  toRef: string;
  amountMinor: number;
  idempotencyKey: string;
  clock?: () => Date;
}): void {
  if (args.fromRef === args.toRef) throw new TifiError('SAME', 'Välj två olika konton.');
  if (!Number.isInteger(args.amountMinor) || args.amountMinor <= 0) {
    throw new TifiError('AMOUNT', 'Beloppet måste vara ett positivt antal DEMO-cent.');
  }
  const bothTigers = args.fromRef !== 'treasury' && args.toRef !== 'treasury';
  db.transaction(() => {
    if (bothTigers) {
      hop(db, { ...args, toRef: 'treasury', idempotencyKey: args.idempotencyKey + '-in' });
      hop(db, { ...args, fromRef: 'treasury', idempotencyKey: args.idempotencyKey + '-out' });
      return;
    }
    hop(db, args);
  })();
}

function createTiger(db: any, userId: number, config: any, slot: number | null, clock?: () => Date): number {
  const errors = validateLimits(limitsOf(config));
  if (errors.length) {
    throw new TifiError('LIMITS', 'Konfigurationen ryms inte inom motorns tak: ' + errors.join(', ') + '.');
  }
  const portfolioId = engine.createPortfolio(db, {
    userId,
    agentLabel: 'tifi:tiger',
    risk: tigerRisk(config),
    actor: userActor(userId),
    clock,
  });
  const ts = iso(clock);
  const info = db.prepare(`
    INSERT INTO tifi_tigers (
      user_id, slot, name, tagline, strategy, params_json, symbols_json, status, pause_reason,
      portfolio_id, max_leverage, max_stop_pct, daily_loss_pct, max_trades_per_day, cooldown_sec,
      max_position_pct, fee_budget_pct, portrait_variant, allocated_minor, day_utc,
      day_start_equity_micro, last_trade_at, rules_text, venue, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?, ?)
  `).run(
    userId,
    slot,
    config.name,
    config.tagline,
    config.strategy,
    JSON.stringify(config.params || {}),
    JSON.stringify(config.symbols),
    portfolioId,
    config.maxLeverage,
    config.stopPct,
    config.dailyLossPct,
    config.maxTradesPerDay,
    config.cooldownSec,
    config.maxPositionPct,
    config.feeBudgetPct,
    config.portraitVariant || slot || 1,
    config.rulesText || '',
    config.venue === 'paper' ? 'paper' : 'world',
    ts,
  );
  return Number(info.lastInsertRowid);
}

function setTigerVenue(db: any, userId: number, tigerId: number, venue: string): void {
  if (venue !== 'paper' && venue !== 'world') {
    throw new TifiError('VENUE', 'Välj pappersmarknad eller ' + marketCopy(process.env).venueOption + '.');
  }
  const info = db.prepare('UPDATE tifi_tigers SET venue = ? WHERE id = ? AND user_id = ?').run(venue, tigerId, userId);
  if (!info.changes) throw new TifiError('NOT_FOUND', 'Tigern finns inte.', 404);
}

function listTigers(db: any, userId: number): any[] {
  return db.prepare('SELECT * FROM tifi_tigers WHERE user_id = ? ORDER BY COALESCE(slot, 99), id').all(userId);
}

function splitEqual(total: number, parts: number): number[] {
  if (parts <= 0 || total <= 0) return [];
  const base = Math.floor(total / parts);
  let extra = total - base * parts;
  const out: number[] = [];
  for (let i = 0; i < parts; i += 1) {
    const add = extra > 0 ? 1 : 0;
    extra -= add;
    out.push(base + add);
  }
  return out;
}

function allocateToSlots(db: any, userId: number, idempotencyKey: string, clock?: () => Date): number[] {
  const treasury = getTreasury(db, userId);
  if (!treasury) throw new TifiError('NO_TREASURY', 'Kassan finns inte ännu.');
  const tigers = db.prepare(
    'SELECT * FROM tifi_tigers WHERE user_id = ? AND slot IN (1, 2, 3) ORDER BY slot',
  ).all(userId);
  const free = freeMinor(engine.readState(db, treasury.portfolio_id));
  const parts = splitEqual(free, tigers.length);
  tigers.forEach((tiger: any, index: number) => {
    const amount = parts[index] || 0;
    if (amount <= 0) return;
    moveCash(db, {
      userId,
      fromRef: 'treasury',
      toRef: String(tiger.id),
      amountMinor: amount,
      idempotencyKey: idempotencyKey + '-s' + tiger.slot,
      clock,
    });
  });
  return parts;
}

module.exports = {
  WHITELIST,
  getTreasury,
  ensureTreasury,
  fundTreasury,
  freeMinor,
  moveCash,
  createTiger,
  setTigerVenue,
  listTigers,
  splitEqual,
  allocateToSlots,
  limitsOf,
};
