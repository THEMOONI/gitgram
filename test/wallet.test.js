const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const request = require('supertest');
const { createApp } = require('../server');
const { isReservedUsername } = require('../lib/validate');
const { parseAmountToMinor, formatMinor } = require('../lib/ledger');
const { classifyAmount, formatMinorUnits, applySendingState, dismissToast, SENDING_LABEL, TOAST_DISMISS_MS } = require('../public/js/wallet');

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  assert.ok(match, 'csrf token missing');
  return match[1];
}

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-wallet-'));
  const app = createApp({
    dbPath: path.join(dir, 'gitgram.db'),
    dataDir: path.join(dir, 'data'),
    sessionSecret: 'test-session-secret-value',
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    app,
    dir,
    async close() {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      app.locals.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function register(agent, username) {
  const page = await agent.get('/register');
  return agent.post('/register').redirects(0).type('form').send({
    username,
    email: username + '@example.com',
    password: 'testpass123',
    _csrf: csrfFrom(page.text),
  });
}

function report(db) {
  const accounts = db.prepare(`
    SELECT a.id, a.kind, a.user_id, a.code, a.balance_minor,
      COALESCE((SELECT SUM(amount_minor) FROM ledger_entries e WHERE e.account_id = a.id), 0) AS summed
    FROM ledger_accounts a
    ORDER BY a.id
  `).all();
  const transfers = db.prepare(`
    SELECT t.id, COUNT(e.id) AS n, COALESCE(SUM(e.amount_minor), 0) AS summed
    FROM ledger_transfers t
    LEFT JOIN ledger_entries e ON e.transfer_id = t.id
    GROUP BY t.id
    ORDER BY t.id
  `).all();
  const total = db.prepare('SELECT COALESCE(SUM(amount_minor), 0) AS total FROM ledger_entries').get().total;
  const entries = db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get().n;
  return { accounts, transfers, total, entries };
}

function assertInvariants(db) {
  const snapshot = report(db);
  assert.equal(snapshot.total, 0);
  for (const account of snapshot.accounts) {
    assert.equal(account.balance_minor, account.summed, account.code);
    if (account.kind === 'user') assert.ok(account.balance_minor >= 0, account.code);
  }
  for (const transfer of snapshot.transfers) {
    assert.equal(transfer.n, 2);
    assert.equal(transfer.summed, 0);
  }
  return snapshot;
}

function fingerprint(db) {
  const snapshot = report(db);
  return JSON.stringify({
    entries: snapshot.entries,
    transfers: snapshot.transfers.length,
    accounts: snapshot.accounts.map((account) => [account.code, account.balance_minor]),
  });
}

test('demo amounts are integer cents with a per-transfer maximum', () => {
  assert.equal(parseAmountToMinor('25').minor, 2500);
  assert.equal(parseAmountToMinor('25.5').minor, 2550);
  assert.equal(parseAmountToMinor('25.50').minor, 2550);
  assert.equal(parseAmountToMinor('0.01').minor, 1);
  assert.equal(parseAmountToMinor('500.00').minor, 50000);
  assert.equal(parseAmountToMinor(' 25.00 ').minor, 2500);
  assert.equal(parseAmountToMinor('0').code, 'zero');
  assert.equal(parseAmountToMinor('0.00').code, 'zero');
  assert.equal(parseAmountToMinor('-1').code, 'negative');
  assert.equal(parseAmountToMinor('-0.50').code, 'negative');
  assert.equal(parseAmountToMinor('1.001').code, 'non_integer_cents');
  assert.equal(parseAmountToMinor('10.999').code, 'non_integer_cents');
  assert.equal(parseAmountToMinor('500.01').code, 'too_large');
  assert.equal(parseAmountToMinor('1,250.00').code, 'too_large');
  assert.equal(parseAmountToMinor('abc').code, 'invalid_amount');
  assert.equal(parseAmountToMinor('1e2').code, 'invalid_amount');
  assert.equal(formatMinor(100000), '1,000.00');
  assert.equal(formatMinor(70), '0.70');
  assert.equal(formatMinorUnits(100000), '1,000.00');
  assert.equal(classifyAmount('1.001', 100000).code, 'non_integer_cents');
  assert.equal(classifyAmount('0', 100000).code, 'zero');
  assert.equal(classifyAmount('-2', 100000).code, 'negative');
  assert.equal(classifyAmount('500.01', 100000).code, 'too_large');
  assert.equal(classifyAmount('200.00', 10000).code, 'insufficient_funds');
  assert.equal(classifyAmount('25.00', 100000).minor, 2500);
  const button = { textContent: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  applySendingState(button);
  assert.equal(button.textContent, SENDING_LABEL);
  assert.equal(button.attrs['aria-busy'], 'true');
  assert.equal(TOAST_DISMISS_MS, 6000);
  const calls = [];
  dismissToast({ remove() { calls.push('removed'); } }, { setTimeout(fn, ms) { calls.push(ms); fn(); } });
  assert.deepEqual(calls, [6000, 'removed']);
});

test('wallet requires a signed-in user and a CSRF token', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const anon = request(ctx.app);
  const page = await anon.get('/wallet');
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, '/login');
  const api = await anon.get('/api/wallet');
  assert.equal(api.status, 401);
  assert.equal(api.body.demo, true);
  assert.match(api.body.disclaimer, /no real money/);
  assert.equal(api.body.error, 'login_required');

  const guest = request.agent(ctx.app);
  const login = await guest.get('/login');
  const denied = await guest.post('/wallet/transfer')
    .set('Accept', 'application/json')
    .type('json')
    .send({
      recipient: 'bob',
      amount: '1.00',
      memo: 'hi',
      idempotency_key: 'guestkey01',
      _csrf: csrfFrom(login.text),
    });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.demo, true);

  const alice = request.agent(ctx.app);
  assert.equal((await register(alice, 'alice')).status, 302);
  await alice.get('/wallet');
  const before = fingerprint(ctx.app.locals.db);
  const forged = await alice.post('/wallet/transfer').type('form').send({
    recipient: 'bob',
    amount: '1.00',
    memo: 'no token',
    idempotency_key: 'notoken01',
  });
  assert.equal(forged.status, 403);
  assert.equal(fingerprint(ctx.app.locals.db), before);
  assertInvariants(ctx.app.locals.db);
});

test('username wallet is reserved and /wallet does not collide with a profile', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  assert.equal(isReservedUsername('wallet'), true);
  assert.equal(isReservedUsername('Wallet'), true);
  assert.equal(isReservedUsername('gitgram-faucet'), true);
  assert.equal(isReservedUsername('alice'), false);

  const guest = request.agent(ctx.app);
  const registerPage = await guest.get('/register');
  const reserved = await guest.post('/register').type('form').send({
    username: 'wallet',
    email: 'wallet@example.com',
    password: 'testpass123',
    _csrf: csrfFrom(registerPage.text),
  });
  assert.equal(reserved.status, 200);
  assert.match(reserved.text, /reserved/);
  assert.equal(ctx.app.locals.db.prepare('SELECT id FROM users WHERE username = ?').get('wallet'), undefined);

  const faucetName = await guest.post('/register').type('form').send({
    username: 'gitgram-faucet',
    email: 'faucet@example.com',
    password: 'testpass123',
    _csrf: csrfFrom(registerPage.text),
  });
  assert.match(faucetName.text, /reserved/);

  const alice = request.agent(ctx.app);
  assert.equal((await register(alice, 'alice')).status, 302);
  const home = await alice.get('/');
  assert.match(home.text, /Demo Wallet/);
  assert.match(home.text, /href="\/wallet"/);
  const loggedOut = await request(ctx.app).get('/');
  assert.doesNotMatch(loggedOut.text, /Demo Wallet/);

  const wallet = await alice.get('/wallet');
  assert.equal(wallet.status, 200);
  assert.match(wallet.text, /Available balance/);
  assert.match(wallet.text, /DEMO MODE/);
  assert.doesNotMatch(wallet.text, /Page not found/);
  const profile = await alice.get('/@alice');
  assert.equal(profile.status, 200);
  assert.match(profile.text, /alice/);
  assert.doesNotMatch(profile.text, /Available balance/);
});

