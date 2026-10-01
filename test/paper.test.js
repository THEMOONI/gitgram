const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const request = require('supertest');
const { createApp } = require('../server');
const { DEMO_NOTICE, SIMULATED_RESULT } = require('../lib/demo-notice');
const { marketFill, limitFill, stopFill, feeFor } = require('../lib/paper/fills');
const { verifyAudit, verifyRows } = require('../lib/paper/audit');
const { createPriceCache } = require('../lib/paper/cache');
const { createCoinGeckoFeed } = require('../lib/paper/feeds');
const { bookFor, ledgerReport } = require('../lib/paper/ledgerbook');
const { asMicro, minorToMicro } = require('../lib/paper/money');
const { crossesAbove, rsi } = require('../lib/paper/strategies');
const { runEngineSession } = require('../lib/paper/backtest');
const engine = require('../lib/paper/engine');

function fakeFeed() {
  const quotes = {
    BTC: 100_000_000n,
    ETH: 50_000_000n,
    SOL: 10_000_000n,
    BNB: 20_000_000n,
    XRP: 1_000_000n,
  };
  return {
    id: 'synthetic',
    attribution: 'Fictional test prices',
    attributionSecondary: 'Not market data.',
    attributionUrl: null,
    fictional: true,
    quotes,
    async getLatest(symbols) {
      const ts = new Date().toISOString();
      return symbols.map((symbol) => ({
        symbol,
        priceMicro: quotes[symbol] || 1_000_000n,
        ts,
        source: 'synthetic',
      }));
    },
    async getBars() {
      return [];
    },
  };
}

