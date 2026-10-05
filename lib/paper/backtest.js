const { SIMULATED_RESULT, SIMULATED_RESULT_LONG } = require('../demo-notice');
const { getStrategy } = require('./strategies');
const { computeMetrics, closeToCloseReturn } = require('./metrics');
const { asMicro, MICRO_PER_DEMO } = require('./money');
const { bookFor, insert } = require('./ledgerbook');
const {
  createPortfolio,
  seedSimulatedCash,
  onBars,
  acceptIntent,
  equityFrom,
} = require('./engine');

function alignBars(series, from, to) {
  const start = from ? Date.parse(from) : -Infinity;
  const end = to ? Date.parse(to) : Infinity;
  const out = {};
  const times = new Set();
  for (const [symbol, bars] of Object.entries(series)) {
    const filtered = (bars || [])
      .filter((bar) => {
        const ts = Date.parse(bar.ts);
        return ts >= start && ts <= end;
      })
      .sort((a, b) => a.ts.localeCompare(b.ts));
    out[symbol] = filtered;
    for (const bar of filtered) times.add(bar.ts);
  }
  return { series: out, times: [...times].sort() };
}

function loadBars(opts) {
  if (opts.barsBySymbol) return opts.barsBySymbol;
  return null;
}

async function runEngineSession(db, opts) {
  const strategy = typeof opts.strategy === 'string' ? getStrategy(opts.strategy) : opts.strategy;
  if (!strategy || typeof strategy.onBar !== 'function') {
    const err = new Error('Unknown strategy');
    err.code = 'UNKNOWN_STRATEGY';
    err.status = 400;
    throw err;
  }
  const mode = opts.mode === 'live-sim' ? 'live' : 'backtest';
  const universe = (opts.universe && opts.universe.length ? opts.universe : ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'])
    .map((symbol) => String(symbol).toUpperCase());
  const starting = asMicro(opts.startingMicro || (1000n * MICRO_PER_DEMO));
  const createdAt = new Date().toISOString();
  let runId = null;
  if (mode === 'backtest') {
    const info = insert(db, 'bt_runs', {
      owner_user_id: opts.userId,
      strategy_id: strategy.id,
      strategy_version: strategy.version,
      params_json: JSON.stringify(opts.params || {}),
      universe_json: JSON.stringify(universe),
      from_ts: opts.from || '',
      to_ts: opts.to || '',
      starting_micro: starting,
      status: 'running',
      metrics_json: null,
      result_label: SIMULATED_RESULT,
      created_at: createdAt,
      finished_at: null,
    });
    runId = Number(info.lastInsertRowid);
  }
  const book = bookFor(mode === 'backtest' ? 'backtest' : 'live', runId);
  const portfolioId = createPortfolio(db, {
    book,
    userId: opts.userId,
    preset: opts.preset || 'hard-default',
    actor: opts.actor,
    clock: opts.clock,
  });
  seedSimulatedCash(db, book, portfolioId, starting, createdAt);

  let barsBySymbol = loadBars(opts);
  if (!barsBySymbol) {
    barsBySymbol = {};
    for (const symbol of universe) {
      barsBySymbol[symbol] = await opts.feed.getBars(symbol, '1d', opts.from, opts.to);
    }
  }
  const aligned = alignBars(barsBySymbol, opts.from, opts.to);
  const history = {};
  for (const symbol of universe) history[symbol] = [];
  const indexes = {};
  for (const symbol of universe) indexes[symbol] = 0;
  let previousTs = null;
  let hasTraded = false;
  const entryBar = {};

  for (let barIndex = 0; barIndex < aligned.times.length; barIndex += 1) {
    const barTs = aligned.times[barIndex];
    const barsNow = {};
    for (const symbol of universe) {
      const list = aligned.series[symbol] || [];
      const bar = list[indexes[symbol]];
      if (bar && bar.ts === barTs) {
        history[symbol].push(bar);
        barsNow[symbol] = bar;
        indexes[symbol] += 1;
      }
    }
    onBars(db, {
      book,
      portfolioId,
      barsBySymbol: barsNow,
      barTs,
      costs: opts.costs,
      priceSource: opts.feed && opts.feed.id ? opts.feed.id : 'synthetic',
      actor: { type: 'system', id: 'system:backtest' },
    });
    const portfolio = db.prepare('SELECT * FROM ' + book.portfolio + ' WHERE id = ?').get(portfolioId);
    if (portfolio.status === 'paused') break;
    const view = equityFrom(db, book, portfolioId, null);
    const profileRow = db.prepare('SELECT * FROM paper_risk_profiles WHERE id = ?').get(portfolio.risk_profile_id);
    const monthStart = previousTs && previousTs.slice(0, 7) !== barTs.slice(0, 7);
    const ctx = {
      barIndex,
      barTs,
      universe,
      params: opts.params || {},
      hasTraded,
      monthStart: !!monthStart,
      openCount: [...view.positions.values()].filter((pos) => pos.qtyMicro > 0n).length,
      cashMicro: view.cash,
      equityMicro: view.equity > 0n ? view.equity : view.cash,
      risk: {
        maxPositionPct: profileRow.max_position_pct,
        maxOpenPositions: profileRow.max_open_positions,
        maxTradesPerDay: profileRow.max_trades_per_day,
        maxOrderValuePct: profileRow.max_order_value_pct,
        defaultStopLossPct: profileRow.default_stop_loss_pct,
        minCashPct: profileRow.min_cash_pct,
      },
      position(symbol) {
        return view.positions.get(symbol) || null;
      },
      closes(symbol) {
        return (history[symbol] || []).map((bar) => Number(bar.closeMicro));
      },
      lastClose(symbol) {
        const rows = history[symbol] || [];
        return rows.length ? asMicro(rows[rows.length - 1].closeMicro) : 0n;
      },
      barsHeld(symbol) {
        if (entryBar[symbol] == null) return null;
        return barIndex - entryBar[symbol];
      },
      canEnter(symbol) {
        const rows = history[symbol] || [];
        const last = rows.length ? Date.parse(rows[rows.length - 1].ts) : 0;
        const opened = entryBar[symbol] == null ? null : aligned.times[entryBar[symbol]];
        if (!opened) return true;
        return last - Date.parse(opened) >= 7 * 86400000;
      },
    };
    const intents = await strategy.onBar(ctx);
    for (const intent of intents || []) {
      const symbol = String(intent.symbol || '').toUpperCase();
      const bar = barsNow[symbol] || (history[symbol] || []).at(-1);
      if (!bar) continue;
      const result = acceptIntent(db, {
        book,
        portfolioId,
        actor: { type: 'system', id: 'system:' + strategy.id },
        order: intent,
        quote: { priceMicro: bar.closeMicro, ts: bar.ts, source: opts.feed ? opts.feed.id : 'synthetic' },
        priceFresh: true,
        costs: opts.costs,
        clock: () => new Date(barTs),
        throwOnReject: false,
        resting: true,
      });
      if (result && result.ok && intent.side === 'buy') entryBar[symbol] = barIndex;
      if (result && result.ok) hasTraded = true;
    }
    previousTs = barTs;
  }

  const summary = summarize(db, book, portfolioId, aligned.series, strategy);
  if (runId != null) {
    db.prepare(`
      UPDATE bt_runs
      SET status = 'completed', metrics_json = ?, finished_at = ?
      WHERE id = ?
    `).run(JSON.stringify(summary.metrics), new Date().toISOString(), runId);
  }
  return { runId, portfolioId, mode, ...summary };
}

function summarize(db, book, portfolioId, series, strategy) {
  const equity = db.prepare(`
    SELECT ts, cash_micro, positions_value_micro, equity_micro, drawdown_bps
    FROM ${book.equity}
    WHERE ${book.kind === 'backtest' ? 'portfolio_id = ? AND run_id = ?' : 'portfolio_id = ?'}
    ORDER BY id ASC
  `).all(...(book.kind === 'backtest' ? [portfolioId, book.runId] : [portfolioId]));
  const fills = db.prepare(`
    SELECT f.*, o.side, o.symbol
    FROM ${book.fill} f
    JOIN ${book.order} o ON o.id = f.order_id
    WHERE ${book.kind === 'backtest' ? 'f.portfolio_id = ? AND f.run_id = ?' : 'f.portfolio_id = ?'}
    ORDER BY f.id ASC
  `).all(...(book.kind === 'backtest' ? [portfolioId, book.runId] : [portfolioId]));
  const metrics = computeMetrics(equity, fills);
  const returns = {};
  for (const [symbol, bars] of Object.entries(series)) returns[symbol] = closeToCloseReturn(bars);
  const named = Object.values(returns).filter((value) => value != null);
  const equal = named.length ? Math.round((named.reduce((sum, value) => sum + value, 0) / named.length) * 1e6) / 1e6 : null;
  return {
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    resultLabel: SIMULATED_RESULT,
    resultLabelLong: SIMULATED_RESULT_LONG,
    simulated: true,
    metrics,
    benchmarks: {
      equalWeightCloseReturn: equal,
      btcCloseReturn: returns.BTC == null ? null : returns.BTC,
      note: 'Jämförelsetal från stängningskurser i den här körningen. Inte en prisserie och ingen prognos.',
    },
    equity: equity.map((row) => ({
      ts: row.ts,
      equity: (Number(row.equity_micro) / 1e6).toFixed(2),
      drawdownBps: row.drawdown_bps,
    })),
    trades: fills.map((fill) => ({
      symbol: fill.symbol,
      side: fill.side,
      qty: (Number(fill.qty_base) / 1e6).toString(),
      price: (Number(fill.price_micro) / 1e6).toFixed(6),
      fee: (Number(fill.fee_micro) / 1e6).toFixed(6),
      ts: fill.filled_at,
    })),
  };
}

module.exports = {
  runEngineSession,
};
