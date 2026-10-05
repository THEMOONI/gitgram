const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { test } = require('node:test');
const request = require('supertest');
const WebSocket = require('ws');
const { createApp } = require('../server');
const { createFakeModel } = require('../lib/team/model');
const { createFakeVoice, createUnavailableVoice, spokenText, voiceRetentionEnabled, markGeneratedAudio } = require('../lib/team/voice');
const { extractPdfText } = require('../lib/team/pdf');
const { planAgentReply, resumePlannedReply } = require('../lib/team/turn');
const { agentShouldRespond } = require('../lib/team/policy');
const { tokensEqual } = require('../lib/team/secret');
const { safeHttpUrl } = require('../lib/team/urls');
const {
  escapeHtml,
  renderMessageHtml,
  renderFlagHtml,
  voiceNotes,
  micSupported,
  pushToTalkBlocked,
  mentionQuery,
  visibleMentions,
} = require('../public/js/team');
const { buildReport } = require('../scripts/check-licenses');
const agentsConfig = require('../config/agents.json');
const legalConfig = require('../config/legal-areas.json');

const TRADING_LABEL = agentsConfig.agents.find((agent) => agent.slug === 'trading').disclaimer;
const JURIDIK_DISCLAIMER = agentsConfig.agents.find((agent) => agent.slug === 'juridik').disclaimer;
const LAWYER_BADGE = legalConfig.needsLawyerBadge;

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-team-'));
  const app = createApp({
    dbPath: path.join(dir, 'gitgram.db'),
    dataDir: path.join(dir, 'data'),
    sessionSecret: 'test-session-secret-value',
    flagsToken: options.flagsToken === undefined ? 'test-flags-token' : options.flagsToken,
    voice: options.voice || createFakeVoice(),
    retainVoiceAudio: options.retainVoiceAudio,
    maxHops: options.maxHops,
    messageRateLimit: options.messageRateLimit,
    flagRateLimit: options.flagRateLimit,
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
    base: `http://127.0.0.1:${port}`,
    db: app.locals.db,
    async close() {
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

function agentRow(db, slug) {
  return db.prepare('SELECT * FROM agents WHERE slug = ?').get(slug);
}

function flagBody(overrides = {}) {
  return {
    title: 'MiCA disclosure update',
    severity: 'hög',
    summary: 'A disclosure duty changed for the public site.',
    affectedProjects: ['gitgram'],
    affectedAgents: ['juridik'],
    recommendedAction: 'Review the public wording.',
    needsLawyer: true,
    sourceUrl: 'https://example.com/mica',
    rooms: ['juridik'],
    ...overrides,
  };
}

function pdfWithText(text, { flate = false } = {}) {
  const stream = `BT (${text}) Tj ET\n`;
  const data = flate ? zlib.deflateRawSync(Buffer.from(stream)) : Buffer.from(stream);
  const filter = flate ? '/Filter /FlateDecode ' : '';
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >> endobj\n',
    `4 0 obj << ${filter}/Length ${data.length} >> stream\n`,
  ];
  let pdf = '%PDF-1.4\n';
  const chunks = [Buffer.from(pdf)];
  let cursor = Buffer.byteLength(pdf);
  const offsets = [0];
  const head = objects.join('');
  offsets.push(cursor);
  chunks.push(Buffer.from(objects[0]));
  cursor += Buffer.byteLength(objects[0]);
  offsets.push(cursor);
  chunks.push(Buffer.from(objects[1]));
  cursor += Buffer.byteLength(objects[1]);
  offsets.push(cursor);
  chunks.push(Buffer.from(objects[2]));
  cursor += Buffer.byteLength(objects[2]);
  offsets.push(cursor);
  chunks.push(Buffer.from(objects[3]));
  chunks.push(data);
  chunks.push(Buffer.from('\nendstream\nendobj\n'));
  chunks.push(Buffer.from('5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n'));
  const body = Buffer.concat(chunks);
  const xrefAt = body.length;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 4; i += 1) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  const fontOffset = body.length - Buffer.byteLength('5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n');
  xref += `${String(fontOffset).padStart(10, '0')} 00000 n \n`;
  xref += `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.concat([body, Buffer.from(xref)]);
}

test('pdf text extraction reads plain and compressed streams', () => {
  const plain = pdfWithText('Unlimited liability clause');
  assert.match(extractPdfText(plain), /Unlimited liability clause/);
  const compressed = pdfWithText('uncertain GDPR roles', { flate: true });
  assert.match(extractPdfText(compressed), /uncertain GDPR roles/);
});

test('client renderers escape messages and flags and voice notes degrade', () => {
  const html = renderMessageHtml({
    id: 4,
    panel: 'legal',
    authorType: 'agent',
    authorName: '<b>Juridik</b>',
    body: '<script>alert(1)</script>',
    createdAt: '2026-09-30T00:00:00.000Z',
    displayTime: '2026-09-30 00:00',
    legalTags: ['Contracts'],
    risks: ['<img src=x>'],
    badges: [{ label: LAWYER_BADGE }],
    disclaimer: JURIDIK_DISCLAIMER,
    documents: [{ name: '<file>', preview: '<preview>' }],
  }, { voiceAvailable: true });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /AI-agent/);
  assert.match(html, /AI-generated/);
  assert.equal(pushToTalkBlocked({ voiceAvailable: true, micSupported: true, acknowledged: false }), true);
  assert.equal(pushToTalkBlocked({ voiceAvailable: true, micSupported: true, acknowledged: true }), false);
  assert.equal(spokenText('Paper discussion only.', { disclose: true, disclosure: 'Du pratar med en AI-röst' }), 'Du pratar med en AI-röst. Paper discussion only.');
  assert.equal(spokenText('Paper discussion only.', { disclose: false, disclosure: 'Du pratar med en AI-röst' }), 'Paper discussion only.');
  assert.equal(mentionQuery('hello @de', 9), 'de');
  assert.equal(mentionQuery('hello', 5), null);
  assert.deepEqual(visibleMentions([{ slug: 'dev', name: 'Dev' }, { slug: 'juridik', name: 'Juridik' }], 'ju').map((agent) => agent.slug), ['juridik']);
  const marked = markGeneratedAudio(Buffer.from('RIFF'), 'audio/wav', {
    provider: 'fake',
    model: 'fake',
    generatedAt: '2026-10-05T00:00:00.000Z',
  });
  assert.match(marked.toString('latin1'), /AI-Generated/);
  assert.match(marked.toString('latin1'), /AI-Provider/);
  assert.match(marked.toString('latin1'), /fake/);
  assert.equal(voiceRetentionEnabled({ retainVoiceAudio: false }, {}), false);
  assert.equal(voiceRetentionEnabled({ retainVoiceAudio: true }, { TEAM_RETAIN_VOICE: '0' }), false);
  assert.equal(voiceRetentionEnabled({ retainVoiceAudio: false }, { TEAM_RETAIN_VOICE: '1' }), true);
  assert.match(html, new RegExp(escapeHtml(LAWYER_BADGE)));
  const flag = renderFlagHtml({
    id: 2,
    kindLabel: 'Regelflagga',
    title: '<img src=x onerror=alert(1)>',
    severity: 'hög',
    summary: '<b>summary</b>',
    affectedProjects: ['<proj>'],
    affectedAgents: ['juridik'],
    recommendedAction: '<act>',
    needsLawyerText: `${LAWYER_BADGE}: ja`,
    sourceUrl: 'javascript:alert(1)',
    safeUrl: '',
    acknowledgements: [],
  }, { csrfToken: 'abc' });
  assert.doesNotMatch(flag, /<img src/);
  assert.doesNotMatch(flag, /javascript:/);
  assert.match(flag, /Regelflagga/);
  assert.doesNotMatch(flag, /href=/);
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl('https://example.com/a'), 'https://example.com/a');
  assert.deepEqual(voiceNotes({
    voiceAvailable: false,
    micSupported: false,
    voiceNotice: 'Text only. No speech API key is set, so voice stays off.',
    micNotice: 'This browser has no microphone. You can still type.',
  }).length, 2);
  assert.equal(micSupported({}), false);
  assert.equal(tokensEqual('same', 'same'), true);
  assert.equal(tokensEqual('same', 'different-length'), false);
});

test('agent prompts live in config and trading has no tools', () => {
  const sources = ['lib/team/schema.js', 'agents/runner.js', 'routes/team.js']
    .map((file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
    .join('\n');
  assert.doesNotMatch(sources, /never promise returns/);
  assert.doesNotMatch(sources, /inte en advokat/);
  const trading = agentsConfig.agents.find((agent) => agent.slug === 'trading');
  const juridik = agentsConfig.agents.find((agent) => agent.slug === 'juridik');
  assert.deepEqual(trading.allowedTools, []);
  assert.match(trading.systemPrompt, /never promise returns/i);
  assert.match(trading.systemPrompt, /personalized financial advice/i);
  assert.match(trading.systemPrompt, /real trade/i);
  assert.equal(trading.disclaimer, TRADING_LABEL);
  assert.match(juridik.systemPrompt, /not a lawyer/i);
  assert.match(agentsConfig.sharedBoundaries, /refuse personalized buy or sell advice about real assets/i);
  assert.match(agentsConfig.sharedBoundaries, /real money/i);
  assert.match(agentsConfig.sharedBoundaries, /blockchain/i);
  assert.match(agentsConfig.sharedBoundaries, /KYC/);
  assert.match(juridik.disclaimer, /not legal advice/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).scripts.agents, 'node agents/runner.js');
});

test('room auth, membership, escaping, caps, hops, voice, and flags', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const anon = await request(ctx.app).get('/team');
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.location, '/login');

  const alice = request.agent(ctx.app);
  const aliceCookie = await register(alice, 'alice');
  const home = await alice.get('/team');
  assert.equal(home.status, 302);
  assert.equal(home.headers.location, '/team/general');
  const page = await alice.get('/team/general');
  assert.equal(page.status, 200);
  assert.match(page.text, /for="message-body"/);
  assert.match(page.text, /id="message-body"/);
  assert.match(page.text, /for="area-mica"/);
  assert.match(page.text, /id="push-to-talk"/);
  assert.match(page.text, /AI Act \(EU AI-förordningen\)/);
  assert.match(page.text, new RegExp(escapeHtml(JURIDIK_DISCLAIMER).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(page.text, new RegExp(TRADING_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(page.text, /disabled/);
  const token = csrfFrom(page.text);

  const bob = request.agent(ctx.app);
  await register(bob, 'bob');
  const created = await alice.post('/team/rooms').type('form').send({ name: 'Launch', _csrf: token });
  assert.equal(created.status, 302);
  assert.equal(created.headers.location, '/team/launch');
  const secret = await alice.post('/api/team/rooms/launch/messages').set('x-csrf-token', token).send({
    body: '<script>alert(1)</script> secret launch note',
  });
  assert.equal(secret.status, 201);
  const outsider = await bob.get('/team/launch');
  assert.equal(outsider.status, 403);
  assert.doesNotMatch(outsider.text, /secret launch note/);
  const missingCsrf = await alice.post('/api/team/rooms/launch/messages').send({ body: 'no token' });
  assert.equal(missingCsrf.status, 403);

  const shown = await alice.get('/team/launch');
  assert.match(shown.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(shown.text, /<script>alert\(1\)<\/script>/);
  const stored = ctx.db.prepare('SELECT body FROM messages WHERE body LIKE ?').get('%secret launch note%');
  assert.match(stored.body, /<script>alert\(1\)<\/script>/);

  const dev = agentRow(ctx.db, 'dev');
  const designer = agentRow(ctx.db, 'designer');
  const researcher = agentRow(ctx.db, 'researcher');
  const notMentioned = await request(ctx.app)
    .post('/api/team/rooms/launch/messages')
    .set('Authorization', `Bearer ${researcher.token}`)
    .send({ body: 'I jump in', parentId: secret.body.message.id, usage: { tokens: 32, costCents: 0 } });
  assert.equal(notMentioned.status, 403);
  assert.equal(notMentioned.body.error, 'not_addressed');

  const turned = await alice.post('/api/team/rooms/launch/messages').set('x-csrf-token', token).send({
    body: 'Your turn.',
    addressedAgentId: dev.id,
  });
  assert.equal(turned.status, 201);
  const devTurn = await request(ctx.app)
    .post('/api/team/rooms/launch/messages')
    .set('Authorization', `Bearer ${dev.token}`)
    .send({ body: 'Dev: taking the turn.', parentId: turned.body.message.id, usage: { tokens: 32, costCents: 0 } });
  assert.equal(devTurn.status, 201);
  assert.equal(devTurn.body.message.hop, 1);

  const limited = await start({ maxHops: 2 });
  t.after(() => limited.close());
  const cara = request.agent(limited.app);
  await register(cara, 'cara');
  const caraPage = await cara.get('/team/general');
  const caraToken = csrfFrom(caraPage.text);
  const seed = await cara.post('/api/team/rooms/general/messages').set('x-csrf-token', caraToken).send({ body: '@dev start the chain' });
  const dev2 = agentRow(limited.db, 'dev');
  const designer2 = agentRow(limited.db, 'designer');
  const hop1 = await request(limited.app)
    .post('/api/team/rooms/general/messages')
    .set('Authorization', `Bearer ${dev2.token}`)
    .send({ body: '@designer continue', parentId: seed.body.message.id, usage: { tokens: 32, costCents: 0 } });
  assert.equal(hop1.status, 201);
  assert.equal(hop1.body.message.hop, 1);
  const hop2 = await request(limited.app)
    .post('/api/team/rooms/general/messages')
    .set('Authorization', `Bearer ${designer2.token}`)
    .send({ body: '@dev continue', parentId: hop1.body.message.id, usage: { tokens: 32, costCents: 0 } });
  assert.equal(hop2.status, 201);
  assert.equal(hop2.body.message.hop, 2);
  const stopped = await request(limited.app)
    .post('/api/team/rooms/general/messages')
    .set('Authorization', `Bearer ${dev2.token}`)
    .send({ body: 'too far', parentId: hop2.body.message.id, usage: { tokens: 32, costCents: 0 } });
  assert.equal(stopped.status, 403);
  assert.equal(stopped.body.error, 'hop_limit');
  assert.equal(agentShouldRespond(dev2, hop2.body.message, { maxHops: 2 }).reason, 'hop_limit');

  ctx.db.prepare('UPDATE agents SET daily_token_cap = 0 WHERE slug = ?').run('dev');
  const cappedParent = await alice.post('/api/team/rooms/launch/messages').set('x-csrf-token', token).send({ body: '@dev hello again' });
  const capped = await request(ctx.app)
    .post('/api/team/rooms/launch/messages')
    .set('Authorization', `Bearer ${dev.token}`)
    .send({ body: 'should not post', parentId: cappedParent.body.message.id, usage: { tokens: 32, costCents: 0 } });
  assert.equal(capped.status, 429);
  assert.equal(capped.body.error, 'daily_cap');
  const notice = await alice.get('/team/launch');
  assert.match(notice.text, /hit the daily cap/);
  ctx.db.prepare('UPDATE agents SET daily_token_cap = 20000, daily_cost_cap_cents = 4 WHERE slug = ?').run('designer');
  const costParent = await alice.post('/api/team/rooms/launch/messages').set('x-csrf-token', token).send({ body: '@designer cost check' });
  const cost = await request(ctx.app)
    .post('/api/team/rooms/launch/messages')
    .set('Authorization', `Bearer ${designer.token}`)
    .send({ body: 'too expensive', parentId: costParent.body.message.id, usage: { tokens: 32, costCents: 5 } });
  assert.equal(cost.status, 429);

  const contract = 'The contractor accepts unlimited liability. The parties are uncertain about GDPR roles.';
  const review = await alice.post('/api/team/rooms/general/messages').set('x-csrf-token', token).send({
    body: '@juridik please review this contract',
    legalTags: ['Contracts', 'GDPR/privacy'],
    contractText: contract,
  });
  assert.equal(review.status, 201);
  assert.deepEqual(review.body.message.legalTags, ['Contracts', 'GDPR/privacy']);
  assert.match(review.body.message.documents[0].preview, /unlimited liability/i);
  const juridik = agentRow(ctx.db, 'juridik');
  const context = ctx.app.locals.teamService.buildContext(juridik, 'general', review.body.message.id);
  const plan = await planAgentReply({
    model: createFakeModel(),
    agent: context.context.agent,
    context: context.context,
    maxHops: 3,
  });
  assert.equal(plan.action, 'reply');
  assert.match(plan.body, /reviewed the last/);
  const reply = await request(ctx.app)
    .post('/api/team/rooms/general/messages')
    .set('Authorization', `Bearer ${juridik.token}`)
    .send({
      body: plan.body,
      parentId: review.body.message.id,
      usage: plan.usage,
      needsLawyer: plan.needsLawyer,
      risks: plan.risks,
      legalTags: plan.legalTags,
    });
  assert.equal(reply.status, 201);
  assert.equal(reply.body.message.needsLawyer, true);
  assert.ok(reply.body.message.risks.some((risk) => /Unlimited liability/.test(risk)));
  assert.ok(reply.body.message.legalTags.includes('Contracts'));
  assert.equal(reply.body.message.disclaimer, JURIDIK_DISCLAIMER);
  const legalPage = await alice.get('/team/general');
  assert.match(legalPage.text, new RegExp(LAWYER_BADGE));
  assert.match(legalPage.text, /Unlimited liability/);
  assert.match(legalPage.text, /Contracts/);
  assert.match(legalPage.text, /GDPR\/privacy/);

  const pdf = pdfWithText('Warranty is disclaimed as is for this statement of work.');
  const uploaded = await alice.post('/api/team/rooms/general/messages').set('x-csrf-token', token).send({
    body: '@juridik review the file',
    legalTags: ['Contracts'],
    file: { name: '../../agreement.pdf', dataBase64: pdf.toString('base64') },
  });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.message.documents[0].name, 'agreement.pdf');
  assert.match(uploaded.body.message.documents[0].preview, /as is/i);
  const saved = ctx.db.prepare('SELECT stored_path FROM documents WHERE message_id = ?').get(uploaded.body.message.id);
  assert.match(saved.stored_path, /^uploads\/\d+\/[a-f0-9]+\.bin$/);
  assert.equal(fs.existsSync(path.join(ctx.dir, 'data', saved.stored_path)), true);
  const blocked = await request(ctx.app).get(`/${saved.stored_path}`);
  assert.equal(blocked.status, 404);
  const badType = await alice.post('/api/team/rooms/general/messages').set('x-csrf-token', token).send({
    body: '@juridik',
    file: { name: 'payload.exe', dataBase64: Buffer.from('hello').toString('base64') },
  });
  assert.equal(badType.status, 400);
  const binary = await alice.post('/api/team/rooms/general/messages').set('x-csrf-token', token).send({
    body: '@juridik',
    file: { name: 'notes.txt', dataBase64: Buffer.from('ok\u0000no').toString('base64') },
  });
  assert.equal(binary.status, 400);

  const tradingParent = await alice.post('/api/team/rooms/general/messages').set('x-csrf-token', token).send({
    body: '@trading what about a paper breakout?',
  });
  const trading = agentRow(ctx.db, 'trading');
  const tradingReply = await request(ctx.app)
    .post('/api/team/rooms/general/messages')
    .set('Authorization', `Bearer ${trading.token}`)
    .send({ body: 'Paper discussion only.', parentId: tradingParent.body.message.id, usage: { tokens: 32, costCents: 0 } });
  assert.equal(tradingReply.status, 201);
  assert.equal(tradingReply.body.message.disclaimer, TRADING_LABEL);
  assert.equal(tradingReply.body.message.needsLawyer, false);
  const tradingPage = await alice.get('/team/general');
  const occurrences = tradingPage.text.split(TRADING_LABEL).length - 1;
  assert.ok(occurrences >= 2);
  assert.match(tradingPage.text, /team-ai-badge">AI-agent/);
  assert.match(tradingPage.text, /team-ai-tag">AI-agent/);
  assert.match(tradingPage.text, /team-generated">AI-generated/);
  assert.match(tradingPage.text, /id="voice-cloud-notice"/);
  assert.match(tradingPage.text, /cloud speech provider/);
  assert.match(tradingPage.text, /id="voice-retention-notice"/);
  assert.match(tradingPage.text, /raw recording is discarded/);
  assert.match(tradingPage.text, /id="room-ai-notice"/);
  assert.match(tradingPage.text, /Jarvis is AI/);
  assert.match(tradingPage.text, /id="mention-list"/);
  assert.match(tradingPage.text, /data-slug="dev"/);
  assert.match(tradingPage.text, /id="team-ai-live"/);
  assert.match(tradingPage.text, /AI voice/);
  assert.match(tradingPage.text, /id="voice-disclosure-notice"/);
  assert.match(tradingPage.text, /Du pratar med en AI-röst/);
  assert.match(tradingPage.text, /for="voice-ack"/);
  assert.match(tradingPage.text, /id="voice-ack"/);
  assert.equal(ctx.db.prepare('SELECT ai_generated FROM messages WHERE id = ?').get(tradingReply.body.message.id).ai_generated, 1);
  assert.equal(ctx.db.prepare('SELECT ai_generated FROM messages WHERE id = ?').get(tradingParent.body.message.id).ai_generated, 0);
  for (const row of ctx.db.prepare('SELECT slug, system_prompt FROM agents').all()) {
    assert.match(row.system_prompt, /refuse personalized buy or sell advice about real assets/i, row.slug);
    assert.match(row.system_prompt, /real money/i, row.slug);
    assert.match(row.system_prompt, /blockchain/i, row.slug);
    assert.match(row.system_prompt, /KYC/, row.slug);
  }

  const stt = await alice.post('/api/team/rooms/general/stt')
    .set('x-csrf-token', token)
    .set('Content-Type', 'audio/webm')
    .send(Buffer.from('fake-audio'));
  assert.equal(stt.status, 201);
  assert.equal(stt.body.transcript, 'voice note from the team');
  const speech = await alice.get(`/api/team/messages/${tradingReply.body.message.id}/speak`).buffer(true);
  assert.equal(speech.status, 200);
  assert.match(speech.headers['content-type'], /audio\/wav/);
  assert.equal(speech.body.subarray(0, 4).toString(), 'RIFF');
  assert.equal(speech.headers['x-gitgram-ai-disclosure'], '1');
  assert.equal(speech.headers['x-ai-generated'], 'true');
  assert.match(speech.body.toString('latin1'), /AI-Generated/);
  assert.match(speech.body.toString('latin1'), /AI-Provider/);
  assert.match(speech.body.toString('latin1'), /AI-Model/);
  assert.match(ctx.app.locals.voice.lastSpoken, /^Du pratar med en AI-röst/);
  const speechAgain = await alice.get(`/api/team/messages/${tradingReply.body.message.id}/speak`).buffer(true);
  assert.equal(speechAgain.status, 200);
  assert.equal(speechAgain.headers['x-ai-generated'], 'true');
  assert.equal(speechAgain.headers['x-gitgram-ai-disclosure'], '0');
  assert.equal(speechAgain.body.toString('latin1').includes('AI-Generated'), true);
  assert.equal(ctx.app.locals.voice.lastSpoken.startsWith('Du pratar med en AI-röst'), false);
  assert.equal(fs.existsSync(path.join(ctx.dir, 'data', 'voice-retained')), false);

  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/team/ws`, {
    headers: {
      Cookie: aliceCookie,
      Origin: `http://127.0.0.1:${ctx.port}`,
    },
  });
  t.after(() => ws.close());
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade ${res.statusCode}`)));
  });
  const joined = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'joined') resolve(event);
    });
  });
  ws.send(JSON.stringify({ type: 'join', room: 'juridik' }));
  assert.equal((await joined).room, 'juridik');
  const flagged = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'flag') resolve(event);
    });
  });
  const createdFlag = await request(ctx.app)
    .post('/api/team/flags')
    .set('Authorization', 'Bearer test-flags-token')
    .send(flagBody({ title: '<img src=x onerror=alert(1)>', rooms: ['juridik', 'launch'] }));
  assert.equal(createdFlag.status, 201);
  const live = await flagged;
  assert.equal(live.flag.title, '<img src=x onerror=alert(1)>');
  const flagPage = await alice.get('/team/juridik');
  assert.match(flagPage.text, /Regelflagga/);
  assert.match(flagPage.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(flagPage.text, /rel="noopener noreferrer"/);
  assert.match(flagPage.text, new RegExp(`${LAWYER_BADGE}: ja`));
  assert.doesNotMatch(flagPage.text, /<img src=x/);
  const ack = await alice.post(`/api/team/flags/${createdFlag.body.flag.id}/ack`).type('form').send({ _csrf: token });
  assert.equal(ack.status, 302);
  const done = await alice.get('/team/juridik?ack=done');
  assert.match(done.text, /Acknowledged by alice/);
  const open = await alice.get('/team/juridik?ack=open&severity=låg');
  assert.doesNotMatch(open.text, /Acknowledged by alice/);
  const byProject = await request(ctx.app)
    .get('/api/team/flags')
    .query({ project: 'gitgram', severity: 'hög', ack: 'done' })
    .set('Authorization', 'Bearer test-flags-token');
  assert.equal(byProject.status, 200);
  assert.ok(byProject.body.flags.some((flag) => flag.id === createdFlag.body.flag.id));
  const bobGeneral = await bob.get('/team/general');
  const bobAck = await bob.post(`/api/team/flags/${createdFlag.body.flag.id}/ack`).set('x-csrf-token', csrfFrom(bobGeneral.text)).send({});
  assert.equal(bobAck.status, 200);

  const privateFlag = await request(ctx.app)
    .post('/api/team/flags')
    .set('Authorization', 'Bearer test-flags-token')
    .send(flagBody({
      title: 'Launch only',
      severity: 'låg',
      rooms: ['launch'],
      affectedProjects: ['Launch'],
      affectedAgents: [],
      needsLawyer: false,
    }));
  assert.equal(privateFlag.status, 201);
  const bobPage = await bob.get('/team/general');
  const bobDenied = await bob.post(`/api/team/flags/${privateFlag.body.flag.id}/ack`)
    .set('Content-Type', 'application/json')
    .set('x-csrf-token', csrfFrom(bobPage.text))
    .send({});
  assert.equal(bobDenied.status, 403);

  const evil = new WebSocket(`ws://127.0.0.1:${ctx.port}/team/ws`, {
    headers: { Cookie: aliceCookie, Origin: 'http://evil.example' },
  });
  t.after(() => evil.close());
  await new Promise((resolve) => {
    evil.once('error', resolve);
    evil.once('unexpected-response', resolve);
  });
});

