const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const request = require('supertest');
const WebSocket = require('ws');
const { createApp } = require('../server');
const { hasTradeWording } = require('../lib/team/trading/wording');
const { safeDexScreenerUrl, validateTradingAlert } = require('../lib/team/trading/validate');
const { reconnectDelay } = require('../lib/team/trading/watcher');
const { isQuietHour } = require('../lib/team/trading/notify');
const { renderTradingAlertHtml } = require('../public/js/team');
const teamConfig = require('../config/team.json');

const DISCLAIMER = teamConfig.tradingDisclaimer;
const DEMO = teamConfig.tradingDemoLabel;
const SHORT = teamConfig.tradingNoticeDisclaimer;
const MINT_A = 'DemoMint11111111111111111111111111111111';

function mint(n) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = n + 1;
  let suffix = '';
  while (value > 0) {
    suffix = alphabet[value % 58] + suffix;
    value = Math.floor(value / 58);
  }
  return (`D${suffix}${'1'.repeat(44)}`).slice(0, 44);
}

function alertAt(n, overrides = {}) {
  const tsMs = overrides.tsMs != null ? overrides.tsMs : 1790813200123 + n * 1000;
  const idMint = overrides.mint || mint(n);
  const stage = overrides.stage || 'uppföljning';
  const ts = new Date(tsMs).toISOString();
  const link = Object.prototype.hasOwnProperty.call(overrides, 'link')
    ? overrides.link
    : `https://dexscreener.com/solana/${idMint}`;
  const rest = { ...overrides };
  delete rest.tsMs;
  delete rest.mint;
  delete rest.stage;
  delete rest.ts;
  delete rest.id;
  delete rest.link;
  return {
    symbol: 'CAT',
    name: 'cat',
    label: 'MEDEL',
    score: 38,
    source: 'pumpportal-ny',
    summary: `Ny token uppföljning ${n}: likviditet noterad, risk MEDEL, varningssignal låg nivå.`,
    liquidity_usd: 12000,
    top_reasons: ['Låg likviditet', 'Ny token'],
    disclaimer: DISCLAIMER,
    ...rest,
    mint: idMint,
    stage,
    ts,
    id: `${idMint}:${stage}:${tsMs}`,
    link,
  };
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  assert.ok(match, 'csrf token missing');
  return match[1];
}

function cookiePair(setCookie) {
  const jar = new Map();
  for (const value of setCookie || []) {
    const pair = value.split(';')[0];
    jar.set(pair.split('=')[0], pair);
  }
  return [...jar.values()].join('; ');
}

async function start(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-trading-'));
  const app = createApp({
    dbPath: path.join(dir, 'gitgram.db'),
    dataDir: path.join(dir, 'data'),
    sessionSecret: 'test-session-secret-value',
    flagsToken: '',
    tradingAlertsToken: options.tradingAlertsToken === undefined ? 'trading-test-token' : options.tradingAlertsToken,
    tradingWatcherUrl: options.tradingWatcherUrl === undefined ? '' : options.tradingWatcherUrl,
    tradingExcludeFile: options.tradingExcludeFile || '',
    ownerUsername: options.ownerUsername === undefined ? 'milad' : options.ownerUsername,
    tradingNow: options.tradingNow,
    tradingMinLiquidity: options.tradingMinLiquidity,
    tradingQuietHours: options.tradingQuietHours,
    tradingRateLimit: options.tradingRateLimit,
    tradingReconnect: options.tradingReconnect,
  });
  const server = http.createServer(app);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  app.locals.attachRealtime(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    app,
    dir,
    port,
    db: app.locals.db,
    async close() {
      if (app.locals.stopTradingWatcher) app.locals.stopTradingWatcher();
      for (const socket of sockets) socket.destroy();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
      app.locals.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function register(agent, username) {
  const page = await agent.get('/register');
  const created = await agent.post('/register').redirects(0).type('form').send({
    username,
    email: `${username}@example.com`,
    password: 'testpass123',
    _csrf: csrfFrom(page.text),
  });
  assert.equal(created.status, 302);
  return cookiePair([].concat(page.headers['set-cookie'] || [], created.headers['set-cookie'] || []));
}

function postAlert(ctx, body) {
  return request(ctx.app)
    .post('/api/team/trading-alerts')
    .set('Authorization', 'Bearer trading-test-token')
    .send(body);
}

async function waitFor(fn, timeout = 3000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

function startFakeWatcher() {
  const alerts = [];
  const paths = [];
  let stream = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    paths.push(url.pathname);
    if (url.pathname === '/api/alerts' || url.pathname === '/api/stream') {
      res.statusCode = 500;
      return res.end('unused');
    }
    if (url.pathname === '/api/stats') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ pumpportal_connected: true }));
    }
    if (url.pathname === '/api/team/summaries') {
      const since = Number(url.searchParams.get('since_ms') || 0);
      const summaries = alerts.filter((item) => Date.parse(item.ts) > since);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ summaries }));
    }
    if (url.pathname === '/api/team/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': keepalive\n\n');
      stream = res;
      req.on('close', () => {
        if (stream === res) stream = null;
      });
      return;
    }
    res.statusCode = 404;
    return res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        paths,
        push(alert) {
          alerts.push(alert);
          if (stream) stream.write(`event: alert\ndata: ${JSON.stringify(alert)}\n\n`);
        },
        remember(alert) {
          alerts.push(alert);
        },
        endStream() {
          if (stream) stream.end();
        },
        close() {
          return new Promise((done) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(() => done());
          });
        },
      });
    });
  });
}

