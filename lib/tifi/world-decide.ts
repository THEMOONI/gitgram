// Maps a tiger's existing underlying signal onto the current 15-minute market.
// The proposal is logged before any paper fill.

const { asMicro } = require('../paper/money') as { asMicro: (value: any) => bigint };
const { dailyLossTripped, rollUtcDay } = require('./guard.ts') as {
  dailyLossTripped: (start: bigint | null, equity: bigint, cap: number) => boolean;
  rollUtcDay: (state: any, today: string) => { status: string; pauseReason: string | null; reset: boolean };
};
const { selectSignal } = require('./strategies.ts') as { selectSignal: (...args: any[]) => any };
const { limitsOf } = require('./treasury.ts') as { limitsOf: (config: any) => any };
const { logDecision } = require('./decide.ts') as { logDecision: (db: any, row: any) => string };
const { utcDay } = require('./errors.ts') as { utcDay: (value: string) => string };
const { evaluateWorldGuard } = require('./world-guard.ts') as { evaluateWorldGuard: (ctx: any) => any };
const { pickMarket, tigerUnderlying } = require('./world-feed.ts') as {
  pickMarket: (markets: any[], underlying: string) => any;
  tigerUnderlying: (tiger: any) => string;
};
const venue = require('./world-venue.ts') as any;

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

function mapToWorld(signal: any, proposal: any, heldOutcome: string | null): {
  action: 'up' | 'down' | 'abstain';
  outcome: string | null;
  side: 'buy' | 'sell' | null;
} {
  const bullish = signal.action === 'enter' || proposal.action === 'buy';
  const bearish = signal.action === 'exit' || proposal.action === 'sell';
  if (bullish && !bearish) {
    if (heldOutcome === 'YES' || heldOutcome === 'UP') return { action: 'abstain', outcome: null, side: null };
    if (heldOutcome === 'NO' || heldOutcome === 'DOWN') return { action: 'down', outcome: 'NO', side: 'sell' };
    return { action: 'up', outcome: 'YES', side: 'buy' };
  }
  if (bearish && !bullish) {
    if (heldOutcome === 'NO' || heldOutcome === 'DOWN') return { action: 'abstain', outcome: null, side: null };
    if (heldOutcome === 'YES' || heldOutcome === 'UP') return { action: 'up', outcome: 'YES', side: 'sell' };
    return { action: 'down', outcome: 'NO', side: 'buy' };
  }
  return { action: 'abstain', outcome: null, side: null };
}

