// Paper book for outcome shares. Prices come from the feed. Cash stays in the
// tiger's paper portfolio; this overlay records the stake, the fee, and the
// settlement. It does not sign, and it does not call PayBox.

const { appendAudit } = require('../paper/audit') as { appendAudit: (db: any, entry: any) => string };
const { asMicro } = require('../paper/money') as { asMicro: (value: any) => bigint };
const engine = require('../paper/engine');
const { marketCopy } = require('./labels.ts') as {
  marketCopy: (env?: Record<string, string | undefined>) => { feeNote: (coef: number) => string };
};

const SCALE = 1000000n;
const DEFAULT_FEE_COEF = 800;
const DEFAULT_CLOSE_BUFFER_SEC = 60;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function feeBpsAt(priceMicro: bigint, coef: number): number {
  const price = asMicro(priceMicro);
  const clamped = price < 0n ? 0n : price > SCALE ? SCALE : price;
  const factor = BigInt(clampInt(coef, DEFAULT_FEE_COEF, 0, 10000));
  return Number(factor * (SCALE - clamped) / SCALE);
}

function worldAssumptions(env?: Record<string, string | undefined>): {
  feeCoef: number;
  minOrderMicro: bigint;
  closeBufferSec: number;
  feeNote: string;
} {
  const feeCoef = clampInt(env && env.WORLD_FEE_COEF, DEFAULT_FEE_COEF, 0, 10000);
  const closeBufferSec = clampInt(env && env.WORLD_CLOSE_BUFFER_SEC, DEFAULT_CLOSE_BUFFER_SEC, 0, 14 * 60);
  return {
    feeCoef,
    minOrderMicro: 0n,
    closeBufferSec,
    feeNote: marketCopy(env).feeNote(feeCoef),
  };
}

function priceMicro(value: number | null): bigint | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return BigInt(Math.round(value * 1e6));
}

function quoteBuy(budgetMicro: bigint, askMicro: bigint, feeBps: number): {
  sharesMicro: bigint;
  costMicro: bigint;
  feeMicro: bigint;
  cashDeltaMicro: bigint;
  priceMicro: bigint;
} | null {
  const budget = asMicro(budgetMicro);
  const ask = asMicro(askMicro);
  const bps = BigInt(feeBps);
  if (ask <= 0n || budget <= 0n) return null;
  const costTarget = budget * 10000n / (10000n + bps);
  const shares = costTarget * SCALE / ask;
  if (shares <= 0n) return null;
  const cost = shares * ask / SCALE;
  const fee = cost * bps / 10000n;
  if (cost <= 0n || cost + fee > budget) return null;
  return { sharesMicro: shares, costMicro: cost, feeMicro: fee, cashDeltaMicro: -(cost + fee), priceMicro: ask };
}

function quoteSell(sharesMicro: bigint, bidMicro: bigint, feeBps: number): {
  sharesMicro: bigint;
  proceedsMicro: bigint;
  feeMicro: bigint;
  cashDeltaMicro: bigint;
  priceMicro: bigint;
} | null {
  const shares = asMicro(sharesMicro);
  const bid = asMicro(bidMicro);
  if (shares <= 0n || bid < 0n) return null;
  const proceeds = shares * bid / SCALE;
  const fee = proceeds * BigInt(feeBps) / 10000n;
  return {
    sharesMicro: shares,
    proceedsMicro: proceeds,
    feeMicro: fee,
    cashDeltaMicro: proceeds - fee,
    priceMicro: bid,
  };
}

function positionValue(sharesMicro: bigint, midMicro: bigint): bigint {
  return asMicro(sharesMicro) * asMicro(midMicro) / SCALE;
}

function settlementPayout(sharesMicro: bigint, won: boolean): bigint {
  return won ? asMicro(sharesMicro) : 0n;
}

function num(value: bigint): number {
  return Number(value);
}

function cashDelta(db: any, tigerId: number): bigint {
  const row = db.prepare('SELECT COALESCE(SUM(cash_delta_micro), 0) AS n FROM tifi_world_fills WHERE tiger_id = ?').get(tigerId);
  return asMicro(row ? row.n : 0);
}

