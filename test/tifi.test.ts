const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const request = require('supertest');
const { createApp } = require('../server');
const { verifyAudit } = require('../lib/paper/audit');
const { evaluateGuard, validateLimits, clampLimits, marginMultiplier, dailyLossTripped, rollUtcDay } = require('../lib/tifi/guard.ts');
const { breakoutSignal, trendSignal, momentumRank, momentumSignal } = require('../lib/tifi/strategies.ts');
const { parseTigerSentence } = require('../lib/tifi/parser.ts');
const { createVenue, LIVE_MESSAGE, WORLD_LIVE_MESSAGE, executeLiveWorld } = require('../lib/tifi/venue.ts');
const { mapMarket, mapMarketList, createWorldFeed, simulatedReference, parseWorldStreamChunk } = require('../lib/tifi/world-feed.ts');
const { evaluateWorldGuard } = require('../lib/tifi/world-guard.ts');
const { quoteBuy, quoteSell, positionValue, settlementPayout, buyShares, settlePosition, feeBpsAt } = require('../lib/tifi/world-venue.ts');
const { decideWorldTiger } = require('../lib/tifi/world-decide.ts');
const { createDecisionModel } = require('../lib/tifi/model.ts');
const { decideTiger } = require('../lib/tifi/decide.ts');
const { seedDemo } = require('../lib/tifi/seed.ts');
const { splitEqual, freeMinor } = require('../lib/tifi/treasury.ts');
const { svMoney } = require('../lib/tifi/board.ts');
const engine = require('../lib/paper/engine');

function bar(close: number, high?: number, low?: number, volume = 0): any {
  return { open: close, high: high == null ? close : high, low: low == null ? close : low, close, volume };
}

function flat(n: number, close: number, volume = 100): any[] {
  const rows = [];
  for (let i = 0; i < n; i += 1) rows.push(bar(close, close + 0.2, close - 0.2, volume));
  return rows;
}

function limits(extra: any = {}): any {
  return {
    maxLeverage: 1,
    maxStopPct: 8,
    dailyLossPct: 5,
    maxTradesPerDay: 3,
    cooldownSec: 0,
    maxPositionPct: 10,
    feeBudgetPct: 5,
    symbols: ['BTC', 'ETH'],
    ...extra,
  };
}

function proposal(extra: any = {}): any {
  return {
    action: 'buy',
    symbol: 'BTC',
    notionalPct: 10,
    stopLossPct: 5,
    leverage: 1,
    rationale: 'test',
    probabilities: { buy: 0.7, sell: 0.1, hold: 0.2 },
    ...extra,
  };
}

function ctx(extra: any = {}): any {
  return {
    nowIso: '2026-01-15T12:00:00.000Z',
    proposal: proposal(),
    limits: limits(),
    engineMaxPositionPct: 20,
    engineMaxTradesPerDay: 5,
    engineMaxStopPct: 12,
    engineMaxOrderPct: 20,
    status: 'active',
    pauseReason: null,
    tradesToday: 0,
    lastTradeAt: null,
    feesTodayMicro: 0n,
    equityMicro: 1_000_000_000n,
    hasPosition: false,
    ...extra,
  };
}

function openDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tifi-'));
  const app = createApp({
    dbPath: path.join(dir, 'gitgram.db'),
    dataDir: path.join(dir, 'data'),
    sessionSecret: 'test-session-secret-value',
  });
  return {
    app,
    db: app.locals.db,
    dir,
    close() {
      app.locals.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('svMoney with 0 decimals has no trailing comma', () => {
  assert.equal(svMoney(34_000_000n, 0), '34');
  assert.equal(svMoney(34_120_000n, 0), '34');
  assert.equal(svMoney(34_120_000n, 2), '34,12');
  assert.equal(svMoney(1_034_000_000n, 0), '1\u00a0034');
  assert.equal(svMoney(0n, 0), '0');
  assert.equal(String(svMoney(34_000_000n, 0)).endsWith(','), false);
});

function worldCtx(extra: any = {}): any {
  return {
    nowIso: '2026-10-01T12:05:00.000Z',
    action: 'up',
    outcome: 'UP',
    side: 'buy',
    marketId: 'm1',
    closesAt: '2026-10-01T12:15:00.000Z',
    leverage: 1,
    stakePct: 10,
    maxStakePct: 10,
    closeBufferSec: 60,
    cashMicro: 100_000_000n,
    openStakeMicro: 0n,
    feeBps: 100,
    minOrderMicro: 0n,
    tradesToday: 0,
    maxTradesPerDay: 3,
    lastTradeAt: null,
    cooldownSec: 60,
    status: 'active',
    pauseReason: null,
    ...extra,
  };
}

test('simulated world feed moves and resolves without a network', async () => {
  let fetched = false;
  const early = createWorldFeed({}, {
    now: () => new Date('2026-10-01T12:00:30.000Z'),
    fetchImpl: async () => { fetched = true; throw new Error('network'); },
  });
  const later = createWorldFeed({}, { now: () => new Date('2026-10-01T12:05:30.000Z') });
  const next = createWorldFeed({}, { now: () => new Date('2026-10-01T12:16:00.000Z') });
  const first = await early.listActive();
  const second = await later.listActive();
  const third = await next.listActive();
  assert.equal(fetched, false);
  assert.equal(first.live, false);
  assert.equal(first.source, 'simulated');
  assert.deepEqual(first.markets.map((market: any) => market.seriesTicker), ['WXBTC15M', 'WXETH15M', 'WXSOL15M']);
  assert.deepEqual(first.markets.map((market: any) => market.underlying), ['BTC', 'ETH', 'SOL']);
  assert.equal(first.markets[0].outcomes[0].label, 'YES');
  assert.equal(first.markets[0].outcomes[1].label, 'NO');
  assert.equal(first.markets[0].source, 'simulated');
  assert.equal(first.markets[0].id, second.markets[0].id);
  assert.notEqual(first.markets[0].outcomes[0].mid, second.markets[0].outcomes[0].mid);
  assert.notEqual(third.markets[0].id, first.markets[0].id);
  const resolved = await next.getMarket(first.markets[0].id);
  const start = Date.parse(first.markets[0].opensAt);
  const winner = simulatedReference(start + 15 * 60 * 1000) >= simulatedReference(start) ? 'YES' : 'NO';
  assert.equal(resolved.resolution.resolved, true);
  assert.equal(resolved.resolution.winningOutcome, winner);
  assert.equal(resolved.status, 'finalized');
  const renamed = await createWorldFeed({ WORLD_SERIES_ETH: 'CUSTOMETH' }, {
    now: () => new Date('2026-10-01T12:00:30.000Z'),
  }).listActive();
  assert.equal(renamed.markets[1].seriesTicker, 'CUSTOMETH');
  assert.equal(renamed.markets[1].underlying, 'ETH');
});

test('world adapter maps a sample payload and ignores non-local urls', async () => {
  const sample = {
    ticker: 'WXBTC15M-1',
    seriesTicker: 'WXBTC15M',
    openTime: '2026-10-01T12:00:00.000Z',
    closeTime: '2026-10-01T12:15:00.000Z',
    status: 'active',
    result: '',
    yesBid: 0.46,
    yesAsk: 0.5,
    noBid: 0.5,
    noAsk: 0.54,
    source: 'simulated',
    fetchedAt: '2026-10-01T12:01:00.000Z',
    accounts: { marketLedger: 'led', yesMint: 'ym', noMint: 'nm' },
  };
  const market = mapMarket(sample);
  assert.equal(market.id, 'WXBTC15M-1');
  assert.equal(market.seriesTicker, 'WXBTC15M');
  assert.equal(market.underlying, 'BTC');
  assert.equal(market.outcomes[0].label, 'YES');
  assert.equal(market.outcomes[0].mid, 0.48);
  assert.equal(market.outcomes[0].mint, 'ym');
  assert.equal(market.outcomes[1].label, 'NO');
  assert.equal(market.source, 'simulated');
  assert.equal(market.fetchedAt, '2026-10-01T12:01:00.000Z');
  assert.equal(market.resolution.resolved, false);
  assert.equal((market as any).accounts, undefined);
  const finalized = mapMarket({ ...sample, status: 'finalized', result: 'no', yesBid: 0, yesAsk: 0, noBid: 1, noAsk: 1 });
  assert.equal(finalized.resolution.resolved, true);
  assert.equal(finalized.resolution.winningOutcome, 'NO');
  const legacy = mapMarket({
    id: 'old',
    underlying: 'ETH',
    status: 'active',
    outcomes: [{ label: 'up', bid: 0.4, ask: 0.42 }],
    source: 'chain',
    fetchedAt: '2026-10-01T12:01:00.000Z',
  });
  assert.equal(legacy.outcomes[0].label, 'YES');
  assert.equal(legacy.source, 'chain');
  assert.equal(mapMarket({ title: 'saknar id' }), null);
  assert.equal(mapMarketList({ markets: [sample, { nope: true }] }).length, 1);
  const events = parseWorldStreamChunk('data: ' + JSON.stringify(sample) + '\n\n');
  assert.equal(events[0].id, 'WXBTC15M-1');
  assert.equal(events[0].source, 'simulated');
  let called = false;
  const remote = createWorldFeed({ WORLD_FEED_URL: 'https://example.com/markets' }, {
    fetchImpl: async () => { called = true; return { ok: true, json: async () => [] }; },
  });
  const snap = await remote.listActive();
  assert.equal(called, false);
  assert.equal(snap.live, false);
  const local = createWorldFeed({ WORLD_FEED_URL: 'http://127.0.0.1:8793' }, {
    fetchImpl: async (url: string) => {
      assert.equal(url, 'http://127.0.0.1:8793/api/world/markets?status=active');
      return { ok: true, json: async () => [sample] };
    },
  });
  const live = await local.listActive();
  assert.equal(live.live, true);
  assert.equal(live.markets[0].outcomes[1].label, 'NO');
  assert.equal(live.markets[0].source, 'simulated');
});

test('world feed module has no trading client and no remote default', () => {
  const names = ['world-feed.ts', 'world-venue.ts', 'world-decide.ts', 'world-guard.ts'];
  const blob = names.map((name) => fs.readFileSync(path.join(__dirname, '../lib/tifi', name), 'utf8')).join('\n');
  assert.equal(/workers\.dev|markets-api-proxy/i.test(blob), false);
  assert.equal(/paybox/i.test(fs.readFileSync(path.join(__dirname, '../lib/tifi/world-feed.ts'), 'utf8')), false);
  const pkg = fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8');
  assert.equal(/paybox/i.test(pkg), false);
});

test('prediction-market settlement pays 1 DEMO or 0', () => {
  const clean = quoteBuy(10_000_000n, 500_000n, 0);
  assert.ok(clean);
  assert.equal(clean.sharesMicro, 20_000_000n);
  assert.equal(clean.costMicro, 10_000_000n);
  assert.equal(clean.feeMicro, 0n);
  assert.equal(positionValue(clean.sharesMicro, 500_000n), 10_000_000n);
  assert.equal(settlementPayout(clean.sharesMicro, true), 20_000_000n);
  assert.equal(settlementPayout(clean.sharesMicro, false), 0n);
  const sold = quoteSell(clean.sharesMicro, 480_000n, 0);
  assert.equal(sold.cashDeltaMicro, 9_600_000n);
  const withFee = quoteBuy(10_000_000n, 500_000n, 100);
  assert.ok(withFee.feeMicro > 0n);
  assert.ok(withFee.costMicro + withFee.feeMicro <= 10_000_000n);
  assert.equal(feeBpsAt(500_000n, 800), 400);
  assert.equal(feeBpsAt(0n, 800), 800);
  assert.equal(feeBpsAt(1_000_000n, 800), 0);
  const curved = quoteBuy(10_000_000n, 500_000n, feeBpsAt(500_000n, 800));
  assert.equal(curved.feeMicro, curved.costMicro * 400n / 10000n);
});

test('prediction-market guards block leverage, the close, the stake and the caps', () => {
  assert.equal(evaluateWorldGuard(worldCtx()).verdict, 'allow');
  assert.equal(evaluateWorldGuard(worldCtx({ leverage: 2 })).codes[0], 'NO_LEVERAGE');
  assert.equal(evaluateWorldGuard(worldCtx({ nowIso: '2026-10-01T12:14:30.000Z' })).codes[0], 'CLOSE_BUFFER');
  assert.equal(evaluateWorldGuard(worldCtx({ stakePct: 50 })).codes[0], 'STAKE');
  assert.equal(evaluateWorldGuard(worldCtx({ openStakeMicro: 10_000_000n })).codes[0], 'STAKE');
  assert.equal(evaluateWorldGuard(worldCtx({ tradesToday: 3 })).codes[0], 'TRADE_CAP');
  assert.equal(evaluateWorldGuard(worldCtx({ lastTradeAt: '2026-10-01T12:04:30.000Z' })).codes[0], 'COOLDOWN');
  assert.equal(evaluateWorldGuard(worldCtx({ action: 'abstain', outcome: null, side: null })).codes[0], 'ABSTAIN');
  assert.equal(evaluateWorldGuard(worldCtx({ cashMicro: 500_000n })).verdict, 'allow');
});

test('real world or paybox execution stays locked', () => {
  assert.throws(() => executeLiveWorld(), (err: any) => {
    return err.code === 'LIVE_LOCKED' && /Riktiga pengar är inte tillåtna/.test(err.message) && /sagt nej/.test(err.message);
  });
  assert.throws(() => createVenue('paybox', { placeOrder: async () => null }), (err: any) => err.code === 'LIVE_LOCKED' && err.message === WORLD_LIVE_MESSAGE + ' Begärt läge: paybox.');
  assert.equal(LIVE_MESSAGE.length > 0, true);
});

test('a world decision is logged before a paper fill, and settlement is idempotent', async () => {
  const ctx = openDb();
  try {
    const seeded = await seedDemo(ctx.db, {
      username: 'world',
      password: 'tifi-demo',
      ownerPassword: 'tigerpapper-2026',
      steps: 0,
    });
    const tiger = ctx.db.prepare('SELECT * FROM tifi_tigers WHERE user_id = ? AND slot = 1').get(seeded.userId);
    const now = '2026-10-01T12:05:00.000Z';
    await assert.rejects(decideWorldTiger(ctx.db, tiger, {
      bars: [],
      nowIso: now,
      model: {
        id: 'fake-local',
        async propose() {
          return proposal({ symbol: 'BTC', rationale: 'Simulerad testpost. Ingen rekommendation.' });
        },
      },
      feed: createWorldFeed({}, { now: () => new Date(now) }),
      env: {},
      execute: async () => {
        const row = ctx.db.prepare(`SELECT action FROM paper_audit_log WHERE action = 'tifi_decision' ORDER BY id DESC LIMIT 1`).get();
        assert.equal(row.action, 'tifi_decision');
        const fills = ctx.db.prepare('SELECT COUNT(*) AS n FROM tifi_world_fills WHERE tiger_id = ?').get(tiger.id);
        assert.equal(fills.n, 0);
        throw new Error('halt-before-fill');
      },
    }), /halt-before-fill/);
    const bought = buyShares(ctx.db, {
      tiger,
      market: {
        id: 'm-settle',
        title: 'BTC upp eller ned, 15 min',
        outcomes: [{ label: 'YES', bid: 0.48, ask: 0.5, mid: 0.49 }],
      },
      outcome: 'YES',
      budgetMicro: 10_000_000n,
      feeBps: 0,
      ts: now,
    });
    assert.equal(bought.ok, true);
    const position = ctx.db.prepare('SELECT * FROM tifi_world_positions WHERE tiger_id = ? AND market_id = ?').get(tiger.id, 'm-settle');
    const settled = settlePosition(ctx.db, { tiger, position, winningOutcome: 'YES', ts: '2026-10-01T12:15:00.000Z' });
    assert.equal(settled.payoutMicro, bought.ticket.sharesMicro);
    const again = ctx.db.prepare('SELECT * FROM tifi_world_positions WHERE tiger_id = ? AND market_id = ?').get(tiger.id, 'm-settle');
    assert.equal(settlePosition(ctx.db, { tiger, position: again, winningOutcome: 'YES', ts: '2026-10-01T12:15:00.000Z' }).code, 'SETTLED');
    assert.equal(verifyAudit(ctx.db).ok, true);
  } finally {
    ctx.close();
  }
});

test('guard rejects each limit and keeps leverage at 1x', () => {
  assert.equal(marginMultiplier(), 1);
  assert.equal(evaluateGuard(ctx()).verdict, 'allow');
  assert.equal(evaluateGuard(ctx()).leverageApplied, 1);

  const wide = evaluateGuard(ctx({ proposal: proposal({ leverage: 3 }) }));
  assert.equal(wide.verdict, 'reject');
  assert.ok(wide.codes.includes('LEVERAGE'));

  const scaled = evaluateGuard(ctx({ proposal: proposal({ leverage: 2 }), limits: limits({ maxLeverage: 2 }) }));
  assert.equal(scaled.verdict, 'allow');
  assert.ok(scaled.codes.includes('LEVERAGE_SCALED'));
  assert.equal(scaled.leverageApplied, 1);
  assert.equal(scaled.order.notionalPct, 10);

  const stop = evaluateGuard(ctx({ proposal: proposal({ stopLossPct: 15 }) }));
  assert.equal(stop.verdict, 'reject');
  assert.ok(stop.codes.includes('STOP_TOO_WIDE'));

  const cap = evaluateGuard(ctx({ tradesToday: 3 }));
  assert.equal(cap.verdict, 'reject');
  assert.ok(cap.codes.includes('TRADE_CAP'));

  const cool = evaluateGuard(ctx({
    lastTradeAt: '2026-01-15T11:59:30.000Z',
    limits: limits({ cooldownSec: 60 }),
  }));
  assert.equal(cool.verdict, 'reject');
  assert.ok(cool.codes.includes('COOLDOWN'));

  assert.equal(dailyLossTripped(1000n, 940n, 5), true);
  assert.equal(dailyLossTripped(1000n, 960n, 5), false);
  const rolled = rollUtcDay({ status: 'paused', pauseReason: 'daily_loss', dayUtc: '2026-01-01' }, '2026-01-02');
  assert.equal(rolled.status, 'active');
  assert.equal(rolled.pauseReason, null);
  const same = rollUtcDay({ status: 'paused', pauseReason: 'daily_loss', dayUtc: '2026-01-02' }, '2026-01-02');
  assert.equal(same.status, 'paused');

  const paused = evaluateGuard(ctx({ status: 'paused', pauseReason: 'daily_loss' }));
  assert.equal(paused.verdict, 'reject');
  assert.ok(paused.codes.includes('PAUSED_DAILY'));

  assert.ok(validateLimits(limits({ maxTradesPerDay: 8 })).includes('trades'));
  assert.ok(validateLimits(limits({ maxLeverage: 3 })).includes('leverage'));
  const clamped = clampLimits({ maxPositionPct: 40, maxStopPct: 30, maxTradesPerDay: 9, symbols: ['BTC'] });
  assert.equal(clamped.limits.maxPositionPct, 20);
  assert.equal(clamped.limits.maxStopPct, 12);
  assert.equal(clamped.limits.maxTradesPerDay, 5);
  assert.ok(clamped.notes.length >= 1);
});

test('sentence parser reads Swedish and English and clamps', () => {
  const sv = parseTigerSentence('Skapa en momentum-tiger som handlar BTC och ETH med max 10 % per position och stopp på 5 %', { slot: 3 });
  assert.equal(sv.ok, true);
  assert.equal(sv.config.strategy, 'momentum');
  assert.deepEqual(sv.config.symbols, ['BTC', 'ETH']);
  assert.equal(sv.config.maxPositionPct, 10);
  assert.equal(sv.config.stopPct, 5);
  assert.equal(sv.config.name, 'TIFI 3');

  const en = parseTigerSentence('Create a breakout tiger that trades BTC with max 15% per position and a stop of 8%');
  assert.equal(en.ok, true);
  assert.equal(en.config.strategy, 'breakout');
  assert.deepEqual(en.config.symbols, ['BTC']);
  assert.equal(en.config.maxPositionPct, 15);
  assert.equal(en.config.stopPct, 8);

  const loose = parseTigerSentence('A trend tiger that trades ETH with max 40% per position and stop 30%');
  assert.equal(loose.ok, true);
  assert.equal(loose.config.maxPositionPct, 20);
  assert.equal(loose.config.stopPct, 12);
  assert.ok(loose.notes.length >= 1);
  assert.equal(parseTigerSentence('hej').ok, false);
});

test('breakout, trend and momentum are pure functions of bars', () => {
  const quiet = flat(21, 10, 50);
  assert.equal(breakoutSignal(quiet, { channel: 20, atrPeriod: 5, atrMultiple: 0.5, volumePeriod: 5 }).action, 'hold');
  const burst = quiet.concat([bar(12, 12.4, 11.5, 400)]);
  const broke = breakoutSignal(burst, { channel: 20, atrPeriod: 5, atrMultiple: 0.5, volumePeriod: 5, stopPct: 8 });
  assert.equal(broke.action, 'enter');
  assert.ok(broke.strength > 0);

  const up = [bar(5), bar(1), bar(1), bar(4)];
  assert.equal(trendSignal(up, { short: 2, long: 3 }).action, 'enter');
  const down = [bar(1), bar(3), bar(3), bar(1)];
  assert.equal(trendSignal(down, { short: 2, long: 3 }).action, 'exit');

  const series = {
    AAA: [bar(10), bar(10), bar(10)],
    BBB: [bar(10), bar(10), bar(14)],
  };
  const ranked = momentumRank(series, { rocPeriod: 2 });
  assert.equal(ranked[0].symbol, 'BBB');
  const signal = momentumSignal(series, { rocPeriod: 2, minRoc: 0, stopPct: 5 }, null);
  assert.equal(signal.action, 'enter');
  assert.equal(signal.symbol, 'BBB');
});

test('live mode refuses to start', () => {
  assert.throws(() => createVenue('live', { placeOrder: async () => null }), (err: any) => {
    assert.equal(err.code, 'LIVE_LOCKED');
    assert.match(err.message, /Fas 2/);
    assert.match(err.message, /godkännande/);
    assert.equal(LIVE_MESSAGE.length > 20, true);
    return true;
  });
  assert.throws(() => createVenue('exchange', { placeOrder: async () => null }), (err: any) => err.code === 'LIVE_LOCKED');
  assert.equal(createVenue('paper', { placeOrder: async () => ({ ok: true }) }).mode, 'paper');
});

test('the local model is used when no API key is set', async () => {
  const model = createDecisionModel({});
  assert.equal(model.id, 'fake-local');
  const proposal = await model.propose({
    action: 'enter', symbol: 'BTC', strength: 0.5, stopPct: 5, note: 'test',
  }, { maxPositionPct: 10, maxStopPct: 8 });
  const sum = proposal.probabilities.buy + proposal.probabilities.sell + proposal.probabilities.hold;
  assert.ok(Math.abs(sum - 1) < 0.01);
  assert.equal(proposal.modelCostMicro, 0);
  assert.equal(proposal.leverage, 1);
});

test('a decision is logged before an order is sent', async () => {
  const ctx = openDb();
  try {
    await seedDemo(ctx.db, { username: 'tiger', password: 'tifi-demo', ownerPassword: 'tigerpapper-2026', steps: 0 });
    const tiger = ctx.db.prepare('SELECT * FROM tifi_tigers WHERE user_id = ? AND slot = 3').get(
      ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('tiger').id,
    );
    let loggedFirst = false;
    await assert.rejects(decideTiger(ctx.db, tiger, {
      series: { SOL: flat(5, 10) },
      barTs: '2026-02-01T00:00:00.000Z',
      model: {
        id: 'fake-local',
        async propose() {
          return proposal({ symbol: 'SOL', rationale: 'Simulerad testpost. Ingen rekommendation.' });
        },
      },
      place: async () => {
        const row = ctx.db.prepare(`SELECT action FROM paper_audit_log WHERE action = 'tifi_decision' ORDER BY id DESC LIMIT 1`).get();
        loggedFirst = !!(row && row.action === 'tifi_decision');
        const orders = ctx.db.prepare('SELECT COUNT(*) AS n FROM paper_orders WHERE portfolio_id = ?').get(tiger.portfolio_id);
        assert.equal(orders.n, 0);
        throw new Error('halt-before-broker');
      },
      quote: { priceMicro: 100_000_000n, ts: '2026-02-01T00:00:00.000Z', source: 'synthetic' },
    }), /halt-before-broker/);
    assert.equal(loggedFirst, true);
    const saved = ctx.db.prepare('SELECT guard_verdict FROM tifi_decisions WHERE tiger_id = ?').get(tiger.id);
    assert.equal(saved.guard_verdict, 'allow');
    assert.equal(verifyAudit(ctx.db).ok, true);
    const orders = ctx.db.prepare('SELECT COUNT(*) AS n FROM paper_orders WHERE portfolio_id = ?').get(tiger.portfolio_id);
    assert.equal(orders.n, 0);
  } finally {
    ctx.close();
  }
});

test('treasury split and dashboard are paper only', async () => {
  assert.deepEqual(splitEqual(100000, 3), [33334, 33333, 33333]);
  const ctx = openDb();
  try {
    const seeded = await seedDemo(ctx.db, {
      username: 'tifi',
      password: 'tifi-demo',
      ownerPassword: 'tigerpapper-2026',
      steps: 30,
    });
    assert.equal(seeded.already, false);
    const tigers = ctx.db.prepare('SELECT name, strategy, allocated_minor FROM tifi_tigers ORDER BY slot').all();
    assert.deepEqual(tigers.map((row: any) => row.name), ['TIFI 1', 'TIFI 2', 'TIFI 3']);
    assert.deepEqual(tigers.map((row: any) => row.strategy), ['breakout', 'trend', 'momentum']);
    const allocated = tigers.reduce((sum: number, row: any) => sum + row.allocated_minor, 0);
    assert.equal(allocated, 100000);
    const decisions = ctx.db.prepare('SELECT COUNT(*) AS n FROM tifi_decisions').get().n;
    assert.ok(decisions > 0);
    const treasury = ctx.db.prepare('SELECT portfolio_id FROM tifi_treasury').get();
    assert.equal(freeMinor(engine.readState(ctx.db, treasury.portfolio_id)), 0);
    assert.equal(verifyAudit(ctx.db).ok, true);

    const agent = request.agent(ctx.app);
    const loginPage = await agent.get('/login').expect(200);
    const csrf = loginPage.text.match(/name="_csrf" value="([a-f0-9]+)"/);
    assert.ok(csrf);
    await agent.post('/login').type('form').send({ username: 'tifi', password: 'tifi-demo', _csrf: csrf[1] }).expect(302);
    await request(ctx.app).get('/bots').expect(302).expect('Location', '/login');
    const bots = await agent.get('/bots');
    assert.equal(bots.status, 302);
    assert.equal(bots.headers.location, '/tifi');
    const page = await agent.get('/tifi').expect(200);
    assert.match(page.text, /DEMO – inga riktiga pengar/);
    assert.match(page.text, /PAPER TRADING/);
    assert.match(page.text, /Simulerat resultat/);
    assert.match(page.text, /TIFI 1/);
    assert.match(page.text, /TIFI 2/);
    assert.match(page.text, /TIFI 3/);
    assert.match(page.text, /AI-tiger/);
    assert.match(page.text, /World-marknader \(papper, endast eget bruk, simulerat\/kedjedata\)/);
    assert.match(page.text, /Simulerat flöde/);
    assert.match(page.text, /class="sim-flag">simulerat</);
    assert.match(page.text, /WXBTC15M/);
    assert.match(page.text, /WXETH15M/);
    assert.match(page.text, /WXSOL15M/);
    assert.match(page.text, /Ingen export, ingen delning och ingen offentlig visning/);
    const tiger = ctx.db.prepare('SELECT id, venue FROM tifi_tigers WHERE slot = 1').get();
    assert.equal(tiger.venue, 'world');
    const token = page.text.match(/name="_csrf" value="([a-f0-9]+)"/);
    assert.ok(token);
    await agent.post('/tifi/tigers/' + tiger.id + '/venue').type('form').send({
      _csrf: token[1], venue: 'paper', owner_password: 'fel-losenord',
    }).expect(302);
    assert.equal(ctx.db.prepare('SELECT venue FROM tifi_tigers WHERE id = ?').get(tiger.id).venue, 'world');
    await agent.post('/tifi/tigers/' + tiger.id + '/venue').type('form').send({
      _csrf: token[1], venue: 'paper', owner_password: 'tigerpapper-2026',
    }).expect(302);
    assert.equal(ctx.db.prepare('SELECT venue FROM tifi_tigers WHERE id = ?').get(tiger.id).venue, 'paper');
    const state = await agent.get('/tifi/api/state').expect(200);
    assert.equal(state.body.demo, true);
    assert.equal(state.body.notice, 'DEMO – inga riktiga pengar');
    assert.equal(state.body.board.leaderboard[0].equity, undefined);
    for (const row of state.body.board.allocation) {
      assert.equal(String(row.inPosition).endsWith(','), false);
    }
  } finally {
    ctx.close();
  }
});