test('flags endpoint auth and validation', async (t) => {
  const disabled = await start({ flagsToken: null });
  t.after(() => disabled.close());
  const hidden = await request(disabled.app).post('/api/team/flags').send(flagBody());
  assert.equal(hidden.status, 404);
  const hiddenBearer = await request(disabled.app)
    .post('/api/team/flags')
    .set('Authorization', 'Bearer anything')
    .send(flagBody());
  assert.equal(hiddenBearer.status, 404);

  const ctx = await start();
  t.after(() => ctx.close());
  const missing = await request(ctx.app).post('/api/team/flags').send(flagBody());
  assert.equal(missing.status, 401);
  const wrong = await request(ctx.app).post('/api/team/flags').set('Authorization', 'Bearer wrong-token').send(flagBody());
  assert.equal(wrong.status, 401);
  const badSeverity = await request(ctx.app)
    .post('/api/team/flags')
    .set('Authorization', 'Bearer test-flags-token')
    .send(flagBody({ severity: 'high' }));
  assert.equal(badSeverity.status, 400);
  const badUrl = await request(ctx.app)
    .post('/api/team/flags')
    .set('Authorization', 'Bearer test-flags-token')
    .send(flagBody({ sourceUrl: 'javascript:alert(1)' }));
  assert.equal(badUrl.status, 400);
  const badRoom = await request(ctx.app)
    .post('/api/team/flags')
    .set('Authorization', 'Bearer test-flags-token')
    .send(flagBody({ rooms: ['missing-room'] }));
  assert.equal(badRoom.status, 400);
  const good = await request(ctx.app).post('/api/team/flags').set('Authorization', 'Bearer test-flags-token').send(flagBody());
  assert.equal(good.status, 201);
});