function openMark(db: any, tigerId: number): bigint {
  const rows = db.prepare(`
    SELECT shares_micro, last_mid_micro FROM tifi_world_positions
    WHERE tiger_id = ? AND status = 'open' AND shares_micro > 0
  `).all(tigerId);
  let total = 0n;
  for (const row of rows) total += positionValue(asMicro(row.shares_micro), asMicro(row.last_mid_micro));
  return total;
}

function worldAdjustment(db: any, tigerId: number): { cashDelta: bigint; openMark: bigint } {
  return { cashDelta: cashDelta(db, tigerId), openMark: openMark(db, tigerId) };
}

function openStake(db: any, tigerId: number, marketId: string): bigint {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_micro), 0) AS n FROM tifi_world_positions
    WHERE tiger_id = ? AND market_id = ? AND status = 'open'
  `).get(tigerId, marketId);
  return asMicro(row ? row.n : 0);
}

function openPosition(db: any, tigerId: number, marketId: string, outcome: string): any {
  return db.prepare(`
    SELECT * FROM tifi_world_positions
    WHERE tiger_id = ? AND market_id = ? AND outcome = ? AND status = 'open'
  `).get(tigerId, marketId, outcome);
}

function countWorldTrades(db: any, tigerId: number, day: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM tifi_world_fills
    WHERE tiger_id = ? AND side IN ('buy', 'sell') AND substr(ts, 1, 10) = ?
  `).get(tigerId, day);
  return row ? row.n : 0;
}

function feesToday(db: any, tigerId: number, day: string): bigint {
  const row = db.prepare(`
    SELECT COALESCE(SUM(fee_micro), 0) AS n FROM tifi_world_fills
    WHERE tiger_id = ? AND substr(ts, 1, 10) = ?
  `).get(tigerId, day);
  return asMicro(row ? row.n : 0);
}

function availableCash(db: any, tiger: any): bigint {
  const state = engine.readState(db, tiger.portfolio_id);
  const cash = state ? asMicro(state.cashMicro) : 0n;
  const next = cash + cashDelta(db, tiger.id);
  return next > 0n ? next : 0n;
}

function combinedEquity(db: any, tiger: any): bigint {
  const state = engine.readState(db, tiger.portfolio_id);
  const base = state ? asMicro(state.equityMicro) : 0n;
  const extra = worldAdjustment(db, tiger.id);
  return base + extra.cashDelta + extra.openMark;
}

