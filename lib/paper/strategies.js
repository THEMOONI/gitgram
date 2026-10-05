// Signals use only closes available at the end of bar t. The engine fills on a later bar.

function average(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function crossesAbove(closes, shortN, longN) {
  if (!closes || closes.length < longN + 1) return false;
  const prev = closes.slice(0, -1);
  const shortNow = average(closes.slice(-shortN));
  const longNow = average(closes.slice(-longN));
  const shortPrev = average(prev.slice(-shortN));
  const longPrev = average(prev.slice(-longN));
  return shortPrev <= longPrev && shortNow > longNow && closes[closes.length - 1] > longNow;
}

function crossesBelow(closes, shortN, longN) {
  if (!closes || closes.length < longN + 1) return false;
  const prev = closes.slice(0, -1);
  const shortNow = average(closes.slice(-shortN));
  const longNow = average(closes.slice(-longN));
  const shortPrev = average(prev.slice(-shortN));
  const longPrev = average(prev.slice(-longN));
  return shortPrev >= longPrev && shortNow < longNow;
}

function rsi(closes, period) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  const avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = (gain / period) / avgLoss;
  return 100 - (100 / (1 + rs));
}

const smaCross = {
  id: 'sma-cross',
  version: '1',
  async onBar(ctx) {
    const shortN = Number(ctx.params.short || 50);
    const longN = Number(ctx.params.long || 200);
    const intents = [];
    let open = ctx.openCount;
    for (const symbol of ctx.universe) {
      const closes = ctx.closes(symbol);
      const pos = ctx.position(symbol);
      if (pos && pos.qtyMicro > 0n && crossesBelow(closes, shortN, longN)) {
        intents.push({
          clientOrderId: 'sma-exit-' + symbol + '-' + ctx.barTs,
          symbol,
          side: 'sell',
          type: 'market',
          sellAll: true,
        });
        continue;
      }
      if (pos && pos.qtyMicro > 0n && pos.highCloseMicro > 0n) {
        const trail = pos.highCloseMicro * 80n / 100n;
        if (ctx.lastClose(symbol) <= trail) {
          intents.push({
            clientOrderId: 'sma-trail-' + symbol + '-' + ctx.barTs,
            symbol,
            side: 'sell',
            type: 'market',
            sellAll: true,
          });
          continue;
        }
      }
      if (!pos && open < ctx.risk.maxOpenPositions && crossesAbove(closes, shortN, longN)) {
        intents.push({
          clientOrderId: 'sma-entry-' + symbol + '-' + ctx.barTs,
          symbol,
          side: 'buy',
          type: 'market',
          notionalPct: Math.min(10, ctx.risk.maxPositionPct),
          stopLossPct: ctx.risk.defaultStopLossPct,
        });
        open += 1;
      }
    }
    return intents;
  },
};

const CRYPTO_WEIGHTS = { BTC: 10, ETH: 10, SOL: 10, BNB: 10, XRP: 10 };

const monthlyRebalance = {
  id: 'monthly-rebalance',
  version: '1',
  async onBar(ctx) {
    const weights = ctx.params.weights || CRYPTO_WEIGHTS;
    const intents = [];
    const cap = ctx.risk.maxTradesPerDay;
    if (!ctx.hasTraded) {
      for (const symbol of ctx.universe) {
        if (intents.length >= cap) break;
        const target = weights[symbol];
        if (!target) continue;
        intents.push({
          clientOrderId: 'reb-init-' + symbol + '-' + ctx.barTs,
          symbol,
          side: 'buy',
          type: 'market',
          notionalPct: Math.min(target, ctx.risk.maxPositionPct),
          stopLossPct: ctx.risk.defaultStopLossPct,
        });
      }
      return intents;
    }
    if (!ctx.monthStart) return [];
    const sells = [];
    const buys = [];
    for (const symbol of ctx.universe) {
      const target = weights[symbol] || 0;
      const pos = ctx.position(symbol);
      const equity = Number(ctx.equityMicro);
      const value = pos ? Number(pos.qtyMicro) * Number(ctx.lastClose(symbol)) / 1e12 : 0;
      const weight = equity > 0 ? (value / (equity / 1e6)) * 100 : 0;
      const gap = weight - target;
      if (gap > 5 && pos) {
        sells.push({
          clientOrderId: 'reb-sell-' + symbol + '-' + ctx.barTs,
          symbol,
          side: 'sell',
          type: 'market',
          notionalPct: Math.min(Math.floor(gap), ctx.risk.maxOrderValuePct),
        });
      } else if (gap < -5) {
        buys.push({
          clientOrderId: 'reb-buy-' + symbol + '-' + ctx.barTs,
          symbol,
          side: 'buy',
          type: 'market',
          notionalPct: Math.min(Math.floor(-gap), ctx.risk.maxPositionPct),
          stopLossPct: ctx.risk.defaultStopLossPct,
        });
      }
    }
    return sells.concat(buys).slice(0, cap);
  },
};

const rsiRevert = {
  id: 'rsi-revert',
  version: '1',
  async onBar(ctx) {
    const period = Number(ctx.params.period || 14);
    const buyBelow = Number(ctx.params.buyBelow || 30);
    const sellAbove = Number(ctx.params.sellAbove || 55);
    const trendN = Number(ctx.params.trend || 200);
    const holdBars = Number(ctx.params.holdBars || 10);
    const maxPositions = Math.min(3, ctx.risk.maxOpenPositions);
    const intents = [];
    let open = ctx.openCount;
    for (const symbol of ctx.universe) {
      const closes = ctx.closes(symbol);
      const value = rsi(closes, period);
      const pos = ctx.position(symbol);
      if (pos && pos.qtyMicro > 0n) {
        const held = ctx.barsHeld(symbol);
        if ((value != null && value > sellAbove) || (held != null && held >= holdBars)) {
          intents.push({
            clientOrderId: 'rsi-exit-' + symbol + '-' + ctx.barTs,
            symbol,
            side: 'sell',
            type: 'market',
            sellAll: true,
          });
        }
        continue;
      }
      if (value == null || closes.length < trendN) continue;
      const trend = average(closes.slice(-trendN));
      if (value < buyBelow && closes[closes.length - 1] > trend && open < maxPositions && ctx.canEnter(symbol)) {
        intents.push({
          clientOrderId: 'rsi-entry-' + symbol + '-' + ctx.barTs,
          symbol,
          side: 'buy',
          type: 'market',
          notionalPct: Math.min(10, ctx.risk.maxPositionPct),
          stopLossPct: Math.min(8, ctx.risk.defaultStopLossPct),
        });
        open += 1;
      }
    }
    return intents;
  },
};

const STRATEGIES = {
  'sma-cross': smaCross,
  'monthly-rebalance': monthlyRebalance,
  'rsi-revert': rsiRevert,
};

function getStrategy(id) {
  return STRATEGIES[id] || null;
}

module.exports = {
  average,
  crossesAbove,
  crossesBelow,
  rsi,
  smaCross,
  monthlyRebalance,
  rsiRevert,
  STRATEGIES,
  getStrategy,
  CRYPTO_WEIGHTS,
};