function openDb(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-paper-'));
  const feed = options.feed || fakeFeed();
  const app = createApp({
    dbPath: path.join(dir, 'gitgram.db'),
    dataDir: path.join(dir, 'data'),
    sessionSecret: 'test-session-secret-value',
    priceFeed: feed,
    clock: options.clock,
    geo: options.geo,
    priceCacheKey: options.priceCacheKey,
  });
  const db = app.locals.db;
  const user = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').run(
    options.username || 'ada',
    (options.username || 'ada') + '@example.com',
    'hash'
  );
  return {
    app,
    db,
    feed,
    dir,
    userId: Number(user.lastInsertRowid),
    actor: { type: 'user', id: 'user:' + Number(user.lastInsertRowid), userId: Number(user.lastInsertRowid) },
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function assertBalanced(db, portfolioId) {
  const report = ledgerReport(db, bookFor('live'), portfolioId);
  assert.equal(report.total, 0n);
  for (const tx of report.txs) assert.equal(asMicro(tx.total), 0n);
  const wallet = db.prepare('SELECT COALESCE(SUM(amount_minor), 0) AS total FROM ledger_entries').get();
  assert.equal(wallet.total, 0);
}

async function funded(ctx, amount = '500.00') {
  const id = engine.createPortfolio(dbRef(ctx), {
    userId: ctx.userId,
    actor: ctx.actor,
  });
  const { parseAmountToMinor } = require('../lib/ledger');
  const parsed = parseAmountToMinor(amount, { maxMinor: 100000 });
  engine.allocate(ctx.db, {
    portfolioId: id,
    amountMinor: parsed.minor,
    idempotencyKey: 'alloc-' + id + '-' + amount.replace('.', ''),
    actor: ctx.actor,
  });
  return id;
}

function dbRef(ctx) {
  return ctx.db;
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  assert.ok(match, 'csrf token missing');
  return match[1];
}

test('fill model applies adverse slippage, limit touch, and gap stops', () => {
  assert.equal(marketFill(100_000_000n, 'buy', 10), 100_100_000n);
  assert.equal(marketFill(100_000_000n, 'sell', 10), 99_900_000n);
  assert.equal(feeFor(100_100_000n, 10), 100_100n);
  const through = { openMicro: 95_000_000n, highMicro: 101_000_000n, lowMicro: 90_000_000n, closeMicro: 100_000_000n };
    assert.equal(limitFill({ ...through, lowMicro: 95_000_000n }, 'buy', 94_000_000n), null);
  assert.equal(limitFill(through, 'buy', 96_000_000n), 95_000_000n);
  assert.equal(limitFill({ ...through, openMicro: 110_000_000n, lowMicro: 94_000_000n }, 'buy', 100_000_000n), 100_000_000n);
  const gap = { openMicro: 80_000_000n, highMicro: 82_000_000n, lowMicro: 79_000_000n, closeMicro: 81_000_000n };
  const stopped = stopFill(gap, 90_000_000n, 10);
  assert.ok(stopped < 80_000_000n);
  assert.equal(stopped, marketFill(80_000_000n, 'sell', 10));
  assert.equal(stopFill(through, 80_000_000n, 10), null);
});

test('risk rules reject before a fill', async () => {
  const ctx = openDb();
  try {
    const id = await funded(ctx, '250.00');
    const base = { portfolioId: id, actor: ctx.actor, feed: ctx.feed, book: bookFor('live') };
    await assert.rejects(
      engine.placeOrder(ctx.db, { ...base, order: { clientOrderId: 'r-white', symbol: 'DOGE', side: 'buy', type: 'market', notionalPct: 10, stopLossPct: 12 } }),
      (err) => err.code === 'NOT_WHITELISTED'
    );
    await assert.rejects(
      engine.placeOrder(ctx.db, { ...base, order: { clientOrderId: 'r-size', symbol: 'BTC', side: 'buy', type: 'market', notionalPct: 21, stopLossPct: 12 } }),
      (err) => err.code === 'MAX_ORDER_SIZE'
    );
    await engine.placeOrder(ctx.db, { ...base, order: { clientOrderId: 'r-pos-1', symbol: 'BTC', side: 'buy', type: 'market', notionalPct: 15, stopLossPct: 12 } });
    await assert.rejects(
      engine.placeOrder(ctx.db, { ...base, order: { clientOrderId: 'r-pos-2', symbol: 'BTC', side: 'buy', type: 'market', notionalPct: 10, stopLossPct: 12 } }),
      (err) => err.code === 'MAX_POSITION'
    );
    const tight = engine.createPortfolio(ctx.db, {
      userId: ctx.userId,
      actor: ctx.actor,
      risk: { maxOpenPositions: 1, maxPositionPct: 20, maxOrderValuePct: 20, maxTradesPerDay: 5, defaultStopLossPct: 12, maxDrawdownPct: 20, minCashPct: 5 },
    });
    engine.allocate(ctx.db, { portfolioId: tight, amountMinor: 25000, idempotencyKey: 'alloc-tight-open', actor: ctx.actor });
    await engine.placeOrder(ctx.db, { ...base, portfolioId: tight, order: { clientOrderId: 'r-open-1', symbol: 'ETH', side: 'buy', type: 'market', notionalPct: 10, stopLossPct: 12 } });
    await assert.rejects(
      engine.placeOrder(ctx.db, { ...base, portfolioId: tight, order: { clientOrderId: 'r-open-2', symbol: 'SOL', side: 'buy', type: 'market', notionalPct: 10, stopLossPct: 12 } }),
      (err) => err.code === 'MAX_OPEN_POSITIONS'
    );
    const daily = engine.createPortfolio(ctx.db, { userId: ctx.userId, actor: ctx.actor });
    engine.allocate(ctx.db, { portfolioId: daily, amountMinor: 25000, idempotencyKey: 'alloc-daily-0001', actor: ctx.actor });
    for (let i = 0; i < 5; i += 1) {
      await engine.placeOrder(ctx.db, {
        ...base,
        portfolioId: daily,
        order: { clientOrderId: 'r-day-' + i, symbol: 'BTC', side: 'buy', type: 'market', notionalPct: 3, stopLossPct: 12 },
      });
    }
    await assert.rejects(
      engine.placeOrder(ctx.db, { ...base, portfolioId: daily, order: { clientOrderId: 'r-day-6', symbol: 'ETH', side: 'buy', type: 'market', notionalPct: 3, stopLossPct: 12 } }),
      (err) => err.code === 'DAILY_TRADE_LIMIT'
    );
    await assert.rejects(
      engine.placeOrder(ctx.db, { ...base, order: { clientOrderId: 'r-short', symbol: 'SOL', side: 'sell', type: 'market', qty: '1' } }),
      (err) => err.code === 'NO_SHORTING'
    );
    await assert.rejects(
      engine.placeOrder(ctx.db, { ...base, order: { clientOrderId: 'r-cash', symbol: 'SOL', side: 'buy', type: 'market', qty: '100', stopLossPct: 12 } }),
      (err) => err.code === 'INSUFFICIENT_CASH'
    );
    await assert.rejects(
      engine.placeOrder(ctx.db, { ...base, order: { clientOrderId: 'r-wide', symbol: 'SOL', side: 'buy', type: 'market', notionalPct: 5, stopLossPct: 25 } }),
      (err) => err.code === 'STOP_TOO_WIDE'
    );
    await assert.rejects(
      engine.placeOrder(ctx.db, { ...base, order: { clientOrderId: 'r-stopbuy', symbol: 'SOL', side: 'buy', type: 'stop', stopPrice: '9', qty: '0.1' } }),
      (err) => err.code === 'STOP_SELL_ONLY'
    );
    engine.pausePortfolio(ctx.db, { portfolioId: id, actor: ctx.actor });
    await assert.rejects(
      engine.placeOrder(ctx.db, { ...base, order: { clientOrderId: 'r-paused', symbol: 'ETH', side: 'buy', type: 'market', notionalPct: 5, stopLossPct: 12 } }),
      (err) => err.code === 'PORTFOLIO_PAUSED'
    );
    const freshBook = engine.createPortfolio(ctx.db, { userId: ctx.userId, actor: ctx.actor });
    engine.allocate(ctx.db, { portfolioId: freshBook, amountMinor: 25000, idempotencyKey: 'alloc-stale-0001', actor: ctx.actor });
    const stale = fakeFeed();
    stale.getLatest = async (symbols) => symbols.map((symbol) => ({
      symbol,
      priceMicro: 10_000_000n,
      ts: '2020-01-01T00:00:00.000Z',
      source: 'synthetic',
    }));
    await assert.rejects(
      engine.placeOrder(ctx.db, { ...base, portfolioId: freshBook, feed: stale, order: { clientOrderId: 'r-stale', symbol: 'SOL', side: 'buy', type: 'market', notionalPct: 5, stopLossPct: 12 } }),
      (err) => err.code === 'STALE_PRICE'
    );
    assert.throws(
      () => engine.createPortfolio(ctx.db, { userId: ctx.userId, actor: ctx.actor, risk: { maxTradesPerDay: 10 } }),
      (err) => err.code === 'RISK_LOOSER_THAN_HARD'
    );
  } finally {
    ctx.close();
  }
});

test('cash buffer rejects a buy that would leave less than 5 percent cash', async () => {
  const ctx = openDb();
  try {
    const id = await funded(ctx, '1000.00');
    const symbols = ['BTC', 'ETH', 'SOL', 'BNB'];
    for (let i = 0; i < symbols.length; i += 1) {
      await engine.placeOrder(ctx.db, {
        portfolioId: id,
        actor: ctx.actor,
        feed: ctx.feed,
        order: { clientOrderId: 'buf-' + symbols[i], symbol: symbols[i], side: 'buy', type: 'market', notionalPct: 20, stopLossPct: 12 },
      });
    }
    await assert.rejects(
      engine.placeOrder(ctx.db, {
        portfolioId: id,
        actor: ctx.actor,
        feed: ctx.feed,
        order: { clientOrderId: 'buf-xrp', symbol: 'XRP', side: 'buy', type: 'market', notionalPct: 16, stopLossPct: 12 },
      }),
      (err) => err.code === 'CASH_BUFFER'
    );
    const state = engine.readState(ctx.db, id);
    const cash = state.cashMicro;
    const equity = state.equityMicro;
    assert.ok(cash * 100n >= equity * 5n);
  } finally {
    ctx.close();
  }
});

test('market buy books a protective stop, fee, and a balanced ledger', async () => {
  const ctx = openDb();
  try {
    const id = await funded(ctx, '1000.00');
    const placed = await engine.placeOrder(ctx.db, {
      portfolioId: id,
      actor: ctx.actor,
      feed: ctx.feed,
      order: { clientOrderId: 'buy-btc-1', symbol: 'BTC', side: 'buy', type: 'market', notionalPct: 10, stopLossPct: 8 },
    });
    assert.equal(placed.order.status, 'filled');
    const orders = engine.listOrders(ctx.db, id);
    const stop = orders.find((order) => order.protective);
    assert.ok(stop);
    assert.equal(stop.side, 'sell');
    assert.equal(stop.type, 'stop');
    const fill = engine.listFills(ctx.db, id)[0];
    const expected = marketFill(100_000_000n, 'buy', 5);
    assert.equal(BigInt(fill.price_micro), expected);
    assert.ok(BigInt(fill.fee_micro) > 0n);
    const state = engine.readState(ctx.db, id);
    assert.equal(state.positions.length, 1);
    assert.equal(state.positions[0].symbol, 'BTC');
    assertBalanced(ctx.db, id);
    const again = await engine.placeOrder(ctx.db, {
      portfolioId: id,
      actor: ctx.actor,
      feed: ctx.feed,
      order: { clientOrderId: 'buy-btc-1', symbol: 'BTC', side: 'buy', type: 'market', notionalPct: 10, stopLossPct: 8 },
    });
    assert.equal(again.replayed, true);
    assert.equal(engine.listFills(ctx.db, id).length, 1);
    await assert.rejects(
      engine.placeOrder(ctx.db, {
        portfolioId: id,
        actor: ctx.actor,
        feed: ctx.feed,
        order: { clientOrderId: 'buy-btc-1', symbol: 'BTC', side: 'buy', type: 'market', notionalPct: 5, stopLossPct: 8 },
      }),
      (err) => err.code === 'IDEMPOTENCY_CONFLICT' && err.status === 409
    );
    const chain = verifyAudit(ctx.db);
    assert.equal(chain.ok, true);
    assert.ok(chain.count >= 2);
    const rows = ctx.db.prepare('SELECT * FROM paper_audit_log ORDER BY id').all();
    rows[1].payload_json = '{"tampered":true}';
    assert.equal(verifyRows(rows).ok, false);
    assert.throws(() => ctx.db.prepare('DELETE FROM paper_ledger_entries').run());
    assert.throws(() => ctx.db.prepare('DELETE FROM paper_audit_log').run());
    assert.throws(() => ctx.db.prepare('UPDATE paper_audit_log SET action = ?').run('nope'));
  } finally {
    ctx.close();
  }
});

test('kill switch pauses on a gap, cancels open buys, and only the owner resumes', async () => {
  const ctx = openDb();
  try {
    const id = await funded(ctx, '1000.00');
    await engine.placeOrder(ctx.db, {
      portfolioId: id,
      actor: ctx.actor,
      feed: ctx.feed,
      order: { clientOrderId: 'kill-btc', symbol: 'BTC', side: 'buy', type: 'market', notionalPct: 20, stopLossPct: 12 },
    });
    await engine.placeOrder(ctx.db, {
      portfolioId: id,
      actor: ctx.actor,
      feed: ctx.feed,
      order: { clientOrderId: 'kill-eth', symbol: 'ETH', side: 'buy', type: 'market', notionalPct: 10, stopLossPct: 12 },
    });
    const resting = await engine.placeOrder(ctx.db, {
      portfolioId: id,
      actor: ctx.actor,
      feed: ctx.feed,
      order: { clientOrderId: 'kill-limit', symbol: 'ETH', side: 'buy', type: 'limit', limitPrice: '1.00', notionalPct: 4, stopLossPct: 12 },
    });
    assert.equal(resting.order.status, 'open');
    ctx.feed.quotes.BTC = 1n;
    await engine.markPortfolio(ctx.db, { portfolioId: id, actor: ctx.actor, feed: ctx.feed });
    const state = engine.readState(ctx.db, id);
    assert.equal(state.portfolio.status, 'paused');
    assert.equal(state.portfolio.pause_reason, 'drawdown');
    const orders = engine.listOrders(ctx.db, id);
    const limit = orders.find((order) => order.client_order_id === 'kill-limit');
    assert.equal(limit.status, 'cancelled');
    const ethStop = orders.find((order) => order.protective && order.symbol === 'ETH' && order.status === 'open');
    assert.ok(ethStop, 'ETH protective stop remains');
    const agent = { type: 'agent', id: 'key:1', userId: ctx.userId, portfolioId: id };
    assert.throws(
      () => engine.resumePortfolio(ctx.db, { portfolioId: id, actor: agent }),
      (err) => err.code === 'OWNER_ONLY' && err.status === 403
    );
    engine.resumePortfolio(ctx.db, { portfolioId: id, actor: ctx.actor });
    assert.equal(engine.readState(ctx.db, id).portfolio.status, 'active');
    assert.equal(verifyAudit(ctx.db).ok, true);
    assertBalanced(ctx.db, id);
  } finally {
    ctx.close();
  }
});

test('backtest and the live bar engine produce the same fills on a fake feed', async () => {
  const ctx = openDb();
  try {
    const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM paper_ledger_entries').get().n;
    const bars = [];
    let price = 100_000_000n;
    for (let i = 0; i < 8; i += 1) {
      const open = price;
      const close = price + 50_000n;
      bars.push({
        ts: new Date(Date.UTC(2024, 0, i + 1)).toISOString(),
        openMicro: open,
        highMicro: close + 10_000n,
        lowMicro: open - 10_000n,
        closeMicro: close,
      });
      price = close;
    }
    const strategy = {
      id: 'scripted',
      version: '1',
      async onBar(barCtx) {
        if (barCtx.barIndex === 2) {
          return [{ clientOrderId: 'script-buy', symbol: 'BTC', side: 'buy', type: 'market', notionalPct: 10, stopLossPct: 12 }];
        }
        return [];
      },
    };
    const shared = {
      userId: ctx.userId,
      actor: ctx.actor,
      strategy,
      universe: ['BTC'],
      barsBySymbol: { BTC: bars },
      startingMicro: 1000n * 1000000n,
      feed: { id: 'synthetic' },
    };
    const backtest = await runEngineSession(ctx.db, { ...shared, mode: 'backtest' });
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM paper_ledger_entries').get().n, before);
    const live = await runEngineSession(ctx.db, { ...shared, mode: 'live-sim' });
    assert.ok(backtest.trades.length >= 1);
    assert.deepEqual(backtest.trades, live.trades);
    const expected = marketFill(bars[3].openMicro, 'buy', 5);
    assert.equal(backtest.trades[0].price, (Number(expected) / 1e6).toFixed(6));
    assert.equal(backtest.resultLabel, SIMULATED_RESULT);
    const btTotal = ledgerReport(ctx.db, bookFor('backtest', backtest.runId), backtest.portfolioId);
    assert.equal(btTotal.total, 0n);
    assert.ok(backtest.equity.length > 1);
  } finally {
    ctx.close();
  }
});

test('sma cross and rsi helpers follow the published rules', () => {
  const cross = [20, 20, 20, 20, 10, 10, 10, 30];
  assert.equal(crossesAbove(cross, 3, 5), true);
  assert.equal(crossesAbove([10, 10, 10, 10, 10, 10], 3, 5), false);
  const dip = Array.from({ length: 20 }, () => 100);
  dip.push(70);
  assert.ok(rsi(dip, 14) < 30);
});

test('price cache is encrypted and expires within 24 hours', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-cache-'));
  try {
    let now = 1_000_000;
    const cache = createPriceCache({
      dir,
      key: 'ab'.repeat(32),
      now: () => now,
    });
    cache.set('bitcoin', { price: 12345.67 }, 48 * 60 * 60 * 1000);
    const file = fs.readdirSync(dir).find((name) => name.endsWith('.bin'));
    const raw = fs.readFileSync(path.join(dir, file)).toString('utf8');
    assert.equal(raw.includes('12345.67'), false);
    assert.equal(raw.includes('bitcoin'), false);
    assert.deepEqual(cache.get('bitcoin'), { price: 12345.67 });
    now += 24 * 60 * 60 * 1000 + 1;
    assert.equal(cache.get('bitcoin'), null);
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.bin')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coingecko adapter sends the key in a header and not the URL', async () => {
  let seen;
  const feed = createCoinGeckoFeed({
    apiKey: 'test-key-not-a-secret-in-source',
    plan: 'demo',
    fetchImpl: async (url, opts) => {
      seen = { url: String(url), headers: opts.headers };
      return { ok: true, json: async () => ({ bitcoin: { usd: 100 } }) };
    },
  });
  const quotes = await feed.getLatest(['BTC']);
  assert.equal(quotes[0].priceMicro, 100_000_000n);
  assert.equal(seen.headers['x-cg-demo-api-key'], 'test-key-not-a-secret-in-source');
  assert.equal(seen.url.includes('test-key'), false);
  assert.match(feed.attribution, /Powered by CoinGecko/);
  assert.match(feed.attributionSecondary, /Data provided by CoinGecko/);
});

test('dependencies stay permissive and exclude broker SDKs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT');
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const forbidden = ['ccxt', 'binance', 'ethers', 'web3', 'viem', 'alpaca-trade-api', '@solana/web3.js'];
  for (const name of names) {
    assert.equal(forbidden.includes(name), false, name);
    const metaPath = path.join(__dirname, '..', 'node_modules', name, 'package.json');
    if (!fs.existsSync(metaPath)) continue;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const license = String(meta.license || '');
    assert.equal(/GPL|AGPL/i.test(license), false, name + ' ' + license);
  }
});