function writeFill(db: any, row: {
  userId: number;
  tigerId: number;
  marketId: string;
  outcome: string;
  side: string;
  sharesMicro: bigint;
  priceMicro: bigint;
  feeMicro: bigint;
  cashDeltaMicro: bigint;
  ts: string;
}): string {
  const hash = appendAudit(db, {
    ts: row.ts,
    actorType: 'system',
    actorId: 'system:tifi',
    action: 'tifi_world_fill',
    payload: {
      tigerId: row.tigerId,
      marketId: row.marketId,
      outcome: row.outcome,
      side: row.side,
      sharesMicro: num(row.sharesMicro),
      priceMicro: num(row.priceMicro),
      feeMicro: num(row.feeMicro),
      cashDeltaMicro: num(row.cashDeltaMicro),
      paper: true,
    },
  });
  db.prepare(`
    INSERT INTO tifi_world_fills (
      user_id, tiger_id, market_id, outcome, side, shares_micro, price_micro,
      fee_micro, cash_delta_micro, ts, audit_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.userId,
    row.tigerId,
    row.marketId,
    row.outcome,
    row.side,
    num(row.sharesMicro),
    num(row.priceMicro),
    num(row.feeMicro),
    num(row.cashDeltaMicro),
    row.ts,
    hash,
  );
  return hash;
}

function buyShares(db: any, args: {
  tiger: any;
  market: any;
  outcome: string;
  budgetMicro: bigint;
  feeBps?: number;
  feeCoef?: number;
  ts: string;
}): any {
  const quote = (args.market.outcomes || []).find((item: any) => item.label === args.outcome);
  const ask = quote ? priceMicro(quote.ask != null ? quote.ask : quote.mid) : null;
  const mid = quote ? priceMicro(quote.mid != null ? quote.mid : quote.ask) : ask;
  if (ask == null || mid == null) return { ok: false, code: 'NO_PRICE' };
  const bps = args.feeBps == null ? feeBpsAt(ask, args.feeCoef == null ? DEFAULT_FEE_COEF : args.feeCoef) : args.feeBps;
  const ticket = quoteBuy(args.budgetMicro, ask, bps);
  if (!ticket) return { ok: false, code: 'MIN_ORDER' };
  if (availableCash(db, args.tiger) < -ticket.cashDeltaMicro) return { ok: false, code: 'CASH' };
  const hash = writeFill(db, {
    userId: args.tiger.user_id,
    tigerId: args.tiger.id,
    marketId: args.market.id,
    outcome: args.outcome,
    side: 'buy',
    sharesMicro: ticket.sharesMicro,
    priceMicro: ticket.priceMicro,
    feeMicro: ticket.feeMicro,
    cashDeltaMicro: ticket.cashDeltaMicro,
    ts: args.ts,
  });
  const existing = openPosition(db, args.tiger.id, args.market.id, args.outcome);
  if (existing) {
    db.prepare(`
      UPDATE tifi_world_positions
      SET shares_micro = shares_micro + ?, cost_micro = cost_micro + ?, last_mid_micro = ?, title = ?
      WHERE tiger_id = ? AND market_id = ? AND outcome = ?
    `).run(num(ticket.sharesMicro), num(ticket.costMicro), num(mid), String(args.market.title || ''), args.tiger.id, args.market.id, args.outcome);
  } else {
    db.prepare(`
      INSERT INTO tifi_world_positions (
        tiger_id, market_id, outcome, shares_micro, cost_micro, last_mid_micro, status, payout_micro, settled_at, title
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', 0, NULL, ?)
    `).run(args.tiger.id, args.market.id, args.outcome, num(ticket.sharesMicro), num(ticket.costMicro), num(mid), String(args.market.title || ''));
  }
  db.prepare('UPDATE tifi_tigers SET last_trade_at = ? WHERE id = ?').run(args.ts, args.tiger.id);
  return { ok: true, hash, ticket };
}

function sellShares(db: any, args: {
  tiger: any;
  market: any;
  outcome: string;
  feeBps?: number;
  feeCoef?: number;
  ts: string;
}): any {
  const position = openPosition(db, args.tiger.id, args.market.id, args.outcome);
  if (!position || asMicro(position.shares_micro) <= 0n) return { ok: false, code: 'NO_POSITION' };
  const quote = (args.market.outcomes || []).find((item: any) => item.label === args.outcome);
  const bid = quote ? priceMicro(quote.bid != null ? quote.bid : quote.mid) : null;
  if (bid == null) return { ok: false, code: 'NO_PRICE' };
  const shares = asMicro(position.shares_micro);
  const bps = args.feeBps == null ? feeBpsAt(bid, args.feeCoef == null ? DEFAULT_FEE_COEF : args.feeCoef) : args.feeBps;
  const ticket = quoteSell(shares, bid, bps);
  if (!ticket) return { ok: false, code: 'NO_PRICE' };
  const hash = writeFill(db, {
    userId: args.tiger.user_id,
    tigerId: args.tiger.id,
    marketId: args.market.id,
    outcome: args.outcome,
    side: 'sell',
    sharesMicro: shares,
    priceMicro: ticket.priceMicro,
    feeMicro: ticket.feeMicro,
    cashDeltaMicro: ticket.cashDeltaMicro,
    ts: args.ts,
  });
  db.prepare(`
    UPDATE tifi_world_positions
    SET shares_micro = 0, cost_micro = 0, status = 'open', last_mid_micro = ?
    WHERE tiger_id = ? AND market_id = ? AND outcome = ?
  `).run(num(bid), args.tiger.id, args.market.id, args.outcome);
  db.prepare('UPDATE tifi_tigers SET last_trade_at = ? WHERE id = ?').run(args.ts, args.tiger.id);
  return { ok: true, hash, ticket };
}

function settlePosition(db: any, args: {
  tiger: any;
  position: any;
  winningOutcome: string;
  ts: string;
}): any {
  if (!args.position || args.position.status === 'settled') return { ok: false, code: 'SETTLED' };
  const shares = asMicro(args.position.shares_micro);
  if (shares <= 0n) {
    db.prepare(`
      UPDATE tifi_world_positions SET status = 'settled', settled_at = ? WHERE tiger_id = ? AND market_id = ? AND outcome = ?
    `).run(args.ts, args.position.tiger_id, args.position.market_id, args.position.outcome);
    return { ok: true, payoutMicro: 0n, skipped: true };
  }
  const won = String(args.winningOutcome || '').toUpperCase() === String(args.position.outcome || '').toUpperCase();
  const payout = settlementPayout(shares, won);
  const hash = writeFill(db, {
    userId: args.tiger.user_id,
    tigerId: args.tiger.id,
    marketId: args.position.market_id,
    outcome: args.position.outcome,
    side: 'settle',
    sharesMicro: shares,
    priceMicro: won ? SCALE : 0n,
    feeMicro: 0n,
    cashDeltaMicro: payout,
    ts: args.ts,
  });
  db.prepare(`
    UPDATE tifi_world_positions
    SET shares_micro = 0, status = 'settled', payout_micro = ?, settled_at = ?, last_mid_micro = ?
    WHERE tiger_id = ? AND market_id = ? AND outcome = ?
  `).run(num(payout), args.ts, won ? num(SCALE) : 0, args.position.tiger_id, args.position.market_id, args.position.outcome);
  return { ok: true, hash, payoutMicro: payout, won };
}

// Overwrites the open position's current mid. This is the mark the book needs,
// not a history of polled prices.
function markOpenToFeed(db: any, userId: number, markets: any[]): void {
  const byId = new Map<string, any>();
  for (const market of markets || []) byId.set(market.id, market);
  const rows = db.prepare(`
    SELECT p.* FROM tifi_world_positions p
    JOIN tifi_tigers t ON t.id = p.tiger_id
    WHERE t.user_id = ? AND p.status = 'open' AND p.shares_micro > 0
  `).all(userId);
  for (const row of rows) {
    const market = byId.get(row.market_id);
    if (!market) continue;
    const quote = (market.outcomes || []).find((item: any) => item.label === row.outcome);
    const mid = quote ? priceMicro(quote.mid) : null;
    if (mid == null) continue;
    db.prepare(`
      UPDATE tifi_world_positions SET last_mid_micro = ? WHERE tiger_id = ? AND market_id = ? AND outcome = ?
    `).run(num(mid), row.tiger_id, row.market_id, row.outcome);
  }
}

async function settleResolved(db: any, tiger: any, feed: { getMarket: (id: string) => Promise<any> }, ts: string): Promise<number> {
  const rows = db.prepare(`
    SELECT * FROM tifi_world_positions WHERE tiger_id = ? AND status = 'open' AND shares_micro > 0
  `).all(tiger.id);
  let settled = 0;
  for (const row of rows) {
    const market = await feed.getMarket(row.market_id);
    if (!market || !market.resolution || !market.resolution.resolved || !market.resolution.winningOutcome) continue;
    const result = settlePosition(db, {
      tiger,
      position: row,
      winningOutcome: market.resolution.winningOutcome,
      ts: market.resolution.resolvedAt || ts,
    });
    if (result && result.ok && !result.skipped) settled += 1;
  }
  return settled;
}

function listPositions(db: any, tigerId: number): { open: any[]; settled: any[] } {
  const rows = db.prepare(`
    SELECT * FROM tifi_world_positions WHERE tiger_id = ? ORDER BY market_id, outcome
  `).all(tigerId);
  return {
    open: rows.filter((row: any) => row.status === 'open' && asMicro(row.shares_micro) > 0n),
    settled: rows.filter((row: any) => row.status === 'settled' && asMicro(row.payout_micro) >= 0n && row.settled_at),
  };
}

module.exports = {
  SCALE,
  DEFAULT_FEE_COEF,
  DEFAULT_CLOSE_BUFFER_SEC,
  feeBpsAt,
  worldAssumptions,
  priceMicro,
  quoteBuy,
  quoteSell,
  positionValue,
  settlementPayout,
  worldAdjustment,
  openStake,
  openPosition,
  countWorldTrades,
  feesToday,
  availableCash,
  combinedEquity,
  buyShares,
  sellShares,
  settlePosition,
  markOpenToFeed,
  settleResolved,
  listPositions,
};
