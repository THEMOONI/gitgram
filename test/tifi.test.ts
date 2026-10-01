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
const { createVenue, LIVE_MESSAGE } = require('../lib/tifi/venue.ts');
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