test('paper API requires auth and CSRF, labels demo results, and blocks an agent resume', async (t) => {
  const ctx = openDb();
  t.after(() => ctx.close());
  const anon = request(ctx.app);
  const denied = await anon.get('/api/demo/portfolios');
  assert.equal(denied.status, 401);
  assert.equal(denied.body.demo, true);
  assert.equal(denied.body.notice, DEMO_NOTICE);
  assert.equal(denied.body.simulated, true);

  const prices = await anon.get('/api/demo/prices');
  assert.equal(prices.status, 401);

  const agent = request.agent(ctx.app);
  const page = await agent.get('/register');
  await agent.post('/register').type('form').send({
    username: 'trader',
    email: 'trader@example.com',
    password: 'testpass123',
    _csrf: csrfFrom(page.text),
  });
  const home = await agent.get('/trade');
  assert.equal(home.status, 200);
  assert.match(home.text, /DEMO – inga riktiga pengar/);
  assert.match(home.text, /DEMO MODE/);
  assert.match(home.text, /Simulerat resultat/);
  const token = csrfFrom(home.text);
  const noCsrf = await agent.post('/api/demo/portfolios').set('Accept', 'application/json').send({ preset: 'hard-default' });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.notice, DEMO_NOTICE);

  const opened = await agent.post('/api/demo/portfolios')
    .set('Accept', 'application/json')
    .send({ _csrf: token, preset: 'hard-default', allocate: '200.00', idempotencyKey: 'alloc-http-0001' });
  assert.equal(opened.status, 201);
  assert.equal(opened.body.demo, true);
  assert.equal(opened.body.notice, DEMO_NOTICE);
  assert.equal(opened.body.simulated, true);
  assert.equal(opened.body.portfolio.unit, 'GGT (demo)');
  const portfolioId = opened.body.portfolio.id;

  const bought = await agent.post('/api/demo/portfolios/' + portfolioId + '/orders')
    .set('Accept', 'application/json')
    .send({
      _csrf: token,
      clientOrderId: 'http-buy-1',
      symbol: 'BTC',
      side: 'buy',
      type: 'market',
      notionalPct: 10,
      stopLossPct: 12,
    });
  assert.equal(bought.status, 201);
  assert.equal(bought.body.order.status, 'filled');
  assert.equal(bought.body.resultLabel, SIMULATED_RESULT);
  const positions = await agent.get('/api/demo/portfolios/' + portfolioId + '/positions');
  assert.equal(positions.body.positions[0].symbol, 'BTC');
  assert.equal(positions.body.notice, DEMO_NOTICE);

  const tooBig = await agent.post('/api/demo/portfolios/' + portfolioId + '/orders')
    .set('Accept', 'application/json')
    .send({
      _csrf: token,
      clientOrderId: 'http-buy-big',
      symbol: 'ETH',
      side: 'buy',
      type: 'market',
      notionalPct: 50,
      stopLossPct: 12,
    });
  assert.equal(tooBig.status, 400);
  assert.equal(tooBig.body.error, 'MAX_ORDER_SIZE');
  assert.match(tooBig.body.message, /Ordervärdet/);

  const replay = await agent.post('/api/demo/portfolios/' + portfolioId + '/orders')
    .set('Accept', 'application/json')
    .send({
      _csrf: token,
      clientOrderId: 'http-buy-1',
      symbol: 'BTC',
      side: 'buy',
      type: 'market',
      notionalPct: 10,
      stopLossPct: 12,
    });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);

  const key = await agent.post('/api/demo/portfolios/' + portfolioId + '/keys')
    .set('Accept', 'application/json')
    .send({ _csrf: token });
  assert.equal(key.status, 201);
  const resume = await request(ctx.app)
    .post('/api/demo/portfolios/' + portfolioId + '/resume')
    .set('Authorization', 'Bearer ' + key.body.token)
    .send({});
  assert.equal(resume.status, 403);
  assert.equal(resume.body.error, 'OWNER_ONLY');
  assert.equal(resume.body.notice, DEMO_NOTICE);

  const missing = await agent.get('/api/demo/prices');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.demo, true);
  assert.equal(missing.body.notice, DEMO_NOTICE);
  assert.equal(missing.body.prices, undefined);
  assert.equal(missing.body.bars, undefined);

  const backtest = await agent.post('/api/demo/backtests')
    .set('Accept', 'application/json')
    .send({
      _csrf: token,
      strategyId: 'monthly-rebalance',
      from: '2025-01-01',
      to: '2025-03-01',
    });
  assert.equal(backtest.status, 201);
  assert.equal(backtest.body.resultLabel, SIMULATED_RESULT);
  assert.match(backtest.body.resultLabelLong, /Simulerat resultat med DEMO/);
  assert.equal(backtest.body.metrics.riskFreeRate, 0);
  assert.equal(backtest.body.bars, undefined);
});