test('flags endpoint rate limit', async (t) => {
  const ctx = await start({ flagRateLimit: { windowMs: 60_000, max: 2 } });
  t.after(() => ctx.close());
  const first = await request(ctx.app).post('/api/team/flags').set('Authorization', 'Bearer test-flags-token').send(flagBody({ title: 'One' }));
  const second = await request(ctx.app).post('/api/team/flags').set('Authorization', 'Bearer test-flags-token').send(flagBody({ title: 'Two' }));
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const third = await request(ctx.app).post('/api/team/flags').set('Authorization', 'Bearer test-flags-token').send(flagBody({ title: 'Three' }));
  assert.equal(third.status, 429);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM regulatory_flags').get().n, 2);
});

test('message rate limit and voice unavailable notice', async (t) => {
  const quiet = await start({
    voice: createUnavailableVoice(),
    messageRateLimit: { windowMs: 60_000, max: 2 },
  });
  t.after(() => quiet.close());
  const agent = request.agent(quiet.app);
  await register(agent, 'nina');
  const page = await agent.get('/team/general');
  assert.match(page.text, /Text only. No speech API key is set, so voice stays off./);
  assert.match(page.text, /id="push-to-talk"[^>]*disabled/);
  const token = csrfFrom(page.text);
  assert.equal((await agent.post('/api/team/rooms/general/messages').set('x-csrf-token', token).send({ body: 'one' })).status, 201);
  assert.equal((await agent.post('/api/team/rooms/general/messages').set('x-csrf-token', token).send({ body: 'two' })).status, 201);
  assert.equal((await agent.post('/api/team/rooms/general/messages').set('x-csrf-token', token).send({ body: 'three' })).status, 429);
  const stt = await agent.post('/api/team/rooms/general/stt').set('x-csrf-token', token).set('Content-Type', 'audio/webm').send(Buffer.from('a'));
  assert.equal(stt.status, 503);
  assert.equal(stt.body.error, 'voice_unavailable');
});

