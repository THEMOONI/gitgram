const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const request = require('supertest');
const { createApp } = require('../server');
const { seedDemo } = require('../lib/tifi/seed.ts');
const { createFakeModel, createOpenAiModel, IDENTITY_RULE } = require('../lib/tifi/model.ts');
const { HARD } = require('../lib/paper/risk');
const {
  DisclosureLedger,
  DECISION_REMINDER,
  deliverDisclosedReply,
  commitDisclosure,
  disclosureSentence,
  enforceTruthfulIdentity,
  presentSessionBoard,
} = require('../lib/tifi/disclosure.ts');

const REMINDER = 'AI-beslut · Demo med låtsaspengar · Ingen finansiell rådgivning';

function openDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tifi-ai-'));
  const app = createApp({
    dbPath: path.join(dir, 'gitgram.db'),
    dataDir: path.join(dir, 'data'),
    sessionSecret: 'test-session-secret-value',
  });
  return {
    app,
    db: app.locals.db,
    close() {
      app.locals.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function limits(): { maxPositionPct: number; maxStopPct: number } {
  return { maxPositionPct: 10, maxStopPct: 8 };
}

test('art. 50.1 disclosure is marked only after it is sent', async () => {
  const ledger = new DisclosureLedger();
  const writes: Array<{ type: string; text: string }> = [];
  const result = await deliverDisclosedReply({
    ledger,
    sessionId: 's1',
    agentKey: 'tiger:1',
    agentName: 'TIFI 1',
    write: async (chunk: { type: string; text: string }) => { writes.push(chunk); },
    model: async () => 'Avvaktar i pappersläget.',
  });
  assert.equal(writes[0].type, 'disclosure');
  assert.equal(writes[0].text, disclosureSentence('TIFI 1'));
  assert.match(result.text, /Hej, jag är TIFI 1, en AI-agent som agerar för Scavvers Labs räkning\./);
  assert.match(result.text, /Avvaktar i pappersläget/);
  assert.equal(ledger.has('s1', 'tiger:1'), true);
  assert.equal(result.disclosed, true);
  assert.equal(result.partial, false);

  const again = await deliverDisclosedReply({
    ledger,
    sessionId: 's1',
    agentKey: 'tiger:1',
    agentName: 'TIFI 1',
    write: async (chunk: { type: string; text: string }) => { writes.push(chunk); },
    model: async () => 'Andra beslutet.',
  });
  assert.equal(again.text.includes('Hej, jag är'), false);
  assert.equal(writes.filter((chunk) => chunk.type === 'disclosure').length, 1);
});

test('cancel before the disclosure is sent does not mark the tiger', async () => {
  const ledger = new DisclosureLedger();
  await assert.rejects(() => deliverDisclosedReply({
    ledger,
    sessionId: 's',
    agentKey: 'tiger:2',
    agentName: 'TIFI 2',
    signal: { aborted: true },
    write: async () => { throw new Error('should not write'); },
    model: async () => 'x',
  }), (err: any) => err.code === 'CANCELLED' && err.disclosed !== true);
  assert.equal(ledger.has('s', 'tiger:2'), false);
});

test('interrupt before the disclosure is sent does not mark the tiger', async () => {
  const ledger = new DisclosureLedger();
  await assert.rejects(() => deliverDisclosedReply({
    ledger,
    sessionId: 's',
    agentKey: 'tiger:3',
    agentName: 'TIFI 3',
    interruptBeforeSend: true,
    write: async () => { throw new Error('should not write'); },
    model: async () => 'x',
  }), (err: any) => err.code === 'INTERRUPTED');
  assert.equal(ledger.has('s', 'tiger:3'), false);
});

test('a broken stream before the disclosure is sent does not mark the tiger', async () => {
  const ledger = new DisclosureLedger();
  await assert.rejects(() => deliverDisclosedReply({
    ledger,
    sessionId: 's',
    agentKey: 'tiger:1',
    agentName: 'TIFI 1',
    write: async () => { throw new Error('socket hang up'); },
    model: async () => 'x',
  }), (err: any) => err.code === 'STREAM_BROKEN');
  assert.equal(ledger.has('s', 'tiger:1'), false);
});

test('a model error after the disclosure was sent stays disclosed', async () => {
  const ledger = new DisclosureLedger();
  const result = await deliverDisclosedReply({
    ledger,
    sessionId: 's',
    agentKey: 'tiger:1',
    agentName: 'TIFI 1',
    write: async () => undefined,
    model: async () => { throw new Error('model down'); },
  });
  assert.equal(result.partial, true);
  assert.equal(result.disclosed, true);
  assert.match(result.text, /Hej, jag är TIFI 1/);
  assert.equal(ledger.has('s', 'tiger:1'), true);
});

test('closing the response without finish does not mark, and a failed status does not either', () => {
  const ledger = new DisclosureLedger();
  const closed = new EventEmitter();
  (closed as any).statusCode = 200;
  commitDisclosure(closed as any, ledger, 'sess', ['tiger:1']);
  closed.emit('close');
  assert.equal(ledger.has('sess', 'tiger:1'), false);
  closed.emit('finish');
  assert.equal(ledger.has('sess', 'tiger:1'), true);

  const failed = new EventEmitter();
  (failed as any).statusCode = 500;
  commitDisclosure(failed as any, ledger, 'sess', ['tiger:2']);
  failed.emit('finish');
  assert.equal(ledger.has('sess', 'tiger:2'), false);
});

test('the first board of a session discloses each tiger once', () => {
  const ledger = new DisclosureLedger();
  const board = {
    tigers: [
      { id: 1, name: 'TIFI 1', decision: { rationale: 'Inget beslut ännu.' } },
      { id: 2, name: 'TIFI 2', decision: { rationale: 'Inget beslut ännu.' } },
      { id: 3, name: 'TIFI 3', decision: { rationale: 'Inget beslut ännu.' } },
    ],
    feed: [
      { tigerId: 1, tiger: 'TIFI 1', rationale: 'Första.' },
      { tigerId: 1, tiger: 'TIFI 1', rationale: 'Äldre.' },
    ],
  };
  const pending = presentSessionBoard(board, ledger, 'sess');
  assert.deepEqual(pending, ['tiger:1', 'tiger:2', 'tiger:3']);
  assert.match(board.tigers[0].decision.rationale, /^Hej, jag är TIFI 1/);
  assert.match(board.feed[0].rationale, /^Hej, jag är TIFI 1/);
  assert.equal(board.feed[1].rationale, 'Äldre.');
  for (const key of pending) ledger.mark('sess', key);
  const second = {
    tigers: [{ id: 1, name: 'TIFI 1', decision: { rationale: 'Inget beslut ännu.' } }],
    feed: [] as Array<{ tigerId: number; tiger: string; rationale: string }>,
  };
  assert.deepEqual(presentSessionBoard(second, ledger, 'sess'), []);
  assert.equal(second.tigers[0].decision.rationale, 'Inget beslut ännu.');
});

test('asked if human, the model answers that it is an AI', async () => {
  const lie = enforceTruthfulIdentity('är du en människa?', 'Jag är en människa.', 'TIFI 2');
  assert.match(lie, /Nej\. Jag är TIFI 2, en AI-agent som agerar för Scavvers Labs räkning\./);
  assert.match(lie, /Jag är inte en människa/);
  assert.equal(lie.includes('Jag är en människa.'), false);

  const english = enforceTruthfulIdentity('are you human?', 'I am a human.', 'TIFI 3');
  assert.match(english, /TIFI 3/);
  assert.equal(/I am a human/i.test(english), false);

  const local = createFakeModel();
  const asked = await local.propose({
    action: 'hold', symbol: 'BTC', strength: 0, stopPct: 5, note: 'är du en människa?', agentName: 'TIFI 1',
  }, limits());
  assert.match(asked.rationale, /TIFI 1/);
  assert.match(asked.rationale, /AI-agent som agerar för Scavvers Labs räkning/);
  assert.match(asked.rationale, /inte en människa/);

  const quiet = await local.propose({
    action: 'hold', symbol: 'BTC', strength: 0, stopPct: 5, note: 'ingen signal',
  }, limits());
  assert.equal(quiet.rationale.startsWith('Nej.'), false);
  assert.match(quiet.rationale, /Lokal modell/);

  let system = '';
  const network = createOpenAiModel({
    apiKey: 'test-key',
    fetchImpl: (async (_url: string, opts: { body: string }) => {
      system = JSON.parse(opts.body).messages[0].content;
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: '{"action":"hold","leverage":1,"rationale":"I am a human."}' } }],
            usage: { total_tokens: 12 },
          };
        },
      };
    }) as any,
  });
  const proposal = await network.propose({
    action: 'hold', symbol: 'ETH', strength: 0.2, stopPct: 5, note: 'are you human?', agentName: 'TIFI 2',
  }, limits());
  assert.match(system, /are you human/);
  assert.match(system, new RegExp(IDENTITY_RULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(proposal.rationale, /TIFI 2/);
  assert.match(proposal.rationale, /inte en människa/);
  assert.equal(/I am a human/i.test(proposal.rationale), false);
  assert.equal(proposal.leverage, 1);
});