test('geoblock is an operator-configured header check', async () => {
  const ctx = openDb({ geo: { blockCountries: ['KP'], headerName: 'x-country-code', failClosed: false } });
  try {
    const agent = request.agent(ctx.app);
    const page = await agent.get('/register');
    await agent.post('/register').type('form').send({
      username: 'geo',
      email: 'geo@example.com',
      password: 'testpass123',
      _csrf: csrfFrom(page.text),
    });
    const blocked = await agent.get('/api/demo/instruments').set('x-country-code', 'KP');
    assert.equal(blocked.status, 451);
    assert.equal(blocked.body.error, 'GEO_BLOCKED');
    assert.equal(blocked.body.notice, DEMO_NOTICE);
    const allowed = await agent.get('/api/demo/instruments').set('x-country-code', 'SE');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.demo, true);
  } finally {
    ctx.close();
  }
});

test('wallet and paper custody stay in balance across an allocation', async () => {
  const ctx = openDb();
  try {
    const id = await funded(ctx, '200.00');
    const state = engine.readState(ctx.db, id);
    assert.equal(state.cashMicro, minorToMicro(20000));
    const user = ctx.db.prepare('SELECT balance_minor FROM ledger_accounts WHERE user_id = ?').get(ctx.userId);
    assert.equal(user.balance_minor, 80000);
    assertBalanced(ctx.db, id);
    const withdrawn = engine.withdraw(ctx.db, {
      portfolioId: id,
      amountMinor: 5000,
      idempotencyKey: 'withdraw-key-0001',
      actor: ctx.actor,
    });
    assert.equal(withdrawn.cashMicro, minorToMicro(15000));
    const after = ctx.db.prepare('SELECT balance_minor FROM ledger_accounts WHERE user_id = ?').get(ctx.userId);
    assert.equal(after.balance_minor, 85000);
    assertBalanced(ctx.db, id);
  } finally {
    ctx.close();
  }
});