test('langgraph interrupt blocks write tools and read-only tools stay local', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const model = createFakeModel();
  const dev = agentRow(ctx.db, 'dev');
  const context = {
    message: {
      id: 1,
      authorType: 'user',
      body: '[[tool:write_repo]] @dev',
      hop: 0,
      legalTags: [],
    },
    recent: [],
    documents: [],
    roster: [{ name: 'Ada', kind: 'user' }],
    usage: { tokens: 0, costCents: 0 },
  };
  const agent = {
    id: dev.id,
    slug: dev.slug,
    name: dev.name,
    systemPrompt: dev.system_prompt,
    allowedTools: JSON.parse(dev.allowed_tools),
    daily_token_cap: dev.daily_token_cap,
    daily_cost_cap_cents: dev.daily_cost_cap_cents,
  };
  const approval = await planAgentReply({ model, agent, context, maxHops: 3 });
  assert.equal(approval.action, 'approval');
  assert.equal(approval.tool, 'write_repo');
  const denied = await resumePlannedReply({ model, threadId: approval.threadId, decision: 'deny' });
  assert.match(denied.body, /denied/i);
  assert.match(denied.body, /nothing was taken|No action/i);
  const read = await planAgentReply({
    model,
    agent,
    context: { ...context, message: { ...context.message, id: 2, body: '[[tool:room_roster]] @dev' } },
    maxHops: 3,
  });
  assert.equal(read.action, 'reply');
  assert.match(read.body, /Ada/);
  const trading = agentRow(ctx.db, 'trading');
  const order = await planAgentReply({
    model,
    agent: {
      id: trading.id,
      slug: trading.slug,
      name: trading.name,
      systemPrompt: trading.system_prompt,
      allowedTools: [],
      daily_token_cap: trading.daily_token_cap,
      daily_cost_cap_cents: trading.daily_cost_cap_cents,
    },
    context: { ...context, message: { ...context.message, id: 3, body: '[[tool:place_order]] @trading' } },
    maxHops: 3,
  });
  assert.equal(order.action, 'approval');
  assert.equal(order.tool, 'place_order');
  const quiet = await planAgentReply({
    model,
    agent,
    context: { ...context, usage: { tokens: dev.daily_token_cap, costCents: 0 } },
    maxHops: 3,
  });
  assert.equal(quiet.action, 'skip');
  assert.equal(quiet.reason, 'daily_cap');
});