test('wording, links, backoff, and quiet hours', () => {
  assert.equal(hasTradeWording('please buy now'), true);
  assert.equal(hasTradeWording('time to sell'), true);
  assert.equal(hasTradeWording('sälj inte'), true);
  assert.equal(hasTradeWording('Köp token'), true);
  assert.equal(hasTradeWording('kop nu'), true);
  assert.equal(hasTradeWording('mikroskop'), false);
  assert.equal(hasTradeWording('Ny token CAT, likviditet låg'), false);
  assert.equal(hasTradeWording('[dolt: namnet innehåller en handelsuppmaning]'), false);
  assert.equal(reconnectDelay(0), 2000);
  assert.equal(reconnectDelay(1), 4000);
  assert.equal(reconnectDelay(2), 8000);
  assert.equal(reconnectDelay(5), 60000);
  assert.equal(reconnectDelay(0, 40, 200), 40);
  assert.equal(reconnectDelay(3, 40, 200), 200);
  assert.equal(isQuietHour(new Date('2026-01-15T00:30:00.000Z'), { start: 0, end: 7 }), true);
  assert.equal(isQuietHour(new Date('2026-01-15T02:30:00.000Z'), { start: 0, end: 7 }), true);
  assert.equal(isQuietHour(new Date('2026-01-15T06:00:00.000Z'), { start: 0, end: 7 }), false);
  assert.equal(isQuietHour(new Date('2026-01-15T11:30:00.000Z'), { start: 0, end: 7 }), false);
  const bad = safeDexScreenerUrl('javascript:alert(1)', MINT_A);
  assert.equal(bad, '');
  assert.equal(safeDexScreenerUrl('https://evil.example/solana/' + MINT_A, MINT_A), '');
  assert.equal(safeDexScreenerUrl('https://dexscreener.com.evil/solana/' + MINT_A, MINT_A), '');
  assert.equal(safeDexScreenerUrl(`https://user:pass@dexscreener.com/solana/${MINT_A}`, MINT_A), '');
  assert.equal(
    safeDexScreenerUrl(`https://dexscreener.com/solana/${MINT_A}`, MINT_A),
    `https://dexscreener.com/solana/${MINT_A}`,
  );
  assert.equal(
    safeDexScreenerUrl(`http://www.dexscreener.com/solana/${MINT_A}`, MINT_A),
    `http://www.dexscreener.com/solana/${MINT_A}`,
  );
  const sample = alertAt(1, { mint: MINT_A });
  assert.equal(validateTradingAlert({ ...sample, extra: true }).ok, false);
  assert.equal(validateTradingAlert({ ...sample, link: 'https://example.com/solana/' + MINT_A }).error, 'link');
  const html = renderTradingAlertHtml({
    id: 4,
    externalId: sample.id,
    mint: MINT_A,
    symbol: '<b>CAT</b>',
    name: '<i>cat</i>',
    label: 'HÖG',
    score: 70,
    stage: 'uppföljning',
    source: 'pumpportal-ny',
    summary: '<script>alert(1)</script>',
    reasons: ['<img src=x onerror=alert(1)>'],
    link: 'javascript:alert(1)',
    safeUrl: 'javascript:alert(1)',
    demoLabel: DEMO,
    disclaimer: DISCLAIMER,
    createdAt: sample.ts,
    displayTime: '2026-10-01 00:06',
    acknowledgements: [],
  }, { csrfToken: 'abc' });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /team-demo-banner/);
  assert.match(html, /informational only, not financial advice/);
  assert.match(html, /Risk score 70/);
  assert.match(html, /team-risk-badge hog/);
  assert.match(html, new RegExp(DISCLAIMER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const watcherSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'team', 'trading', 'watcher.js'), 'utf8');
  assert.doesNotMatch(watcherSource, /\/api\/alerts/);
  assert.doesNotMatch(watcherSource, /\/api\/stream(?!s)/);
  assert.match(watcherSource, /\/api\/team\/stream/);
  assert.match(watcherSource, /\/api\/team\/summaries/);
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'trading-exclude.example.json'), 'utf8'));
  assert.deepEqual(example.mints, [MINT_A]);
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /\$TRADING_ALERTS_TOKEN/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'routes', 'team.js'), 'utf8'), /tokensEqual\(provided, tradingAlertsToken\)/);
});

