const engine = require('../paper/engine');
const { createSyntheticFeed } = require('../paper/feeds') as { createSyntheticFeed: (opts?: any) => any };
const { decideTiger } = require('./decide.ts') as { decideTiger: (db: any, tiger: any, args: any) => Promise<any> };
const { listTigers } = require('./treasury.ts') as { listTigers: (db: any, userId: number) => any[] };
const { createDecisionModel } = require('./model.ts') as { createDecisionModel: (env: any, deps?: any) => any };
const { createVenue } = require('./venue.ts') as { createVenue: (mode: string | undefined, deps: any) => any };
const { iso } = require('./errors.ts') as { iso: (clock?: () => Date) => string };

const barCache = new Map<string, any[]>();

function toNum(bar: any): any {
  if (bar && bar.closeMicro != null) {
    return {
      ts: bar.ts,
      open: Number(bar.openMicro) / 1e6,
      high: Number(bar.highMicro) / 1e6,
      low: Number(bar.lowMicro) / 1e6,
      close: Number(bar.closeMicro) / 1e6,
      volume: Number(bar.volume || 0),
    };
  }
  return bar;
}

async function loadSymbol(feed: any, symbol: string): Promise<any[]> {
  const key = (feed && feed.id ? feed.id : 'feed') + ':' + symbol + ':' + (feed && feed.cacheKey ? feed.cacheKey : '');
  if (!barCache.has(key)) {
    const bars = await feed.getBars(symbol, '1d');
    barCache.set(key, bars || []);
  }
  return barCache.get(key) || [];
}

function ensureRunner(db: any, userId: number, clock?: () => Date): any {
  const row = db.prepare('SELECT * FROM tifi_runner WHERE user_id = ?').get(userId);
  if (row) return row;
  const ts = iso(clock);
  db.prepare('INSERT INTO tifi_runner (user_id, running, cursor_index, updated_at) VALUES (?, 0, -1, ?)').run(userId, ts);
  return db.prepare('SELECT * FROM tifi_runner WHERE user_id = ?').get(userId);
}

function setRunning(db: any, userId: number, running: boolean, clock?: () => Date): any {
  ensureRunner(db, userId, clock);
  db.prepare('UPDATE tifi_runner SET running = ?, updated_at = ? WHERE user_id = ?').run(running ? 1 : 0, iso(clock), userId);
  return db.prepare('SELECT * FROM tifi_runner WHERE user_id = ?').get(userId);
}

async function stepUser(db: any, userId: number, opts: any = {}): Promise<any> {
  const runner = ensureRunner(db, userId, opts.clock);
  if (!runner.running && !opts.force) return { skipped: true, cursor: runner.cursor_index };
  const tigers = listTigers(db, userId);
  if (!tigers.length) return { skipped: true, reason: 'no-tigers', cursor: runner.cursor_index };
  const symbols = new Set<string>();
  for (const tiger of tigers) {
    for (const symbol of JSON.parse(tiger.symbols_json)) symbols.add(symbol);
  }
  const feed = opts.feed || createSyntheticFeed({ seed: 20261001 });
  const raw: Record<string, any[]> = {};
  let times: string[] = [];
  for (const symbol of symbols) {
    raw[symbol] = await loadSymbol(feed, symbol);
    if (!times.length || raw[symbol].length < times.length) {
      times = raw[symbol].map((bar) => bar.ts);
    }
  }
  const next = runner.cursor_index + 1;
  if (!times.length || next >= times.length) {
    return { done: true, cursor: runner.cursor_index };
  }
  const barTs = times[next];
  const numeric: Record<string, any[]> = {};
  const barsNow: Record<string, any> = {};
  for (const symbol of Object.keys(raw)) {
    const list = raw[symbol];
    const end = list.findIndex((bar) => bar.ts === barTs);
    const cut = end === -1 ? Math.min(next, list.length - 1) : end;
    numeric[symbol] = list.slice(0, cut + 1).map(toNum);
    const bar = list[cut];
    if (bar && bar.closeMicro != null) barsNow[symbol] = bar;
    else if (bar) {
      barsNow[symbol] = {
        openMicro: BigInt(Math.round(bar.open * 1e6)),
        highMicro: BigInt(Math.round(bar.high * 1e6)),
        lowMicro: BigInt(Math.round(bar.low * 1e6)),
        closeMicro: BigInt(Math.round(bar.close * 1e6)),
        ts: bar.ts,
        source: feed.id || 'synthetic',
      };
    }
  }
  const model = opts.model || createDecisionModel(opts.env || process.env, { fetchImpl: opts.fetchImpl });
  const venue = createVenue(opts.mode || 'paper', { placeOrder: opts.placeOrder || engine.placeOrder });
  const decisions = [];
  for (const tiger of tigers) {
    const fresh = db.prepare('SELECT * FROM tifi_tigers WHERE id = ?').get(tiger.id);
    engine.onBars(db, {
      portfolioId: fresh.portfolio_id,
      barsBySymbol: barsNow,
      barTs,
      actor: { type: 'system', id: 'system:tifi' },
      priceSource: feed.id || 'synthetic',
    });
    const symbol = JSON.parse(fresh.symbols_json)[0];
    const quoteBar = barsNow[symbol] || Object.values(barsNow)[0];
    const outcome = await decideTiger(db, fresh, {
      series: numeric,
      barTs,
      model,
      place: venue.place,
      quote: quoteBar
        ? { priceMicro: quoteBar.closeMicro, ts: barTs, source: feed.id || 'synthetic' }
        : null,
    });
    decisions.push({ tigerId: fresh.id, verdict: outcome.guard.verdict, symbol: outcome.proposal.symbol });
  }
  db.prepare('UPDATE tifi_runner SET cursor_index = ?, updated_at = ? WHERE user_id = ?').run(next, iso(opts.clock), userId);
  return { cursor: next, barTs, decisions };
}

async function stepMany(db: any, userId: number, count: number, opts: any = {}): Promise<any> {
  let last: any = null;
  for (let i = 0; i < count; i += 1) {
    last = await stepUser(db, userId, { ...opts, force: true });
    if (last && last.done) break;
  }
  return last;
}

const timers = new Set<ReturnType<typeof setInterval>>();

function startScheduler(db: any, opts: any = {}): () => void {
  const timer = setInterval(() => {
    const rows = db.prepare('SELECT user_id FROM tifi_runner WHERE running = 1').all();
    for (const row of rows) {
      stepUser(db, row.user_id, opts).catch((err: any) => {
        console.error('TIFI steg avbröts: ' + (err && err.message ? err.message : 'okänt fel'));
      });
    }
  }, opts.tickMs || 5000);
  if (typeof timer.unref === 'function') timer.unref();
  timers.add(timer);
  return () => {
    clearInterval(timer);
    timers.delete(timer);
  };
}

module.exports = {
  barCache,
  ensureRunner,
  setRunning,
  stepUser,
  stepMany,
  startScheduler,
  toNum,
};
