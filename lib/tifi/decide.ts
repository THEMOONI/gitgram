const engine = require('../paper/engine');
const { appendAudit } = require('../paper/audit') as { appendAudit: (db: any, entry: any) => string };
const { asMicro } = require('../paper/money') as { asMicro: (value: any) => bigint };
const { evaluateGuard, dailyLossTripped, rollUtcDay } = require('./guard.ts') as {
  evaluateGuard: (ctx: any) => any;
  dailyLossTripped: (start: bigint | null, equity: bigint, cap: number) => boolean;
  rollUtcDay: (state: any, today: string) => { status: string; pauseReason: string | null; reset: boolean };
};
const { selectSignal } = require('./strategies.ts') as { selectSignal: (...args: any[]) => any };
const { limitsOf } = require('./treasury.ts') as { limitsOf: (config: any) => any };
const { publish } = require('./events.ts') as { publish: (event: any) => void };
const { utcDay } = require('./errors.ts') as { utcDay: (value: string) => string };

function tigerLimits(row: any): any {
  return limitsOf({
    maxLeverage: Number(row.max_leverage),
    stopPct: row.max_stop_pct,
    dailyLossPct: row.daily_loss_pct,
    maxTradesPerDay: row.max_trades_per_day,
    cooldownSec: row.cooldown_sec,
    maxPositionPct: row.max_position_pct,
    feeBudgetPct: row.fee_budget_pct,
    symbols: JSON.parse(row.symbols_json),
  });
}

function countTrades(db: any, portfolioId: number, day: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM paper_fills f
    JOIN paper_orders o ON o.id = f.order_id
    WHERE f.portfolio_id = ? AND o.protective = 0 AND substr(f.filled_at, 1, 10) = ?
  `).get(portfolioId, day);
  return row ? row.n : 0;
}

function feesToday(db: any, portfolioId: number, day: string): bigint {
  const row = db.prepare(`
    SELECT COALESCE(SUM(fee_micro), 0) AS n
    FROM paper_fills
    WHERE portfolio_id = ? AND substr(filled_at, 1, 10) = ?
  `).get(portfolioId, day);
  return asMicro(row ? row.n : 0);
}

function logDecision(db: any, row: any): string {
  const hash = appendAudit(db, {
    ts: row.ts,
    actorType: 'system',
    actorId: 'system:tifi',
    action: 'tifi_decision',
    payload: {
      tigerId: row.tigerId,
      proposal: row.proposal,
      rationale: row.rationale,
      probabilities: row.probabilities,
      guardVerdict: row.verdict,
      guardReasons: row.reasons,
      clientOrderId: row.clientOrderId,
      modelId: row.modelId,
      modelCostMicro: row.modelCostMicro,
    },
  });
  db.prepare(`
    INSERT INTO tifi_decisions (
      user_id, tiger_id, ts, bar_ts, model_id, proposal_json, rationale, probabilities_json,
      guard_verdict, guard_reasons_json, client_order_id, model_cost_micro, audit_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.userId,
    row.tigerId,
    row.ts,
    row.barTs,
    row.modelId,
    JSON.stringify(row.proposal),
    row.rationale,
    JSON.stringify(row.probabilities),
    row.verdict,
    JSON.stringify(row.reasons),
    row.clientOrderId,
    row.modelCostMicro || 0,
    hash,
  );
  publish({
    type: 'decision',
    userId: row.userId,
    tigerId: row.tigerId,
    verdict: row.verdict,
    rationale: row.rationale,
    ts: row.ts,
  });
  return hash;
}

function clientId(tigerId: number, symbol: string, barTs: string, side: string): string {
  const day = barTs.slice(0, 10).replace(/-/g, '');
  return 't' + tigerId + '-' + symbol + '-' + day + '-' + side;
}