test('demo ledger grants once, transfers, and rejects bad requests without changing state', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const db = ctx.app.locals.db;
  const alice = request.agent(ctx.app);
  const bob = request.agent(ctx.app);
  const charlie = request.agent(ctx.app);
  assert.equal((await register(alice, 'alice')).status, 302);
  assert.equal((await register(bob, 'bob')).status, 302);
  assert.equal((await register(charlie, 'charlie')).status, 302);

  const first = await alice.get('/wallet');
  assert.equal(first.status, 200);
  const token = csrfFrom(first.text);
  assert.match(first.text, /DEMO MODE · simulated data · no real money/);
  assert.match(first.text, /1,000\.00/);
  assert.match(first.text, /GGT/);
  assert.match(first.text, /\(demo\)/);
  assert.match(first.text, /Welcome grant for demo wallet/);
  assert.match(first.text, /@gitgram-faucet/);
  assert.match(first.text, /for="recipient"/);
  assert.match(first.text, /id="recipient"/);
  assert.match(first.text, /aria-describedby="recipient-hint"/);
  assert.match(first.text, /for="amount"/);
  assert.match(first.text, /id="amount"/);
  assert.match(first.text, /aria-describedby="amount-hint"/);
  assert.match(first.text, /for="message"/);
  assert.match(first.text, /aria-describedby="message-hint"/);
  assert.match(first.text, /id="wallet-loading"/);
  assert.match(first.text, /class="w-skel"/);
  assert.match(first.text, /Request is coming soon/);
  assert.match(first.text, /\/js\/wallet\.js/);
  assert.doesNotMatch(first.text, /profit|investment|yield/i);

  const again = await alice.get('/wallet');
  assert.equal(again.status, 200);
  const aliceUser = db.prepare('SELECT id FROM users WHERE username = ?').get('alice');
  const aliceGrants = db.prepare(`
    SELECT COUNT(*) AS n FROM ledger_transfers WHERE kind = 'grant' AND actor_user_id = ?
  `).get(aliceUser.id);
  assert.equal(aliceGrants.n, 1);
  assertInvariants(db);

  const outgoing = await alice.get('/wallet?flow=out');
  assert.match(outgoing.text, /No outgoing demo transfers yet/);
  assert.doesNotMatch(outgoing.text, /Welcome grant for demo wallet/);

  const api = await alice.get('/api/wallet');
  assert.equal(api.status, 200);
  assert.equal(api.body.demo, true);
  assert.match(api.body.disclaimer, /DEMO MODE/);
  assert.match(api.body.disclaimer, /no real money/);
  assert.equal(api.body.balanceMinor, 100000);
  assert.match(api.body.balanceDisplay, /1,000\.00 GGT \(demo\)/);
  assert.equal(api.body.notConvertible, true);
  assert.equal(api.body.history[0].counterparty, 'gitgram-faucet');
  assert.equal(api.body.history[0].direction, 'in');
  assert.equal(api.body.history[0].memo, 'Welcome grant for demo wallet');
  assert.equal(api.body.history[0].amountMinor, 100000);
  assert.match(api.body.history[0].amountDisplay, /\(demo\)/);
  assert.doesNotMatch(JSON.stringify(api.body), /profit|investment|yield/i);

  const csv = await alice.get('/wallet/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /DEMO MODE · simulated data · no real money/);
  assert.match(csv.text, /gitgram-faucet/);
  assert.match(csv.text, /1000\.00/);
  assert.doesNotMatch(csv.text, /Page not found/);

  await bob.get('/wallet');
  const settled = fingerprint(db);
  let seq = 0;
  const key = () => {
    seq += 1;
    return 'casekey' + String(seq).padStart(4, '0');
  };
  async function rejectJson(fields, code, pattern) {
    const res = await alice.post('/wallet/transfer')
      .set('Accept', 'application/json')
      .type('json')
      .send({ memo: '', idempotency_key: key(), _csrf: token, ...fields });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.demo, true);
    assert.match(res.body.disclaimer, /no real money/);
    assert.equal(res.body.error, code);
    if (pattern) assert.match(res.body.message, pattern);
    assert.equal(fingerprint(db), settled);
  }

  await rejectJson({ recipient: 'bob', amount: '0' }, 'zero', /greater than 0\.00/);
  await rejectJson({ recipient: 'bob', amount: '0.00' }, 'zero', /greater than 0\.00/);
  await rejectJson({ recipient: 'bob', amount: '-2.50' }, 'negative', /Negative amounts/);
  await rejectJson({ recipient: 'bob', amount: '1.001' }, 'non_integer_cents', /two decimal places/);
  await rejectJson({ recipient: 'bob', amount: '500.01' }, 'too_large', /500\.00 GGT \(demo\)/);
  await rejectJson({ recipient: 'bob', amount: '1,250.00' }, 'too_large', /500\.00/);
  await rejectJson({ recipient: 'alice', amount: '1.00' }, 'self', /yourself/);
  await rejectJson({ recipient: '@ghost-user', amount: '1.00' }, 'unknown_recipient', /No Gitgram user named @ghost-user/);
  await rejectJson({ recipient: 'bob', amount: '1.00', memo: 'x'.repeat(141) }, 'memo_too_long', /140/);

  const missingKey = await alice.post('/wallet/transfer')
    .set('Accept', 'application/json')
    .type('json')
    .send({ recipient: 'bob', amount: '1.00', memo: '', _csrf: token });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.body.error, 'idempotency_key');
  assert.equal(fingerprint(db), settled);

  const htmlBad = await alice.post('/wallet/transfer').type('form').send({
    recipient: 'bob',
    amount: '1.001',
    memo: 'cents',
    idempotency_key: key(),
    _csrf: token,
  });
  assert.equal(htmlBad.status, 400);
  assert.match(htmlBad.text, /aria-invalid="true"/);
  assert.match(htmlBad.text, /is-error/);
  assert.match(htmlBad.text, /id="send-btn" disabled/);
  assert.match(htmlBad.text, /two decimal places/);
  assert.match(htmlBad.text, /DEMO MODE/);
  assert.equal(fingerprint(db), settled);

  const unknown = await alice.post('/wallet/transfer').type('form').send({
    recipient: 'ghost-user',
    amount: '2.00',
    memo: '',
    idempotency_key: key(),
    _csrf: token,
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.text, /No Gitgram user named @ghost-user/);
  assert.equal(fingerprint(db), settled);

  const tooBigForCharlie = await alice.post('/wallet/transfer')
    .set('Accept', 'application/json')
    .type('json')
    .send({
      recipient: 'charlie',
      amount: '500.01',
      memo: '',
      idempotency_key: key(),
      _csrf: token,
    });
  assert.equal(tooBigForCharlie.body.error, 'too_large');
  const charlieUser = db.prepare('SELECT id FROM users WHERE username = ?').get('charlie');
  assert.equal(db.prepare('SELECT id FROM ledger_accounts WHERE user_id = ?').get(charlieUser.id), undefined);

  const created = await alice.post('/wallet/transfer')
    .set('Accept', 'application/json')
    .type('json')
    .send({
      recipient: '@bob',
      amount: '25.00',
      memo: 'Thanks for the review',
      idempotency_key: 'transfer-25',
      _csrf: token,
    });
  assert.equal(created.status, 201);
  assert.equal(created.body.demo, true);
  assert.equal(created.body.status, 'created');
  assert.equal(created.body.balanceMinor, 97500);
  assert.match(created.body.amountDisplay, /25\.00 GGT \(demo\)/);
  assert.match(created.body.balanceDisplay, /975\.00 GGT \(demo\)/);
  assert.match(created.body.disclaimer, /no real money/);

  const replay = await alice.post('/wallet/transfer')
    .set('Accept', 'application/json')
    .type('json')
    .send({
      recipient: 'bob',
      amount: '25.00',
      memo: 'Thanks for the review',
      idempotency_key: 'transfer-25',
      _csrf: token,
    });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.status, 'replayed');
  assert.equal(replay.body.balanceMinor, 97500);
  assert.equal(replay.body.demo, true);
  const transferRows = db.prepare(`SELECT COUNT(*) AS n FROM ledger_transfers WHERE idempotency_key = 'transfer-25'`).get();
  assert.equal(transferRows.n, 1);

  const conflict = await alice.post('/wallet/transfer')
    .set('Accept', 'application/json')
    .type('json')
    .send({
      recipient: 'bob',
      amount: '10.00',
      memo: 'different',
      idempotency_key: 'transfer-25',
      _csrf: token,
    });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'idempotency_conflict');
  assert.equal(conflict.body.demo, true);
  assert.equal(db.prepare('SELECT balance_minor FROM ledger_accounts WHERE user_id = ?').get(aliceUser.id).balance_minor, 97500);

  const htmlSend = await alice.post('/wallet/transfer').redirects(0).type('form').send({
    recipient: 'bob',
    amount: '5.00',
    memo: '',
    idempotency_key: 'htmlkey01',
    _csrf: token,
  });
  assert.equal(htmlSend.status, 302);
  assert.match(htmlSend.headers.location, /^\/wallet#tx-/);
  const htmlReplay = await alice.post('/wallet/transfer').redirects(0).type('form').send({
    recipient: 'bob',
    amount: '5.00',
    memo: '',
    idempotency_key: 'htmlkey01',
    _csrf: token,
  });
  assert.equal(htmlReplay.status, 302);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ledger_transfers WHERE idempotency_key = 'htmlkey01'`).get().n, 1);

  const toasted = await alice.get('/wallet');
  assert.match(toasted.text, /Sent 5\.00 GGT \(demo\) to @bob/);
  assert.match(toasted.text, /role="status"/);
  assert.match(toasted.text, /new balance 970\.00 GGT \(demo\)/);
  assert.match(toasted.text, /Simulated transfer/);
  const quiet = await alice.get('/wallet');
  assert.doesNotMatch(quiet.text, /Sent 5\.00 GGT \(demo\)/);

  const sendMore = async (amount, idem) => {
    const res = await alice.post('/wallet/transfer')
      .set('Accept', 'application/json')
      .type('json')
      .send({ recipient: 'bob', amount, memo: '', idempotency_key: idem, _csrf: token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res;
  };
  await sendMore('500.00', 'send50000');
  await sendMore('400.00', 'send40000');
  const short = await alice.post('/wallet/transfer')
    .set('Accept', 'application/json')
    .type('json')
    .send({
      recipient: 'bob',
      amount: '200.00',
      memo: 'too much',
      idempotency_key: 'send20000',
      _csrf: token,
    });
  assert.equal(short.status, 400);
  assert.equal(short.body.error, 'insufficient_funds');
  assert.match(short.body.message, /exceeds your balance of 70\.00 GGT \(demo\)/);
  assert.equal(db.prepare('SELECT balance_minor FROM ledger_accounts WHERE user_id = ?').get(aliceUser.id).balance_minor, 7000);

  const bobUser = db.prepare('SELECT id FROM users WHERE username = ?').get('bob');
  assert.equal(db.prepare('SELECT balance_minor FROM ledger_accounts WHERE user_id = ?').get(bobUser.id).balance_minor, 193000);
  const faucet = db.prepare(`SELECT balance_minor, kind FROM ledger_accounts WHERE code = 'system:faucet'`).get();
  assert.equal(faucet.kind, 'system');
  assert.equal(faucet.balance_minor, -200000);
  const finalReport = assertInvariants(db);
  assert.equal(finalReport.entries, 12);
  assert.equal(finalReport.transfers.length, 6);

  const entry = db.prepare('SELECT id FROM ledger_entries LIMIT 1').get();
  assert.throws(() => db.prepare('UPDATE ledger_entries SET amount_minor = 1 WHERE id = ?').run(entry.id));
  assert.throws(() => db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(entry.id));
  const aliceAccount = db.prepare('SELECT id FROM ledger_accounts WHERE user_id = ?').get(aliceUser.id);
  const bobAccount = db.prepare('SELECT id FROM ledger_accounts WHERE user_id = ?').get(bobUser.id);
  assert.throws(() => {
    const trx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO ledger_transfers (
          idempotency_key, kind, from_account_id, to_account_id, amount_minor, memo, actor_user_id
        ) VALUES ('manualkey1', 'transfer', ?, ?, 1, 'manual', ?)
      `).run(aliceAccount.id, bobAccount.id, aliceUser.id);
      db.prepare('INSERT INTO ledger_entries (transfer_id, account_id, amount_minor) VALUES (?, ?, ?)')
        .run(Number(info.lastInsertRowid), aliceAccount.id, -100000000);
    });
    trx();
  });
  assert.equal(db.prepare('SELECT balance_minor FROM ledger_accounts WHERE id = ?').get(aliceAccount.id).balance_minor, 7000);
  assertInvariants(db);

  const cold = request.agent(ctx.app);
  assert.equal((await register(cold, 'colduser')).status, 302);
  const coldHome = await cold.get('/');
  const coldToken = csrfFrom(coldHome.text);
  const coldBad = await cold.post('/wallet/transfer').type('form').send({
    recipient: 'bob',
    amount: '0.00',
    memo: '',
    idempotency_key: 'coldkey01',
    _csrf: coldToken,
  });
  assert.equal(coldBad.status, 400);
  assert.match(coldBad.text, /Claim welcome grant/);
  assert.match(coldBad.text, /No demo transactions yet/);
  const coldUser = db.prepare('SELECT id FROM users WHERE username = ?').get('colduser');
  assert.equal(db.prepare('SELECT id FROM ledger_accounts WHERE user_id = ?').get(coldUser.id), undefined);
  assertInvariants(db);
});
