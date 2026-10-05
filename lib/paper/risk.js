const { asMicro, notionalMicro, QTY_SCALE } = require('./money');
const { marketFill, feeFor } = require('./fills');

// Hard ceilings. A profile may be stricter and must never be looser.
// Position size is at most 10% of play-money equity, and a book may hold at most 3 positions.
// There is no leverage: buys must be paid from cash. A 20% drop from peak equity pauses new opens.
const HARD = {
  maxPositionPct: 10,
  maxOpenPositions: 3,
  maxOrderValuePct: 10,
  maxTradesPerDay: 5,
  widestStopLossPct: 12,
  maxDrawdownPct: 20,
  minCashPct: 5,
};

const MESSAGES = {
  NOT_WHITELISTED: 'Instrumentet finns inte på tillåtelselistan eller är avstängt.',
  MAX_POSITION: 'Positionen skulle bli större än tillåten andel av portföljvärdet.',
  MAX_OPEN_POSITIONS: 'Max antal öppna positioner är redan uppnått.',
  MAX_ORDER_SIZE: 'Ordervärdet överstiger den största tillåtna ordern.',
  DAILY_TRADE_LIMIT: 'Dagens max antal affärer är redan uppnått (UTC-dygn).',
  NO_SHORTING: 'Blankning är inte tillåten. Försäljningen är större än innehavet.',
  INSUFFICIENT_CASH: 'Kassan räcker inte till ordern inklusive avgift. Hävstång är inte tillåten.',
  CASH_BUFFER: 'Köpet skulle lämna mindre kontantbuffert än reglerna tillåter.',
  PORTFOLIO_PAUSED: 'Portföljen är pausad. Endast ägaren kan återaktivera handeln.',
  STALE_PRICE: 'Priset är för gammalt för att ordern ska kunna fyllas.',
  STOP_TOO_WIDE: 'Stop-loss får inte vara vidare än riskprofilens gräns.',
  STOP_REQUIRED: 'Varje köp måste ha en stop-loss. Den kan skärpas men inte tas bort.',
  STOP_SELL_ONLY: 'Stop-order kan bara vara sälj i den här versionen.',
  INVALID_ORDER: 'Ordern är ogiltig.',
  RISK_LOOSER_THAN_HARD: 'Riskprofilen får inte vara lösare än motorns hårda gränser.',
  OWNER_ONLY: 'Den här åtgärden kan bara göras av portföljägaren, inte med en agentnyckel.',
  KILL_SWITCH: 'Handeln är pausad: värdeminskningen nådde gränsen. Endast ägaren kan återaktivera.',
  WITHDRAW_LIMIT: 'Uttag kan bara ta kassa som är backad av allokerade DEMO-enheter. Simulerad vinst stannar i portföljen.',
  GEO_BLOCKED: 'Handel är inte tillgänglig från den angivna regionen.',
  IDEMPOTENCY_CONFLICT: 'client_order_id har redan använts med andra villkor.',
};

function message(code) {
  return MESSAGES[code] || 'Ordern avvisades.';
}

function reject(code) {
  return { ok: false, code, message: message(code) };
}

function asPct(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return n;
}

function validateProfile(input, whitelist) {
  const src = input || {};
  const risk = {
    max_position_pct: asPct(src.maxPositionPct ?? src.max_position_pct, HARD.maxPositionPct),
    max_open_positions: asPct(src.maxOpenPositions ?? src.max_open_positions, HARD.maxOpenPositions),
    max_order_value_pct: asPct(src.maxOrderValuePct ?? src.max_order_value_pct, HARD.maxOrderValuePct),
    max_trades_per_day: asPct(src.maxTradesPerDay ?? src.max_trades_per_day, HARD.maxTradesPerDay),
    default_stop_loss_pct: asPct(src.defaultStopLossPct ?? src.default_stop_loss_pct, HARD.widestStopLossPct),
    max_drawdown_pct: asPct(src.maxDrawdownPct ?? src.max_drawdown_pct, HARD.maxDrawdownPct),
    min_cash_pct: asPct(src.minCashPct ?? src.min_cash_pct, HARD.minCashPct),
  };
  if (Object.values(risk).some((value) => value == null)) return reject('RISK_LOOSER_THAN_HARD');
  if (risk.max_position_pct < 1 || risk.max_position_pct > HARD.maxPositionPct) return reject('RISK_LOOSER_THAN_HARD');
  if (risk.max_open_positions < 1 || risk.max_open_positions > HARD.maxOpenPositions) return reject('RISK_LOOSER_THAN_HARD');
  if (risk.max_order_value_pct < 1 || risk.max_order_value_pct > HARD.maxOrderValuePct) return reject('RISK_LOOSER_THAN_HARD');
  if (risk.max_trades_per_day < 1 || risk.max_trades_per_day > HARD.maxTradesPerDay) return reject('RISK_LOOSER_THAN_HARD');
  if (risk.default_stop_loss_pct < 1 || risk.default_stop_loss_pct > HARD.widestStopLossPct) return reject('RISK_LOOSER_THAN_HARD');
  if (risk.max_drawdown_pct < 1 || risk.max_drawdown_pct > HARD.maxDrawdownPct) return reject('RISK_LOOSER_THAN_HARD');
  if (risk.min_cash_pct < HARD.minCashPct || risk.min_cash_pct > 90) return reject('RISK_LOOSER_THAN_HARD');
  const allowed = new Set(whitelist);
  const requested = Array.isArray(src.whitelist) ? src.whitelist : whitelist.slice();
  const symbols = requested.map((symbol) => String(symbol || '').toUpperCase());
  if (!symbols.length || symbols.some((symbol) => !allowed.has(symbol))) return reject('NOT_WHITELISTED');
  return { ok: true, risk, whitelist: symbols };
}