async function decideTiger(db: any, tiger: any, args: {
  series: Record<string, any[]>;
  barTs: string;
  model: { id: string; propose: (signal: any, limits: any) => Promise<any> };
  place: (db: any, orderArgs: any) => Promise<any>;
  quote: any;
}): Promise<any> {
  const limits = tigerLimits(tiger);
  const day = utcDay(args.barTs);
  const state = engine.readState(db, tiger.portfolio_id);
  const equity = state && state.equityMicro > 0n ? state.equityMicro : (state ? state.cashMicro : 0n);
  const rolled = rollUtcDay({ status: tiger.status, pauseReason: tiger.pause_reason, dayUtc: tiger.day_utc }, day);
  let status = rolled.status;
  let pauseReason = rolled.pauseReason;
  let dayStart: bigint | null = tiger.day_start_equity_micro == null ? null : asMicro(tiger.day_start_equity_micro);
  if (rolled.reset || dayStart == null) dayStart = equity;
  if (status === 'active' && dailyLossTripped(dayStart, equity, limits.dailyLossPct)) {
    status = 'paused';
    pauseReason = 'daily_loss';
  }
  db.prepare(`
    UPDATE tifi_tigers
    SET status = ?, pause_reason = ?, day_utc = ?, day_start_equity_micro = ?
    WHERE id = ?
  `).run(status, pauseReason, day, Number(dayStart), tiger.id);
  tiger.status = status;
  tiger.pause_reason = pauseReason;

  const held = (state ? state.positions : [])
    .filter((pos: any) => limits.symbols.includes(pos.symbol))
    .map((pos: any) => pos.symbol);
  const params = { ...JSON.parse(tiger.params_json || '{}'), stopPct: limits.maxStopPct };
  const scoped: Record<string, any[]> = {};
  for (const symbol of limits.symbols) scoped[symbol] = args.series[symbol] || [];
  const signal = selectSignal(tiger.strategy, scoped, params, held);
  const proposal = await args.model.propose(signal, {
    maxPositionPct: limits.maxPositionPct,
    maxStopPct: limits.maxStopPct,
  });
  if (pauseReason === 'daily_loss' && proposal.action !== 'hold') {
    proposal.action = 'hold';
    proposal.notionalPct = null;
  }
  const profile = state.profile;
  const guard = evaluateGuard({
    nowIso: args.barTs,
    proposal,
    limits,
    engineMaxPositionPct: profile.max_position_pct,
    engineMaxTradesPerDay: profile.max_trades_per_day,
    engineMaxStopPct: profile.default_stop_loss_pct,
    engineMaxOrderPct: profile.max_order_value_pct,
    status,
    pauseReason,
    tradesToday: countTrades(db, tiger.portfolio_id, day),
    lastTradeAt: tiger.last_trade_at,
    feesTodayMicro: feesToday(db, tiger.portfolio_id, day),
    equityMicro: equity,
    hasPosition: held.includes(proposal.symbol),
  });
  if (pauseReason === 'daily_loss') {
    guard.verdict = 'pause';
    guard.order = null;
    if (!guard.reasons.includes('Dagsförlusttaket är nått. Tigern är pausad resten av UTC-dygnet.')) {
      guard.reasons = ['Dagsförlusttaket är nått. Tigern är pausad resten av UTC-dygnet.'];
    }
  }
  const order = guard.order;
  const clientOrderId = order ? clientId(tiger.id, order.symbol, args.barTs, order.side) : null;
  logDecision(db, {
    userId: tiger.user_id,
    tigerId: tiger.id,
    ts: args.barTs,
    barTs: args.barTs,
    modelId: proposal.modelId || args.model.id,
    proposal,
    rationale: proposal.rationale,
    probabilities: proposal.probabilities,
    verdict: guard.verdict,
    reasons: guard.reasons,
    clientOrderId,
    modelCostMicro: proposal.modelCostMicro || 0,
  });
  let execution: any = null;
  if (order && clientOrderId && guard.verdict === 'allow') {
    execution = await args.place(db, {
      portfolioId: tiger.portfolio_id,
      actor: { type: 'system', id: 'system:tifi' },
      order: {
        clientOrderId,
        symbol: order.symbol,
        side: order.side,
        type: 'market',
        notionalPct: order.notionalPct,
        stopLossPct: order.stopLossPct,
        sellAll: !!order.sellAll,
      },
      quote: args.quote,
      priceFresh: true,
      clock: () => new Date(args.barTs),
      resting: true,
      throwOnReject: false,
    });
    db.prepare('UPDATE tifi_tigers SET last_trade_at = ? WHERE id = ?').run(args.barTs, tiger.id);
    tiger.last_trade_at = args.barTs;
  }
  return { proposal, guard, clientOrderId, execution };
}

module.exports = {
  decideTiger,
  logDecision,
  tigerLimits,
  countTrades,
};
