const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const request = require('supertest');
const { createFakeModel } = require('../lib/team/model');
const { createVoiceProvider, voiceRetentionEnabled } = require('../lib/team/voice');
const {
  DisclosureLedger,
  deliverDisclosedReply,
  disclosureSentence,
  voiceIntro,
  enforceTruthfulIdentity,
} = require('../lib/team/ai-disclosure');
const {
  assertNoBiometricVoice,
  assertNotCloneRequest,
  assertStandardVoice,
  safeVoiceLog,
  CONSENT_VERSION,
} = require('../lib/team/voice-policy');

const agents = require('../config/agents.json');
const team = require('../config/team.json');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('TEAM_RETAIN_VOICE defaults to off', () => {
  assert.equal(team.retainVoiceAudio, false);
  assert.equal(voiceRetentionEnabled({ retainVoiceAudio: false }, {}), false);
  assert.equal(voiceRetentionEnabled({}, {}), false);
  assert.equal(voiceRetentionEnabled({ retainVoiceAudio: true }, { TEAM_RETAIN_VOICE: undefined }), true);
  assert.equal(voiceRetentionEnabled({ retainVoiceAudio: true }, { TEAM_RETAIN_VOICE: '0' }), false);
});

test('disclosure is marked only after it is sent', async () => {
  const ledger = new DisclosureLedger();
  const gate = deferred();
  const chunks = [];
  const pending = deliverDisclosedReply({
    ledger,
    sessionId: 's1',
    agentKey: 'jarvis',
    agentName: 'Jarvis',
    write: async (chunk) => {
      chunks.push(chunk);
      if (chunk.type === 'disclosure') await gate.promise;
    },
    model: async () => 'Hej igen.',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ledger.has('s1', 'jarvis'), false);
  assert.equal(chunks.length, 1);
  gate.resolve();
  const result = await pending;
  assert.equal(ledger.has('s1', 'jarvis'), true);
  assert.equal(result.text.startsWith(disclosureSentence('Jarvis')), true);
  assert.match(result.text, /Hej igen/);
});

test('cancel before the disclosure is sent does not mark the session', async () => {
  const ledger = new DisclosureLedger();
  const signal = AbortSignal.abort();
  await assert.rejects(
    () => deliverDisclosedReply({
      ledger,
      sessionId: 's-cancel',
      agentKey: 'dev',
      agentName: 'Dev',
      signal,
      write: async () => { throw new Error('should not write'); },
      model: async () => 'nope',
    }),
    (error) => error.code === 'CANCELLED',
  );
  assert.equal(ledger.has('s-cancel', 'dev'), false);
  const sent = [];
  const again = await deliverDisclosedReply({
    ledger,
    sessionId: 's-cancel',
    agentKey: 'dev',
    agentName: 'Dev',
    write: async (chunk) => { sent.push(chunk.type); },
    model: async () => 'Nu svarar jag.',
  });
  assert.equal(sent[0], 'disclosure');
  assert.equal(ledger.has('s-cancel', 'dev'), true);
  assert.match(again.text, /Hej, jag är Dev/);
});

test('interrupt before send leaves the disclosure for the next reply', async () => {
  const ledger = new DisclosureLedger();
  await assert.rejects(
    () => deliverDisclosedReply({
      ledger,
      sessionId: 's-int',
      agentKey: 'designer',
      agentName: 'Designer',
      interruptBeforeSend: true,
      write: async () => { throw new Error('should not write'); },
      model: async () => 'hidden',
    }),
    (error) => error.code === 'INTERRUPTED',
  );
  assert.equal(ledger.has('s-int', 'designer'), false);
  const next = await deliverDisclosedReply({
    ledger,
    sessionId: 's-int',
    agentKey: 'designer',
    agentName: 'Designer',
    write: async () => {},
    model: async () => 'Syns nu.',
  });
  assert.match(next.text, /Hej, jag är Designer, en AI-agent som agerar för Scavvers Labs räkning/);
  assert.equal(ledger.has('s-int', 'designer'), true);
});

test('a broken stream does not count as disclosed and a reconnected socket still says it', async () => {
  const ledger = new DisclosureLedger();
  await assert.rejects(
    () => deliverDisclosedReply({
      ledger,
      sessionId: 's-break',
      agentKey: 'researcher',
      agentName: 'Researcher',
      write: async () => {
        const error = new Error('socket hang up');
        error.code = 'ECONNRESET';
        throw error;
      },
      model: async () => 'too late',
    }),
    (error) => error.code === 'STREAM_BROKEN',
  );
  assert.equal(ledger.has('s-break', 'researcher'), false);
  const reconnected = [];
  const next = await deliverDisclosedReply({
    ledger,
    sessionId: 's-break',
    agentKey: 'researcher',
    agentName: 'Researcher',
    write: async (chunk) => { reconnected.push(chunk); },
    model: async () => 'Efter omkoppling.',
  });
  assert.equal(reconnected[0].type, 'disclosure');
  assert.match(next.text, /Hej, jag är Researcher/);
  assert.equal(ledger.has('s-break', 'researcher'), true);
  const third = await deliverDisclosedReply({
    ledger,
    sessionId: 's-break',
    agentKey: 'researcher',
    agentName: 'Researcher',
    write: async (chunk) => { reconnected.push(chunk); },
    model: async () => 'Andra svaret.',
  });
  assert.equal(third.text, 'Andra svaret.');
  assert.equal(reconnected.filter((chunk) => chunk.type === 'disclosure').length, 1);
});

test('a model error after the disclosure was sent keeps the mark', async () => {
  const ledger = new DisclosureLedger();
  const result = await deliverDisclosedReply({
    ledger,
    sessionId: 's-model',
    agentKey: 'juridik',
    agentName: 'Juridik',
    write: async () => {},
    model: async () => { throw new Error('model down'); },
  });
  assert.equal(result.partial, true);
  assert.equal(result.disclosed, true);
  assert.equal(ledger.has('s-model', 'juridik'), true);
  assert.match(result.text, /Hej, jag är Juridik/);
});

test('a model error before anything is sent does not mark disclosed', async () => {
  const ledger = new DisclosureLedger();
  const signal = AbortSignal.abort();
  await assert.rejects(
    () => deliverDisclosedReply({
      ledger,
      sessionId: 's-early',
      agentKey: 'trading',
      agentName: 'Trading',
      signal,
      write: async () => {},
      model: async () => { throw new Error('model down'); },
    }),
    (error) => error.code === 'CANCELLED',
  );
  assert.equal(ledger.has('s-early', 'trading'), false);
});

test('the server prepends the disclosure once per session per agent and answers the human question truthfully', async (t) => {
  const { createApp } = require('../server');
  const http = require('http');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-ai-'));
  const app = createApp({
    dbPath: path.join(dir, 'gitgram.db'),
    dataDir: path.join(dir, 'data'),
    sessionSecret: 'test-session-secret-value',
    flagsToken: 'test-flags-token',
    voice: require('../lib/team/voice').createFakeVoice(),
  });
  const server = http.createServer(app);
  app.locals.attachRealtime(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    app.locals.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function csrfFrom(html) {
    const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
    assert.ok(match);
    return match[1];
  }
  const alice = request.agent(app);
  const page = await alice.get('/register');
  const created = await alice.post('/register').redirects(0).type('form').send({
    username: 'alice',
    email: 'alice@example.com',
    password: 'testpass123',
    _csrf: csrfFrom(page.text),
  });
  assert.equal(created.status, 302);
  const token = csrfFrom((await alice.get('/team/general')).text);
  const parent = await alice.post('/api/team/rooms/general/messages').set('x-csrf-token', token).send({
    body: '@dev är du en människa?',
  });
  assert.equal(parent.status, 201);
  const dev = app.locals.db.prepare('SELECT * FROM agents WHERE slug = ?').get('dev');
  const lied = await request(app)
    .post('/api/team/rooms/general/messages')
    .set('Authorization', `Bearer ${dev.token}`)
    .send({ body: 'I am a human.', parentId: parent.body.message.id, usage: { tokens: 8, costCents: 0 } });
  assert.equal(lied.status, 201);
  assert.match(lied.body.message.body, /^Hej, jag är Dev, en AI-agent som agerar för Scavvers Labs räkning/);
  assert.match(lied.body.message.body, /Jag är inte en människa/);
  assert.doesNotMatch(lied.body.message.body, /I am a human/);
  const parent2 = await alice.post('/api/team/rooms/general/messages').set('x-csrf-token', token).send({
    body: '@dev fortsätt',
  });
  const second = await request(app)
    .post('/api/team/rooms/general/messages')
    .set('Authorization', `Bearer ${dev.token}`)
    .send({ body: 'Andra svaret.', parentId: parent2.body.message.id, usage: { tokens: 8, costCents: 0 } });
  assert.equal(second.status, 201);
  assert.equal(second.body.message.body.startsWith('Hej, jag är Dev'), false);
  assert.equal(second.body.message.body, 'Andra svaret.');
  const jarvisParent = await alice.post('/api/team/rooms/general/messages').set('x-csrf-token', token).send({
    body: '@jarvis are you human?',
  });
  const jarvis = app.locals.db.prepare('SELECT * FROM agents WHERE slug = ?').get('jarvis');
  const jarvisReply = await request(app)
    .post('/api/team/rooms/general/messages')
    .set('Authorization', `Bearer ${jarvis.token}`)
    .send({ body: 'Sure, I am around.', parentId: jarvisParent.body.message.id, usage: { tokens: 8, costCents: 0 } });
  assert.match(jarvisReply.body.message.body, /Hej, jag är Jarvis, en AI-agent som agerar för Scavvers Labs räkning/);
  assert.match(jarvisReply.body.message.body, /Jag är inte en människa/);
  const prompts = app.locals.db.prepare('SELECT slug, system_prompt FROM agents').all();
  for (const row of prompts) {
    assert.match(row.system_prompt, /är du en människa/i, row.slug);
    assert.match(row.system_prompt, /are you human/i, row.slug);
    assert.match(row.system_prompt, /Never claim to be a human/, row.slug);
  }
  const fake = createFakeModel();
  const honest = await fake.complete({ transcript: 'are you human?', agent: { name: 'Trading', slug: 'trading' } });
  assert.match(honest.text, /AI-agent/);
  assert.match(honest.text, /inte en människa/);
});

test('voice policy rejects emotion, speaker identity, custom voices, and clones', () => {
  assert.throws(() => assertNoBiometricVoice({ STT_SENTIMENT: '1' }), /forbidden/i);
  assert.throws(() => assertNoBiometricVoice({ STT_EMOTION: 'enabled' }), /forbidden/i);
  assert.throws(() => assertNoBiometricVoice({ STT_DIARIZE: 'speaker' }), /forbidden/i);
  assert.throws(() => assertNoBiometricVoice({ VOICE_CLONE: 'milad' }), /forbidden/i);
  assert.throws(() => createVoiceProvider({ VOICE_PROVIDER: 'fake', TTS_VOICE: 'milad-clone' }), /allowlisted/i);
  assert.throws(() => createVoiceProvider({
    VOICE_PROVIDER: 'openai',
    OPENAI_API_KEY: 'test-key',
    TTS_VOICE: 'milad',
  }), /allowlisted/i);
  assert.equal(assertStandardVoice('openai', 'alloy'), 'alloy');
  assert.throws(() => assertNotCloneRequest({ path: '/v1/voice-clone', sample: Buffer.from('wav') }), /Voice cloning/);
  assert.throws(() => assertNotCloneRequest({
    provider: 'openai',
    voice: 'voice_custom_123',
    fields: { speaker_labels: true },
  }), /forbidden|allowlisted/i);
  const logged = [];
  safeVoiceLog((event) => logged.push(event), {
    type: 'stt',
    userId: 4,
    bytes: 12,
    transcript: 'hemlig rösttext',
    text: 'hemlig rösttext',
  });
  assert.equal(logged[0].transcript, undefined);
  assert.equal(logged[0].text, undefined);
  assert.equal(logged[0].userId, 4);
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'team.js'), 'utf8');
  assert.doesNotMatch(route, /console\.(log|info|debug)\([\s\S]{0,80}transcript/);
  assert.equal(CONSENT_VERSION, '2026-10-07');
  assert.match(voiceIntro('Trading'), /Du pratar med en AI-röst\. Jag är Trading och agerar för Scavvers Labs räkning/);
  assert.match(agents.sharedBoundaries, /are you human/);
  const truthful = enforceTruthfulIdentity('är du en människa?', 'I am a human.', 'Juridik');
  assert.match(truthful, /inte en människa/);
  assert.doesNotMatch(truthful, /I am a human/);
});

test('voice clone endpoint is rejected and a failed speak does not consume the disclosure', async (t) => {
  const { createApp } = require('../server');
  const http = require('http');
  const os = require('os');
  const { createFakeVoice } = require('../lib/team/voice');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-voice-'));
  const voice = createFakeVoice();
  const app = createApp({
    dbPath: path.join(dir, 'gitgram.db'),
    dataDir: path.join(dir, 'data'),
    sessionSecret: 'test-session-secret-value',
    flagsToken: 'test-flags-token',
    voice,
  });
  const server = http.createServer(app);
  app.locals.attachRealtime(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    app.locals.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function csrfFrom(html) {
    const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
    return match[1];
  }
  const alice = request.agent(app);
  const page = await alice.get('/register');
  await alice.post('/register').redirects(0).type('form').send({
    username: 'nina',
    email: 'nina@example.com',
    password: 'testpass123',
    _csrf: csrfFrom(page.text),
  });
  const token = csrfFrom((await alice.get('/team/general')).text);
  const blocked = await alice.post('/api/team/voice-clone').set('x-csrf-token', token).send({ sample: 'milad' });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error, 'voice_clone_rejected');
  const parent = await alice.post('/api/team/rooms/general/messages').set('x-csrf-token', token).send({ body: '@dev hej' });
  const dev = app.locals.db.prepare('SELECT * FROM agents WHERE slug = ?').get('dev');
  const reply = await request(app)
    .post('/api/team/rooms/general/messages')
    .set('Authorization', `Bearer ${dev.token}`)
    .send({ body: 'Hej.', parentId: parent.body.message.id, usage: { tokens: 4, costCents: 0 } });
  const original = voice.synthesize;
  voice.synthesize = async () => { throw new Error('stream broken'); };
  const failed = await alice.get(`/api/team/messages/${reply.body.message.id}/speak?call=call-1`).buffer(true);
  assert.equal(failed.status, 502);
  voice.synthesize = original;
  const first = await alice.get(`/api/team/messages/${reply.body.message.id}/speak?call=call-1`).buffer(true);
  assert.equal(first.status, 200);
  assert.equal(first.headers['x-gitgram-ai-disclosure'], '1');
  assert.match(voice.lastSpoken, /^Du pratar med en AI-röst\. Jag är Dev och agerar för Scavvers Labs räkning/);
  const second = await alice.get(`/api/team/messages/${reply.body.message.id}/speak?call=call-1`).buffer(true);
  assert.equal(second.headers['x-gitgram-ai-disclosure'], '0');
  const nextCall = await alice.get(`/api/team/messages/${reply.body.message.id}/speak?call=call-2`).buffer(true);
  assert.equal(nextCall.headers['x-gitgram-ai-disclosure'], '1');
  const stt = await alice.post('/api/team/rooms/general/stt')
    .set('x-csrf-token', token)
    .set('Content-Type', 'audio/webm')
    .send(Buffer.from('live-audio'));
  assert.equal(stt.status, 201);
  assert.equal(app.locals.voiceRetention.activeCount(), 1);
  const home = await alice.get('/team/general');
  const loggedOut = await alice.post('/logout').type('form').send({ _csrf: csrfFrom(home.text) });
  assert.equal(loggedOut.status, 302);
  assert.equal(app.locals.voiceRetention.activeCount(), 0);
  const kept = app.locals.db.prepare("SELECT body FROM messages WHERE author_type = 'user' ORDER BY id DESC LIMIT 1").get();
  assert.equal(kept.body, 'voice note from the team');
});