async function decideWorldTiger(db: any, tiger: any, args: {
  bars: any[];
  nowIso: string;
  model: { id: string; propose: (signal: any, limits: any) => Promise<any> };
  feed: { listActive: () => Promise<any>; getMarket: (id: string) => Promise<any> };
  env?: Record<string, string | undefined>;
  execute?: (order: any, market: any) => Promise<any>;
}): Promise<any> {
  const limits = tigerLimits(tiger);
  const assumptions = venue.worldAssumptions(args.env || {});
  const day = utcDay(args.nowIso);
  await venue.settleResolved(db, tiger, args.feed, args.nowIso);
  const equity = venue.combinedEquity(db, tiger);
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

  const snapshot = await args.feed.listActive();
  const underlying = tigerUnderlying(tiger);
  const market = pickMarket(snapshot.markets || [], underlying);
  const params = { ...JSON.parse(tiger.params_json || '{}'), stopPct: limits.maxStopPct };
  const signal = selectSignal(tiger.strategy, { [underlying]: args.bars || [] }, params, []);
  const modelProposal = await args.model.propose(
    { ...signal, symbol: underlying },
    { maxPositionPct: limits.maxPositionPct, maxStopPct: limits.maxStopPct },
  );
  const held = market
    ? venue.openPosition(db, tiger.id, market.id, 'YES') || venue.openPosition(db, tiger.id, market.id, 'NO')
    : null;
  const heldOutcome = held && asMicro(held.shares_micro) > 0n ? held.outcome : null;
  const mapped = market ? mapToWorld(signal, modelProposal, heldOutcome) : { action: 'abstain' as const, outcome: null, side: null };
  const rationale = (modelProposal.rationale || 'Lokal modell.')
    + ' Förslaget gäller pappersandelar i en 15-minuters World-marknad, inte en riktig order och ingen rekommendation.';
  const proposal = {
    action: mapped.action,
    venue: 'world',
    symbol: underlying,
    seriesTicker: market ? market.seriesTicker : null,
    marketId: market ? market.id : null,
    outcome: mapped.outcome,
    side: mapped.side,
    notionalPct: mapped.side === 'buy' ? limits.maxPositionPct : null,
    stopLossPct: null,
    leverage: 1,
    rationale,
    probabilities: modelProposal.probabilities,
  };
  const selling = mapped.side === 'sell' && mapped.outcome && market
    ? venue.openPosition(db, tiger.id, market.id, mapped.outcome)
    : null;
  const guard = evaluateWorldGuard({
    nowIso: args.nowIso,
    action: mapped.action,
    outcome: mapped.outcome,
    side: mapped.side,
    marketId: market ? market.id : null,
    closesAt: market ? market.closesAt : null,
    leverage: 1,
    stakePct: limits.maxPositionPct,
    maxStakePct: limits.maxPositionPct,
    closeBufferSec: assumptions.closeBufferSec,
    cashMicro: venue.availableCash(db, tiger),
    openStakeMicro: market ? venue.openStake(db, tiger.id, market.id) : 0n,
    feeBps: 0,
    minOrderMicro: 0n,
    tradesToday: venue.countWorldTrades(db, tiger.id, day),
    maxTradesPerDay: limits.maxTradesPerDay,
    lastTradeAt: tiger.last_trade_at,
    cooldownSec: limits.cooldownSec,
    status,
    pauseReason,
    sellingSharesMicro: selling ? asMicro(selling.shares_micro) : 0n,
  });
  if (!market && mapped.action === 'abstain') {
    guard.reasons = ['Ingen aktiv 15-minutersmarknad för ' + underlying + '. Avstår.'];
    guard.codes = ['NO_MARKET'];
  }
  if (pauseReason === 'daily_loss') {
    guard.verdict = 'pause';
    guard.order = null;
    guard.reasons = ['Dagsförlusttaket är nått. Tigern är pausad resten av UTC-dygnet.'];
    guard.codes = ['PAUSED_DAILY'];
  }
  const clientOrderId = guard.order
    ? 'w' + tiger.id + '-' + (market ? market.id : 'none').replace(/[^A-Za-z0-9]/g, '').slice(-24) + '-' + guard.order.outcome + '-' + guard.order.side
    : null;
  logDecision(db, {
    userId: tiger.user_id,
    tigerId: tiger.id,
    ts: args.nowIso,
    barTs: args.nowIso,
    modelId: modelProposal.modelId || args.model.id,
    proposal,
    rationale,
    probabilities: proposal.probabilities,
    verdict: guard.verdict,
    reasons: guard.reasons,
    clientOrderId,
    modelCostMicro: modelProposal.modelCostMicro || 0,
  });
  let execution: any = null;
  if (guard.order && guard.verdict === 'allow' && market) {
    if (args.execute) {
      execution = await args.execute(guard.order, market);
    } else if (guard.order.side === 'buy') {
      execution = venue.buyShares(db, {
        tiger,
        market,
        outcome: guard.order.outcome,
        budgetMicro: guard.order.stakeMicro,
        feeCoef: assumptions.feeCoef,
        ts: args.nowIso,
      });
    } else {
      execution = venue.sellShares(db, {
        tiger,
        market,
        outcome: guard.order.outcome,
        feeCoef: assumptions.feeCoef,
        ts: args.nowIso,
      });
    }
  }
  return { proposal, guard, clientOrderId, execution, marketId: market ? market.id : null };
}

module.exports = {
  decideWorldTiger,
  mapToWorld,
  tigerLimits,
};