test('dashboard and tiger page show the disclosure and the visible reminder', async () => {
  assert.equal(DECISION_REMINDER, REMINDER);
  assert.equal(HARD.maxPositionPct, 10);
  const ctx = openDb();
  try {
    await seedDemo(ctx.db, {
      username: 'tifi',
      password: 'tifi-demo',
      ownerPassword: 'tigerpapper-2026',
      steps: 0,
    });
    const agent = request.agent(ctx.app);
    const loginPage = await agent.get('/login').expect(200);
    const csrf = loginPage.text.match(/name="_csrf" value="([a-f0-9]+)"/);
    assert.ok(csrf);
    await agent.post('/login').type('form').send({
      username: 'tifi', password: 'tifi-demo', _csrf: csrf[1],
    }).expect(302);

    const bots = await agent.get('/bots');
    assert.equal(bots.status, 302);
    assert.equal(bots.headers.location, '/tifi');

    const page = await agent.get('/tifi').expect(200);
    for (const name of ['TIFI 1', 'TIFI 2', 'TIFI 3']) {
      assert.match(page.text, new RegExp('Hej, jag är ' + name + ', en AI-agent som agerar för Scavvers Labs räkning\\.'));
    }
    assert.match(page.text, /id="tifi-session-ai">AI-beslut · Demo med låtsaspengar · Ingen finansiell rådgivning</);
    const cards = page.text.match(/<p class="tifi-ai-reminder">AI-beslut · Demo med låtsaspengar · Ingen finansiell rådgivning<\/p>/g) || [];
    assert.equal(cards.length, 3);
    assert.equal(page.text.includes('title="AI-beslut · Demo med låtsaspengar · Ingen finansiell rådgivning"'), false);

    const again = await agent.get('/tifi').expect(200);
    assert.equal((again.text.match(/Hej, jag är TIFI 1/g) || []).length, 0);
    assert.match(again.text, /id="tifi-session-ai">AI-beslut · Demo med låtsaspengar · Ingen finansiell rådgivning</);
    assert.equal((again.text.match(/<p class="tifi-ai-reminder">AI-beslut · Demo med låtsaspengar · Ingen finansiell rådgivning<\/p>/g) || []).length, 3);

    const tigers = await agent.get('/tifi/tigers').expect(200);
    assert.match(tigers.text, /id="tifi-session-ai">AI-beslut · Demo med låtsaspengar · Ingen finansiell rådgivning</);

    const fresh = request.agent(ctx.app);
    const loginAgain = await fresh.get('/login').expect(200);
    const token = loginAgain.text.match(/name="_csrf" value="([a-f0-9]+)"/);
    assert.ok(token);
    await fresh.post('/login').type('form').send({
      username: 'tifi', password: 'tifi-demo', _csrf: token[1],
    }).expect(302);
    const state = await fresh.get('/tifi/api/state').expect(200);
    const first = state.body.board.tigers.find((tiger: { name: string }) => tiger.name === 'TIFI 1');
    assert.match(first.decision.rationale, /Hej, jag är TIFI 1, en AI-agent som agerar för Scavvers Labs räkning/);
    assert.equal(state.body.aiReminder, REMINDER);
    const repeat = await fresh.get('/tifi/api/state').expect(200);
    const firstAgain = repeat.body.board.tigers.find((tiger: { name: string }) => tiger.name === 'TIFI 1');
    assert.equal(/Hej, jag är TIFI 1/.test(firstAgain.decision.rationale), false);
  } finally {
    ctx.close();
  }
});