test('trading room is limited to the owner and cards can be filtered and acknowledged', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const milad = request.agent(ctx.app);
  const bob = request.agent(ctx.app);
  const miladCookie = await register(milad, 'milad');
  const bobCookie = await register(bob, 'bob');
  const page = await milad.get('/team/trading');
  assert.equal(page.status, 200);
  assert.match(page.text, /id="trading-channel-disclaimer"/);
  assert.match(page.text, /team-demo-banner/);
  assert.match(page.text, /informational only, not financial advice/);
  assert.match(page.text, new RegExp(DISCLAIMER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(page.text, /href="\/team\/trading"/);
  assert.doesNotMatch(page.text, /127\.0\.0\.1:8787/);
  assert.match(page.text, /aria-label="Trading, AI-agent"/);
  assert.match(page.text, /<b>Trading<\/b> är en AI-agent som handlar för <b>Scavvers Labs<\/b>/);
  assert.match(page.text, /class="ai-badge"/);
  assert.match(page.text, /class="ai-first"/);
  const token = csrfFrom(page.text);
  const denied = await bob.get('/team/trading');
  assert.equal(denied.status, 403);
  const bobHome = await bob.get('/team/general');
  assert.equal(bobHome.status, 200);
  assert.doesNotMatch(bobHome.text, /href="\/team\/trading"/);
  assert.doesNotMatch(bobHome.text, /Signalerna får inte publiceras/);
  const bobTimeline = await bob.get('/api/team/rooms/trading/timeline');
  assert.equal(bobTimeline.status, 403);
  const added = await milad.post('/api/team/rooms/trading/members').set('x-csrf-token', token).send({ username: 'bob' });
  assert.equal(added.status, 403);
  const bobPost = await bob.post('/api/team/rooms/trading/messages').set('x-csrf-token', csrfFrom(bobHome.text)).send({ body: 'hello trading' });
  assert.equal(bobPost.status, 403);

  const agent = ctx.db.prepare('SELECT token FROM agents WHERE slug = ?').get('trading');
  const context = await request(ctx.app)
    .get('/api/team/rooms/trading/context')
    .query({ messageId: 999999 })
    .set('Authorization', `Bearer ${agent.token}`);
  assert.equal(context.status, 404);

  const low = alertAt(1, { label: 'LÅG', summary: 'Låg signal för filtertestet.', score: 12 });
  const mid = alertAt(2, { label: 'MEDEL', summary: 'Medel signal för filtertestet.', score: 40 });
  low.summary = 'Låg signal <script>alert(1)</script>';
  low.top_reasons = ['<img src=x onerror=alert(1)>'];
  const createdLow = await postAlert(ctx, low);
  assert.equal(createdLow.status, 201);
  assert.equal(createdLow.body.alert.liquidity_usd, undefined);
  assert.equal(createdLow.body.alert.score, 12);
  assert.equal(createdLow.body.alert.demoLabel, DEMO);
  const createdMid = await postAlert(ctx, mid);
  assert.equal(createdMid.status, 201);
  const shown = await milad.get('/team/trading');
  assert.match(shown.text, /Låg signal &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(shown.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(shown.text, /<script>alert/);
  assert.doesNotMatch(shown.text, /<img src=x/);
  assert.match(shown.text, /Risk score 12/);
  assert.match(shown.text, /team-risk-badge lag/);
  assert.match(shown.text, /team-risk-badge medel/);
  assert.match(shown.text, /Source <span>pumpportal-ny<\/span>/);
  assert.match(shown.text, new RegExp(`rel="noopener noreferrer"[^>]*href="https://dexscreener.com/solana/${low.mint}"|href="https://dexscreener.com/solana/${low.mint}"[^>]*rel="noopener noreferrer"`));
  assert.doesNotMatch(shown.text, />\s*(Buy|Sell|Köp|Sälj)\s*</);
  const general = await milad.get('/team/general');
  assert.doesNotMatch(general.text, /Låg signal/);
  assert.doesNotMatch(general.text, /Medel signal för filtertestet/);

  const ack = await milad.post(`/api/team/trading-alerts/${createdLow.body.alert.id}/ack`).type('form').send({ _csrf: token });
  assert.equal(ack.status, 302);
  const done = await milad.get('/team/trading?ack=done');
  assert.match(done.text, /Acknowledged by milad at/);
  assert.match(done.text, /id="trading-alert-1"/);
  assert.doesNotMatch(done.text, /id="trading-alert-2"/);
  const open = await milad.get('/team/trading?ack=open&risk=MEDEL');
  assert.match(open.text, /id="trading-alert-2"/);
  assert.doesNotMatch(open.text, /id="trading-alert-1"/);
  const onlyLow = await milad.get('/team/trading?risk=LÅG');
  assert.match(onlyLow.text, /id="trading-alert-1"/);
  assert.doesNotMatch(onlyLow.text, /id="trading-alert-2"/);
  const row = ctx.db.prepare(`
    SELECT u.username, aa.created_at
    FROM trading_alert_acks aa JOIN users u ON u.id = aa.user_id
    WHERE aa.alert_id = ?
  `).get(createdLow.body.alert.id);
  assert.equal(row.username, 'milad');
  assert.ok(row.created_at);
  const bobAck = await bob.post(`/api/team/trading-alerts/${createdLow.body.alert.id}/ack`)
    .set('x-csrf-token', csrfFrom(bobHome.text))
    .send({});
  assert.equal(bobAck.status, 403);

  const ownerWs = new WebSocket(`ws://127.0.0.1:${ctx.port}/team/ws`, {
    headers: { Cookie: miladCookie, Origin: `http://127.0.0.1:${ctx.port}` },
  });
  const bobWs = new WebSocket(`ws://127.0.0.1:${ctx.port}/team/ws`, {
    headers: { Cookie: bobCookie, Origin: `http://127.0.0.1:${ctx.port}` },
  });
  t.after(() => { ownerWs.close(); bobWs.close(); });
  await new Promise((resolve, reject) => {
    ownerWs.once('open', resolve);
    ownerWs.once('error', reject);
  });
  await new Promise((resolve, reject) => {
    bobWs.once('open', resolve);
    bobWs.once('error', reject);
  });
  const joined = new Promise((resolve) => {
    ownerWs.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'joined' && event.room === 'trading') resolve(event);
    });
  });
  ownerWs.send(JSON.stringify({ type: 'join', room: 'trading' }));
  assert.equal((await joined).room, 'trading');
  const forbidden = new Promise((resolve) => {
    bobWs.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'error') resolve(event);
    });
  });
  bobWs.send(JSON.stringify({ type: 'join', room: 'trading' }));
  assert.equal((await forbidden).error, 'forbidden');
  let leaked = false;
  bobWs.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'trading_alert') leaked = true;
  });
  const live = new Promise((resolve) => {
    ownerWs.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'trading_alert' && event.alert.summary.includes('livekort')) resolve(event);
    });
  });
  const liveBody = alertAt(3, { summary: 'Ett livekort utan rådata.' });
  const liveRes = await postAlert(ctx, liveBody);
  assert.equal(liveRes.status, 201);
  const event = await live;
  assert.equal(event.room, 'trading');
  assert.equal(event.alert.liquidity_usd, undefined);
  assert.equal(event.alert.score, 38);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(leaked, false);
});

