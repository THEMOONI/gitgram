const { runEngineSession } = require('../paper/backtest') as { runEngineSession: (db: any, opts: any) => Promise<any> };
const { selectSignal } = require('./strategies.ts') as { selectSignal: (...args: any[]) => any };

function tigerStrategy(row: any): { id: string; version: string; onBar: (ctx: any) => Promise<any[]> } {
  const symbols = JSON.parse(row.symbols_json);
  const params = { ...JSON.parse(row.params_json || '{}'), stopPct: row.max_stop_pct };
  return {
    id: 'tifi-' + row.strategy,
    version: '1',
    async onBar(ctx: any) {
      const series: Record<string, any[]> = {};
      for (const symbol of ctx.universe) {
        const closes = ctx.closes(symbol) as number[];
        series[symbol] = closes.map((close) => ({ open: close, high: close, low: close, close, volume: 0 }));
      }
      const held = ctx.universe.filter((symbol: string) => {
        const pos = ctx.position(symbol);
        return pos && pos.qtyMicro > 0n && symbols.includes(symbol);
      });
      const signal = selectSignal(row.strategy, series, params, held);
      if (!signal || signal.action === 'hold' || !signal.symbol) return [];
      const id = 'bt-' + row.id + '-' + signal.symbol + '-' + String(ctx.barTs).slice(0, 10);
      if (signal.action === 'exit') {
        return [{ clientOrderId: id + '-s', symbol: signal.symbol, side: 'sell', type: 'market', sellAll: true }];
      }
      const notional = Math.min(row.max_position_pct, ctx.risk.maxPositionPct);
      const stop = Math.min(row.max_stop_pct, ctx.risk.defaultStopLossPct);
      return [{
        clientOrderId: id + '-b',
        symbol: signal.symbol,
        side: 'buy',
        type: 'market',
        notionalPct: notional,
        stopLossPct: stop,
      }];
    },
  };
}

async function runTigerBacktest(db: any, row: any, opts: any): Promise<any> {
  const symbols = JSON.parse(row.symbols_json);
  const result = await runEngineSession(db, {
    strategy: tigerStrategy(row),
    userId: row.user_id,
    universe: symbols,
    feed: opts.feed,
    from: opts.from,
    to: opts.to,
    barsBySymbol: opts.barsBySymbol,
    startingMicro: opts.startingMicro,
    actor: { type: 'user', id: 'user:' + row.user_id, userId: row.user_id },
    clock: opts.clock,
  });
  const first = result.equity && result.equity.length ? Number(result.equity[0].equity) : 0;
  const last = result.equity && result.equity.length ? Number(result.equity[result.equity.length - 1].equity) : first;
  const percent = first > 0 ? ((last / first) - 1) * 100 : 0;
  return {
    simulated: true,
    resultLabel: result.resultLabel,
    percent,
    runId: result.runId,
  };
}

module.exports = { tigerStrategy, runTigerBacktest };