function resolveQty(ctx, refPrice, estPrice) {
  if (ctx.sellAll) {
    if (!ctx.position || ctx.position.qtyMicro <= 0n) return reject('NO_SHORTING');
    return { ok: true, qty: ctx.position.qtyMicro };
  }
  if (ctx.notionalPct != null) {
    const pct = asPct(ctx.notionalPct, null);
    if (pct == null || pct < 1 || pct > 100) return reject('INVALID_ORDER');
    const basis = estPrice > 0n ? estPrice : refPrice;
    if (basis <= 0n) return reject('STALE_PRICE');
    const target = ctx.equityMicro * BigInt(pct) / 100n;
    const qty = target * QTY_SCALE / basis;
    if (qty <= 0n) return reject('INVALID_ORDER');
    return { ok: true, qty };
  }
  if (ctx.qtyBase != null) {
    const qty = asMicro(ctx.qtyBase);
    if (qty <= 0n) return reject('INVALID_ORDER');
    return { ok: true, qty };
  }
  return reject('INVALID_ORDER');
}

function evaluateOrder(ctx) {
  if (ctx.portfolioStatus === 'paused' || ctx.portfolioStatus === 'closed') return reject('PORTFOLIO_PAUSED');
  if (!ctx.instrument || !ctx.instrument.enabled || !ctx.whitelist.includes(ctx.instrument.symbol)) {
    return reject('NOT_WHITELISTED');
  }
  if (ctx.type === 'stop' && ctx.side !== 'sell') return reject('STOP_SELL_ONLY');
  if (ctx.side !== 'buy' && ctx.side !== 'sell') return reject('INVALID_ORDER');
  if (ctx.type !== 'market' && ctx.type !== 'limit' && ctx.type !== 'stop') return reject('INVALID_ORDER');
  if (!ctx.priceFresh || ctx.refPriceMicro == null || asMicro(ctx.refPriceMicro) <= 0n) return reject('STALE_PRICE');

  const refPrice = asMicro(ctx.refPriceMicro);
  let stopLossPct = ctx.stopLossPct == null || ctx.stopLossPct === '' ? null : asPct(ctx.stopLossPct, null);
  if (ctx.side === 'buy') {
    if (stopLossPct == null) stopLossPct = ctx.profile.default_stop_loss_pct;
    if (stopLossPct == null || stopLossPct < 1) return reject('STOP_REQUIRED');
    if (stopLossPct > ctx.profile.default_stop_loss_pct) return reject('STOP_TOO_WIDE');
  }

  const slip = ctx.slippageBps;
  const feeBps = ctx.feeBps;
  let estPrice = refPrice;
  if (ctx.type === 'market') estPrice = marketFill(refPrice, ctx.side, slip);
  if (ctx.type === 'limit') {
    if (ctx.limitPriceMicro == null) return reject('INVALID_ORDER');
    estPrice = asMicro(ctx.limitPriceMicro);
  }
  if (ctx.type === 'stop') {
    if (ctx.stopPriceMicro == null) return reject('INVALID_ORDER');
    estPrice = asMicro(ctx.stopPriceMicro);
  }
  if (estPrice <= 0n) return reject('INVALID_ORDER');

  const qtyResult = resolveQty(ctx, refPrice, estPrice);
  if (!qtyResult.ok) return qtyResult;
  const qty = qtyResult.qty;
  const notion = notionalMicro(estPrice, qty);
  const fee = feeFor(notion, feeBps);
  const spend = notion + fee;
  if (notion <= 0n && ctx.side === 'buy') return reject('INVALID_ORDER');

  if (!ctx.isProtectiveStop && ctx.tradesToday >= ctx.profile.max_trades_per_day) {
    return reject('DAILY_TRADE_LIMIT');
  }

  if (ctx.side === 'sell') {
    if (!ctx.position || qty > ctx.position.qtyMicro) return reject('NO_SHORTING');
    return {
      ok: true,
      qtyBase: qty,
      stopLossPct: null,
      estimatedFillMicro: estPrice,
      estimatedFeeMicro: fee,
      estimatedNotionalMicro: notion,
    };
  }

  const equity = asMicro(ctx.equityMicro);
  const cash = asMicro(ctx.cashMicro);
  if (equity <= 0n || spend > cash) return reject('INSUFFICIENT_CASH');
  const orderBps = notion * 10000n / equity;
  if (orderBps > BigInt(ctx.profile.max_order_value_pct) * 100n) return reject('MAX_ORDER_SIZE');
  const held = ctx.position && ctx.position.qtyMicro > 0n
    ? notionalMicro(refPrice, ctx.position.qtyMicro)
    : 0n;
  const afterBps = (held + notion) * 10000n / equity;
  if (afterBps > BigInt(ctx.profile.max_position_pct) * 100n) return reject('MAX_POSITION');
  const isNew = !ctx.position || ctx.position.qtyMicro <= 0n;
  if (isNew && ctx.openPositions >= ctx.profile.max_open_positions) return reject('MAX_OPEN_POSITIONS');
  if (cash - spend < equity * BigInt(ctx.profile.min_cash_pct) / 100n) return reject('CASH_BUFFER');
  return {
    ok: true,
    qtyBase: qty,
    stopLossPct,
    estimatedFillMicro: estPrice,
    estimatedFeeMicro: fee,
    estimatedNotionalMicro: notion,
  };
}

module.exports = {
  HARD,
  MESSAGES,
  message,
  validateProfile,
  evaluateOrder,
};