test('voice retention stores audio only when the owner enables it', async () => {
  const ctx = await start({ retainVoiceAudio: true });
  try {
    const alice = request.agent(ctx.app);
    await register(alice, 'ada');
    const token = csrfFrom((await alice.get('/team/general')).text);
    const payload = Buffer.from('retain-me-audio');
    const stt = await alice.post('/api/team/rooms/general/stt')
      .set('x-csrf-token', token)
      .set('Content-Type', 'audio/webm')
      .send(payload);
    assert.equal(stt.status, 201);
    const dir = path.join(ctx.dir, 'data', 'voice-retained');
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, files[0])).equals(payload), true);
    const mode = fs.statSync(path.join(dir, files[0])).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await ctx.close();
  }
});

test('third-party notices list the new tree and no GPL or AGPL', () => {
  const report = buildReport();
  assert.equal(report.copyleft.length, 0);
  assert.equal(report.productionCopyleft.length, 0);
  assert.ok(report.packages.some((pkg) => pkg.name === '@langchain/langgraph' && pkg.license === 'MIT'));
  assert.ok(report.packages.some((pkg) => pkg.name === 'ws' && pkg.license === 'MIT'));
  const notices = fs.readFileSync(path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /No GPL or AGPL packages were found/);
  assert.match(notices, /@langchain\/langgraph/);
  assert.match(notices, /\| ws \|/);
});

test('cloud speech notice is shown before push-to-talk', async () => {
  const voice = {
    name: 'cloud-test',
    available: true,
    sendsAudioToCloud: true,
    lastSpoken: '',
    async transcribe() {
      return { text: 'voice note from the team' };
    },
    async synthesize(text) {
      this.lastSpoken = String(text || '');
      return { audio: Buffer.from('RIFF----'), contentType: 'audio/wav' };
    },
  };
  const ctx = await start({ voice });
  try {
    const alice = request.agent(ctx.app);
    await register(alice, 'ada');
    const page = await alice.get('/team/general');
    const notice = page.text.match(/id="voice-cloud-notice">([^<]+)</);
    assert.equal(notice && notice[1], 'Push-to-talk sends audio to a cloud speech provider for transcription.');
    assert.match(page.text, /for="voice-ack"/);
  } finally {
    await ctx.close();
  }
});