test('push caps, exclude list, wording, schema, and rate limit', async (t) => {
  const clock = { t: Date.parse('2026-01-15T11:30:00.000Z') };
  const excludeFile = path.join(os.tmpdir(), `exclude-${process.pid}.json`);
  fs.writeFileSync(excludeFile, JSON.stringify({ mints: [mint(50)] }));
  t.after(() => fs.rmSync(excludeFile, { force: true }));
  const ctx = await start({
    tradingNow: () => clock.t,
    tradingExcludeFile: excludeFile,
    tradingRateLimit: { windowMs: 60_000, max: 30 },
  });
  t.after(() => ctx.close());
  const milad = request.agent(ctx.app);
  await register(milad, 'milad');

  const excluded = await postAlert(ctx, alertAt(50, { summary: 'Denna mint ska aldrig synas.' }));
  assert.equal(excluded.status, 200);
  assert.equal(excluded.body.ignored, 'excluded');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM trading_alerts').get().n, 0);

  const wording = await postAlert(ctx, alertAt(4, { summary: 'You should buy this token.' }));
  assert.equal(wording.status, 400);
  assert.equal(wording.error ? wording.body.error : wording.body.error, 'wording');
  const swedish = await postAlert(ctx, alertAt(5, { name: 'sälj nu' }));
  assert.equal(swedish.status, 400);
  assert.equal(swedish.body.error, 'wording');
  const symbol = await postAlert(ctx, alertAt(6, { symbol: 'köp' }));
  assert.equal(symbol.status, 400);
  const hiddenName = await postAlert(ctx, alertAt(7, {
    name: '[dolt: namnet innehåller en handelsuppmaning]',
    summary: 'Namnet är redan dolt av bevakaren.',
  }));
  assert.equal(hiddenName.status, 201);
  const disclaimer = await postAlert(ctx, alertAt(8, { disclaimer: 'buy this now' }));
  assert.equal(disclaimer.status, 400);
  assert.equal(disclaimer.body.error, 'wording');

  const fast = await postAlert(ctx, alertAt(9, { stage: 'snabb', source: 'pumpportal-ny', summary: 'Snabbsteget ska stoppas.' }));
  assert.equal(fast.status, 200);
  assert.equal(fast.body.ignored, 'stage');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM trading_alerts WHERE summary LIKE '%Snabbsteget%'").get().n, 0);

  const badLink = await postAlert(ctx, alertAt(10, { link: 'https://example.com/solana/' + mint(10) }));
  assert.equal(badLink.status, 400);
  assert.equal(badLink.body.error, 'link');
  const extra = alertAt(11);
  extra.checks = { likviditet: 1 };
  const invalid = await postAlert(ctx, extra);
  assert.equal(invalid.status, 400);

  const first = alertAt(12, { summary: 'Första kortet för samma mint.', mint: mint(12) });
  const again = await postAlert(ctx, first);
  assert.equal(again.status, 201);
  const dupe = await postAlert(ctx, first);
  assert.equal(dupe.status, 200);
  assert.equal(dupe.body.deduped, true);
  const second = alertAt(13, {
    mint: mint(12),
    tsMs: first.id.split(':').pop() * 1 + 5000,
    summary: 'Ersatt uppföljning för samma mint.',
  });
  const replaced = await postAlert(ctx, second);
  assert.equal(replaced.status, 201);
  const cards = await milad.get('/team/trading');
  assert.match(cards.text, /Ersatt uppföljning för samma mint/);
  assert.equal((cards.text.match(new RegExp(`data-mint="${mint(12)}"`, 'g')) || []).length, 1);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM trading_alerts WHERE mint = ? AND superseded = 1').get(mint(12)).n, 1);

  const high = await postAlert(ctx, alertAt(14, { label: 'HÖG', score: 80, liquidity_usd: 90000, summary: 'Hög ska inte notifieras.' }));
  assert.equal(high.status, 201);
  const thin = await postAlert(ctx, alertAt(15, { liquidity_usd: 9999, summary: 'För låg likviditet för notis.' }));
  assert.equal(thin.status, 201);
  const exact = await postAlert(ctx, alertAt(16, { label: 'LÅG', score: 10, liquidity_usd: 10000, summary: 'Exakt likviditetsgräns.' }));
  assert.equal(exact.status, 201);
  const migration = await postAlert(ctx, alertAt(17, {
    stage: 'snabb',
    source: 'pumpportal-migrering',
    liquidity_usd: 50000,
    summary: 'Migrering i snabbsteget utan notis.',
  }));
  assert.equal(migration.status, 201);
  const notices = ctx.db.prepare("SELECT kind FROM trading_notifications").all().map((row) => row.kind);
  assert.equal(notices.filter((kind) => kind === 'push').length >= 1, true);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM trading_notifications WHERE mint = ?").get(mint(14)).n, 0);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM trading_notifications WHERE mint = ?").get(mint(15)).n, 0);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM trading_notifications WHERE mint = ?").get(mint(17)).n, 0);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM trading_notifications WHERE mint = ?").get(mint(16)).n, 1);

  const sameMint = mint(60);
  await postAlert(ctx, alertAt(60, { mint: sameMint, summary: 'Notis ett för minten.' }));
  clock.t += 60 * 60 * 1000;
  await postAlert(ctx, alertAt(61, { mint: sameMint, summary: 'Notis två ska tystna.' }));
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM trading_notifications WHERE mint = ?').get(sameMint).n, 1);
  clock.t += 6 * 60 * 60 * 1000;
  await postAlert(ctx, alertAt(62, { mint: sameMint, summary: 'Notis tre efter sex timmar.' }));
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM trading_notifications WHERE mint = ?').get(sameMint).n, 2);

  clock.t += 60 * 60 * 1000;
  for (let n = 70; n < 75; n += 1) {
    const res = await postAlert(ctx, alertAt(n, { summary: `Fönsternotis ${n}.` }));
    assert.equal(res.status, 201);
  }
  const overflow = await postAlert(ctx, alertAt(75, { summary: 'Överskott ett.' }));
  assert.equal(overflow.status, 201);
  const overflowTwo = await postAlert(ctx, alertAt(76, { summary: 'Överskott två.' }));
  assert.equal(overflowTwo.status, 201);
  const digestPage = await milad.get('/team/trading');
  assert.match(digestPage.text, /2 nya signaler i #trading/);
  assert.match(digestPage.text, new RegExp(SHORT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM trading_notifications WHERE kind = 'overflow'").get().n, 2);
});

test('quiet hours and a disconnected watcher suppress sound and notices', async (t) => {
  const quietClock = { t: Date.parse('2026-01-15T02:30:00.000Z') };
  const quiet = await start({ tradingNow: () => quietClock.t, tradingQuietHours: '0-7' });
  t.after(() => quiet.close());
  const res = await postAlert(quiet, alertAt(80, { summary: 'Tyst timme bara badge.' }));
  assert.equal(res.status, 201);
  const row = quiet.db.prepare('SELECT kind, sound FROM trading_notifications').get();
  assert.equal(row.kind, 'quiet');
  assert.equal(row.sound, 0);
  const milad = request.agent(quiet.app);
  await register(milad, 'milad');
  const page = await milad.get('/team/trading');
  assert.match(page.text, /data-sound="0"/);
  assert.match(page.text, /is-quiet/);
  assert.match(page.text, /Tyst timme bara badge/);
  assert.match(page.text, new RegExp(SHORT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const silent = await start({
    tradingWatcherUrl: 'http://127.0.0.1:9',
    tradingReconnect: { baseDelayMs: 60_000, maxDelayMs: 60_000, statsIntervalMs: 600_000 },
    tradingNow: () => Date.parse('2026-01-15T11:30:00.000Z'),
  });
  t.after(() => silent.close());
  silent.app.locals.teamService.trading.noteStats({ pumpportal_connected: false });
  const held = await postAlert(silent, alertAt(81, { summary: 'Ingen notis när bevakaren är nere.' }));
  assert.equal(held.status, 201);
  assert.equal(silent.db.prepare('SELECT COUNT(*) AS n FROM trading_notifications').get().n, 0);
  const owner = request.agent(silent.app);
  await register(owner, 'milad');
  const status = await owner.get('/team/trading');
  assert.match(status.text, /Bevakaren är inte ansluten/);
  assert.match(status.text, /Ingen notis när bevakaren är nere/);
});

test('endpoint auth, feature off, and the shared card cap', async (t) => {
  const off = await start({ tradingAlertsToken: '', tradingWatcherUrl: '' });
  t.after(() => off.close());
  assert.equal(off.app.locals.tradingWatcher, null);
  const hidden = await request(off.app)
    .post('/api/team/trading-alerts')
    .set('Authorization', 'Bearer trading-test-token')
    .send(alertAt(1));
  assert.equal(hidden.status, 404);
  const owner = request.agent(off.app);
  await register(owner, 'milad');
  const room = await owner.get('/team/trading');
  assert.equal(room.status, 200);
  assert.match(room.text, /id="trading-channel-disclaimer"/);
  assert.doesNotMatch(room.text, /id="trading-watcher-status"/);
  assert.doesNotMatch(room.text, /Bevakaren är inte ansluten/);

  const auth = await start({ tradingRateLimit: { windowMs: 60_000, max: 30 } });
  t.after(() => auth.close());
  const noBearer = await request(auth.app).post('/api/team/trading-alerts').send(alertAt(1));
  assert.equal(noBearer.status, 403);
  const wrong = await request(auth.app)
    .post('/api/team/trading-alerts')
    .set('Authorization', 'Bearer wrong-token')
    .send(alertAt(1));
  assert.equal(wrong.status, 401);
  const short = await request(auth.app)
    .post('/api/team/trading-alerts')
    .set('Authorization', 'Bearer x')
    .send(alertAt(1));
  assert.equal(short.status, 401);
  const milad = request.agent(auth.app);
  await register(milad, 'milad');
  const page = await milad.get('/team/trading');
  const csrfOnly = await milad.post('/api/team/trading-alerts').set('x-csrf-token', csrfFrom(page.text)).send(alertAt(2));
  assert.equal(csrfOnly.status, 401);
  const ok = await postAlert(auth, alertAt(3, { summary: 'Autentiserat kort.' }));
  assert.equal(ok.status, 201);

  const capped = await start({ tradingRateLimit: { windowMs: 60_000, max: 10 } });
  t.after(() => capped.close());
  for (let n = 1; n <= 11; n += 1) {
    const res = await postAlert(capped, alertAt(n, { summary: `Kapacitet ${n}.` }));
    if (n <= 10) assert.equal(res.status, 201, `alert ${n}`);
    else assert.equal(res.status, 429);
  }
  assert.equal(capped.db.prepare('SELECT COUNT(*) AS n FROM trading_alerts').get().n, 10);
  const proxy = await request(capped.app).get('/api/team/stream');
  assert.equal(proxy.status, 404);
});

test('server reads the fake watcher stream and fills the gap after reconnect', async (t) => {
  const fake = await startFakeWatcher();
  t.after(() => fake.close());
  const ctx = await start({
    tradingWatcherUrl: `http://127.0.0.1:${fake.port}`,
    tradingReconnect: { baseDelayMs: 40, maxDelayMs: 200, statsIntervalMs: 600_000 },
    tradingNow: () => Date.parse('2026-01-15T11:30:00.000Z'),
  });
  t.after(() => ctx.close());
  await waitFor(() => fake.paths.includes('/api/team/stream') && fake.paths.includes('/api/stats'));
  const first = alertAt(90, { summary: 'Första kortet från strömmen.' });
  const second = alertAt(91, { summary: 'Andra kortet efter återanslutning.' });
  fake.push(first);
  await waitFor(() => ctx.db.prepare('SELECT id FROM trading_alerts WHERE external_id = ?').get(first.id));
  fake.endStream();
  fake.remember(second);
  await waitFor(() => ctx.db.prepare('SELECT id FROM trading_alerts WHERE external_id = ?').get(second.id));
  assert.ok(fake.paths.includes('/api/team/summaries'));
  assert.equal(fake.paths.includes('/api/alerts'), false);
  assert.equal(fake.paths.includes('/api/stream'), false);
  const milad = request.agent(ctx.app);
  await register(milad, 'milad');
  await waitFor(() => ctx.app.locals.watcherState.pumpportalConnected === true);
  const page = await milad.get('/team/trading');
  assert.equal(page.status, 200);
  assert.match(page.text, /Första kortet från strömmen/);
  assert.match(page.text, /Andra kortet efter återanslutning/);
  assert.match(page.text, /Risk score 38/);
  assert.match(page.text, /informational only, not financial advice/);
  assert.match(page.text, new RegExp(DISCLAIMER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(page.text, new RegExp(`127\\.0\\.0\\.1:${fake.port}`));
  assert.match(page.text, /rel="noopener noreferrer"/);
});
