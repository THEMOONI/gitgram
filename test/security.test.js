const assert = require('node:assert/strict');
const { spawnSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const request = require('supertest');
const { createApp } = require('../server');
const { collectProductionNotices, licenseFlag } = require('../scripts/third-party-notices');
const { isValidUsername, isValidRepoName, isValidRef, resolveRepoPath } = require('../lib/validate');
const { renderSearchResults, debounce, SEARCH_DEBOUNCE_MS, initSearch } = require('../public/js/app');

function gitExec(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'credential.helper=', ...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function sessionCookie(res) {
  const list = res.headers['set-cookie'] || [];
  const raw = list.find((line) => line.startsWith('connect.sid='));
  return raw ? raw.split(';')[0] : '';
}

async function start(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-'));
  const app = createApp({
    dbPath: path.join(dir, 'gitgram.db'),
    dataDir: path.join(dir, 'data'),
    sessionSecret: 'test-session-secret-value',
    loginRateLimit: extra.loginRateLimit,
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address();
  return {
    app,
    dir,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      app.locals.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  assert.ok(match, 'csrf token missing');
  return match[1];
}

async function register(agent, username, password = 'testpass123') {
  const page = await agent.get('/register');
  return agent.post('/register').redirects(0).type('form').send({
    username,
    email: `${username}@example.com`,
    password,
    _csrf: csrfFrom(page.text),
  });
}

function markerName() {
  return `gitgram-pwn-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test('name allowlist rejects traversal and shell metacharacters', () => {
  assert.equal(isValidUsername('alice'), true);
  assert.equal(isValidUsername('team'), false);
  assert.equal(isValidUsername('ab'), false);
  assert.equal(isValidUsername('../etc'), false);
  assert.equal(isValidUsername('a;id'), false);
  assert.equal(isValidRepoName('demo'), true);
  assert.equal(isValidRepoName('my.repo'), true);
  assert.equal(isValidRepoName('a..b'), false);
  assert.equal(isValidRepoName('../secret'), false);
  assert.equal(isValidRepoName('ok";touch'), false);
  assert.equal(isValidRepoName('demo.git'), false);
  assert.equal(isValidRef('main'), true);
  assert.equal(isValidRef('HEAD'), true);
  assert.equal(isValidRef('main;id'), false);
  assert.equal(isValidRef('$(id)'), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-path-'));
  try {
    assert.equal(resolveRepoPath(root, '..', 'demo'), null);
    assert.equal(resolveRepoPath(root, 'alice', '..'), null);
    const resolved = resolveRepoPath(root, 'alice', 'demo');
    assert.ok(resolved.startsWith(path.resolve(root, 'repos') + path.sep));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('search output is escaped and live search waits about 200ms', async () => {
  const html = renderSearchResults([{
    name: '<img src=x onerror=alert(1)>',
    owner_name: '<b>bob</b>',
    full_name: 'bob/"<script>alert(1)</script>',
  }]);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<b>/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;/);
  assert.equal(SEARCH_DEBOUNCE_MS, 200);

  let calls = 0;
  const debounced = debounce(() => { calls += 1; }, SEARCH_DEBOUNCE_MS);
  debounced();
  debounced();
  assert.equal(calls, 0);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, 0);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(calls, 1);

  let fetches = 0;
  const results = { style: { display: 'none' }, innerHTML: '', contains() { return false; } };
  const input = {
    value: 'demo',
    addEventListener(type, fn) {
      if (type === 'input') this.onInput = fn;
    },
  };
  const fakeDoc = {
    getElementById(id) {
      if (id === 'searchInput') return input;
      if (id === 'searchResults') return results;
      return null;
    },
    addEventListener() {},
  };
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetches += 1;
    return { json: async () => [{ name: 'demo', owner_name: 'alice', full_name: 'alice/demo' }] };
  };
  try {
    initSearch(fakeDoc);
    input.onInput();
    input.onInput();
    input.onInput();
    assert.equal(fetches, 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(fetches, 0);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(fetches, 1);
    assert.match(results.innerHTML, /alice\/demo/);
    assert.equal(results.style.display, 'block');
  } finally {
    global.fetch = originalFetch;
  }
});

test('production requires SESSION_SECRET', () => {
  const result = spawnSync(process.execPath, ['-e', `
    process.env.NODE_ENV = 'production';
    delete process.env.SESSION_SECRET;
    const { createApp } = require('./server');
    try {
      createApp({
        dbPath: require('path').join(require('os').tmpdir(), 'gitgram-no-secret', 'x.db'),
        dataDir: require('path').join(require('os').tmpdir(), 'gitgram-no-secret-data'),
      });
      console.error('createApp did not throw');
      process.exit(2);
    } catch (err) {
      if (!/SESSION_SECRET/.test(err.message)) {
        console.error(err);
        process.exit(3);
      }
      process.exit(0);
    }
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('malicious ref and repo names are rejected or harmless', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const agent = request.agent(ctx.app);
  const created = await register(agent, 'alice');
  assert.equal(created.status, 302);

  const badAgent = request.agent(ctx.app);
  const badUser = await badAgent.get('/register');
  const rejectedUser = await badAgent.post('/register').type('form').send({
    username: 'ab";id',
    email: 'bad@example.com',
    password: 'testpass123',
    _csrf: csrfFrom(badUser.text),
  });
  assert.equal(rejectedUser.status, 200);
  assert.match(rejectedUser.text, /Username must be 3-39 characters/);
  assert.equal(ctx.app.locals.db.prepare('SELECT id FROM users WHERE username = ?').get('ab";id'), undefined);

  const repoPage = await agent.get('/new');
  const repoMarker = markerName();
  t.after(() => fs.rmSync(path.join(process.cwd(), repoMarker), { force: true }));
  const badRepo = await agent.post('/new').type('form').send({
    name: `ok";touch ${repoMarker};echo "`,
    description: '',
    _csrf: csrfFrom(repoPage.text),
  });
  assert.equal(badRepo.status, 200);
  assert.match(badRepo.text, /Invalid repository name/);
  assert.equal(fs.existsSync(path.join(process.cwd(), repoMarker)), false);

  const traversal = await agent.post('/new').type('form').send({
    name: '../secret',
    _csrf: csrfFrom(repoPage.text),
  });
  assert.match(traversal.text, /Invalid repository name/);

  const freshNew = await agent.get('/new');
  const made = await agent.post('/new').redirects(0).type('form').send({
    name: 'demo',
    description: 'notes',
    _csrf: csrfFrom(freshNew.text),
  });
  assert.equal(made.status, 302);

  const refMarker = markerName();
  t.after(() => fs.rmSync(path.join(process.cwd(), refMarker), { force: true }));
  const ref = `main;touch ${refMarker};`;
  const injected = await agent.get(`/alice/demo/blob/${encodeURIComponent(ref)}/README.md`);
  assert.equal(injected.status, 400);
  assert.equal(fs.existsSync(path.join(process.cwd(), refMarker)), false);

  const fileMarker = markerName();
  t.after(() => fs.rmSync(path.join(process.cwd(), fileMarker), { force: true }));
  const filepath = `foo";touch ${fileMarker};`;
  const fileInjected = await agent.get(`/alice/demo/blob/main/${encodeURIComponent(filepath)}`);
  assert.notEqual(fileInjected.status, 500);
  assert.equal(fs.existsSync(path.join(process.cwd(), fileMarker)), false);

  const outside = await request(ctx.app).get('/alice/foo..bar');
  assert.equal(outside.status, 404);
  assert.match(outside.text, /Page not found/);
});

test('private repositories cannot be cloned anonymously', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const agent = request.agent(ctx.app);
  assert.equal((await register(agent, 'alice')).status, 302);
  const newPage = await agent.get('/new');
  const made = await agent.post('/new').redirects(0).type('form').send({
    name: 'secret',
    description: 'hidden',
    is_private: '1',
    _csrf: csrfFrom(newPage.text),
  });
  assert.equal(made.status, 302);

  const hidden = await request(ctx.app).get('/alice/secret');
  assert.equal(hidden.status, 404);
  assert.match(hidden.text, /Page not found/);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-work-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.writeFileSync(path.join(work, 'README.md'), 'top secret\n');
  await gitExec(['init'], { cwd: work });
  await gitExec(['config', 'user.email', 'test@example.com'], { cwd: work });
  await gitExec(['config', 'user.name', 'Test'], { cwd: work });
  await gitExec(['add', 'README.md'], { cwd: work });
  await gitExec(['commit', '-m', 'secret commit'], { cwd: work });
  await gitExec(['branch', '-M', 'main'], { cwd: work });
  const port = new URL(ctx.base).port;
  await gitExec(['remote', 'add', 'origin', `http://alice:testpass123@127.0.0.1:${port}/alice/secret.git`], { cwd: work });
  await gitExec(['push', '-u', 'origin', 'main'], { cwd: work });

  const anonRefs = await request(ctx.app).get('/alice/secret.git/info/refs').query({ service: 'git-upload-pack' });
  assert.equal(anonRefs.status, 401);
  assert.doesNotMatch(anonRefs.text, /refs\/heads/);
  const anonPack = await request(ctx.app).post('/alice/secret.git/git-upload-pack').send('0000');
  assert.equal(anonPack.status, 401);

  const anonClone = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-anon-'));
  t.after(() => fs.rmSync(anonClone, { recursive: true, force: true }));
  await assert.rejects(gitExec(['clone', `${ctx.base}/alice/secret.git`, anonClone]));
  assert.equal(fs.existsSync(path.join(anonClone, 'README.md')), false);

  const auth = Buffer.from('alice:testpass123').toString('base64');
  const authedRefs = await request(ctx.app)
    .get('/alice/secret.git/info/refs')
    .query({ service: 'git-upload-pack' })
    .set('Authorization', `Basic ${auth}`);
  assert.equal(authedRefs.status, 200);

  const authedClone = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-auth-'));
  t.after(() => fs.rmSync(authedClone, { recursive: true, force: true }));
  await gitExec(['clone', `http://alice:testpass123@127.0.0.1:${port}/alice/secret.git`, authedClone]);
  assert.equal(fs.readFileSync(path.join(authedClone, 'README.md'), 'utf8'), 'top secret\n');

  const search = await request(ctx.app).get('/api/search/repos').query({ q: 'secret' });
  assert.ok(!search.body.some((repo) => repo.full_name === 'alice/secret'));
});

test('not-found paths in auth and repo routes render the 404 page', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());

  const missingUser = await request(ctx.app).get('/@no_such_user_zz');
  assert.equal(missingUser.status, 404);
  assert.match(missingUser.text, /Page not found/);
  assert.match(missingUser.text, /class="error-code"/);
  assert.doesNotMatch(missingUser.text, /Failed to lookup view/);

  const invalidUser = await request(ctx.app).get('/@ab');
  assert.equal(invalidUser.status, 404);
  assert.match(invalidUser.text, /Page not found/);

  const missingRepo = await request(ctx.app).get('/no_such_owner/no_such_repo');
  assert.equal(missingRepo.status, 404);
  assert.match(missingRepo.text, /Page not found/);

  const unknown = await request(ctx.app).get('/this-page-does-not-exist');
  assert.equal(unknown.status, 404);
  assert.match(unknown.text, /Page not found/);

  const agent = request.agent(ctx.app);
  assert.equal((await register(agent, 'alice')).status, 302);
  const newPage = await agent.get('/new');
  await agent.post('/new').redirects(0).type('form').send({
    name: 'demo',
    _csrf: csrfFrom(newPage.text),
  });
  const missingFile = await agent.get('/alice/demo/blob/main/missing.txt');
  assert.equal(missingFile.status, 404);
  assert.match(missingFile.text, /Page not found/);
  assert.doesNotMatch(missingFile.text, /Failed to lookup view/);
});

test('register, login, create, push, clone, browse, search, and delete still work', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const agent = request.agent(ctx.app);

  const registerPage = await agent.get('/register');
  assert.match(registerPage.headers['set-cookie'].join(';'), /samesite=lax/i);
  const created = await agent.post('/register').redirects(0).type('form').send({
    username: 'alice',
    email: 'alice@example.com',
    password: 'testpass123',
    _csrf: csrfFrom(registerPage.text),
  });
  assert.equal(created.status, 302);
  assert.equal(created.headers.location, '/');
  assert.notEqual(sessionCookie(created), '');
  assert.notEqual(sessionCookie(created), sessionCookie(registerPage));

  const noToken = await request(ctx.app).post('/register').type('form').send({
    username: 'bobuser',
    email: 'bob@example.com',
    password: 'testpass123',
  });
  assert.equal(noToken.status, 403);

  const home = await agent.get('/');
  assert.match(home.text, /Log out/);
  await agent.post('/logout').redirects(0).type('form').send({ _csrf: csrfFrom(home.text) });

  const loginPage = await agent.get('/login');
  const loginToken = csrfFrom(loginPage.text);
  const badLogin = await agent.post('/login').type('form').send({
    username: 'alice',
    password: 'wrong-password',
    _csrf: loginToken,
  });
  assert.equal(badLogin.status, 200);
  assert.match(badLogin.text, /Invalid credentials/);
  const loggedIn = await agent.post('/login').redirects(0).type('form').send({
    username: 'alice',
    password: 'testpass123',
    _csrf: loginToken,
  });
  assert.equal(loggedIn.status, 302);
  assert.notEqual(sessionCookie(loggedIn), sessionCookie(loginPage));

  const newPage = await agent.get('/new');
  const made = await agent.post('/new').redirects(0).type('form').send({
    name: 'demo',
    description: 'A demo repository',
    _csrf: csrfFrom(newPage.text),
  });
  assert.equal(made.status, 302);
  assert.equal(made.headers.location, '/alice/demo');

  const empty = await agent.get('/alice/demo');
  assert.equal(empty.status, 200);
  assert.match(empty.text, /Quick setup/);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-work-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.writeFileSync(path.join(work, 'README.md'), 'hello-gitgram\n');
  await gitExec(['init'], { cwd: work });
  await gitExec(['config', 'user.email', 'test@example.com'], { cwd: work });
  await gitExec(['config', 'user.name', 'Test'], { cwd: work });
  await gitExec(['add', 'README.md'], { cwd: work });
  await gitExec(['commit', '-m', 'first commit'], { cwd: work });
  await gitExec(['branch', '-M', 'main'], { cwd: work });
  const port = new URL(ctx.base).port;
  await gitExec(['remote', 'add', 'origin', `http://alice:testpass123@127.0.0.1:${port}/alice/demo.git`], { cwd: work });
  await gitExec(['push', '-u', 'origin', 'main'], { cwd: work });

  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-clone-'));
  t.after(() => fs.rmSync(cloneDir, { recursive: true, force: true }));
  await gitExec(['clone', `${ctx.base}/alice/demo.git`, cloneDir]);
  assert.equal(fs.readFileSync(path.join(cloneDir, 'README.md'), 'utf8'), 'hello-gitgram\n');

  const page = await agent.get('/alice/demo');
  assert.equal(page.status, 200);
  assert.match(page.text, /README\.md/);
  assert.match(page.text, /hello-gitgram/);
  assert.match(page.text, /Scavvers Labs \/ MIT/);

  const file = await agent.get('/alice/demo/blob/main/README.md');
  assert.equal(file.status, 200);
  assert.match(file.text, /hello-gitgram/);

  const commits = await agent.get('/alice/demo/commits');
  assert.equal(commits.status, 200);
  assert.match(commits.text, /first commit/);

  const profile = await agent.get('/@alice');
  assert.equal(profile.status, 200);
  assert.match(profile.text, /demo/);

  const search = await request(ctx.app).get('/api/search/repos').query({ q: 'demo' });
  assert.equal(search.status, 200);
  assert.ok(search.body.some((repo) => repo.full_name === 'alice/demo' && repo.owner_name === 'alice'));
  const rendered = renderSearchResults(search.body);
  assert.match(rendered, /href="\/alice\/demo"/);
  assert.match(rendered, /<strong>demo<\/strong>/);

  const settings = await agent.get('/alice/demo/settings');
  assert.equal(settings.status, 200);
  const removed = await agent.post('/alice/demo/settings/delete').redirects(0).type('form').send({
    _csrf: csrfFrom(settings.text),
  });
  assert.equal(removed.status, 302);
  const gone = await agent.get('/alice/demo');
  assert.equal(gone.status, 404);
  assert.match(gone.text, /Page not found/);
});

test('login rate limit blocks repeated failures', async (t) => {
  const ctx = await start({ loginRateLimit: { maxFailures: 2, windowMs: 60 * 1000 } });
  t.after(() => ctx.close());
  const agent = request.agent(ctx.app);
  assert.equal((await register(agent, 'alice')).status, 302);
  const home = await agent.get('/');
  await agent.post('/logout').redirects(0).type('form').send({
    _csrf: csrfFrom(home.text),
  });
  const loginPage = await agent.get('/login');
  const token = csrfFrom(loginPage.text);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const failed = await agent.post('/login').type('form').send({
      username: 'alice',
      password: 'wrong-password',
      _csrf: token,
    });
    assert.equal(failed.status, 200);
    assert.match(failed.text, /Invalid credentials/);
  }
  const limited = await agent.post('/login').type('form').send({
    username: 'alice',
    password: 'testpass123',
    _csrf: token,
  });
  assert.equal(limited.status, 429);
  assert.match(limited.text, /Too many login attempts/);
});

test('production third-party notices omit devDependencies and copyleft', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
  const notices = collectProductionNotices(lock);
  const names = new Set(notices.map((entry) => entry.name));
  assert.ok(names.has('express'));
  assert.ok(names.has('better-sqlite3'));
  assert.equal(names.has('supertest'), false);
  assert.ok(notices.every((entry) => entry.version && entry.license));
  const flagged = notices.filter((entry) => licenseFlag(entry.license));
  assert.deepEqual(flagged, []);
  const published = fs.readFileSync(path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(published, /\| express \|/);
  assert.doesNotMatch(published, /supertest/);
  assert.match(published, /No GPL, AGPL, LGPL, or unknown license/);
});

test('search escapes names that bypass creation checks', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const agent = request.agent(ctx.app);
  assert.equal((await register(agent, 'bob')).status, 302);
  const user = ctx.app.locals.db.prepare('SELECT id FROM users WHERE username = ?').get('bob');
  ctx.app.locals.db.prepare(
    'INSERT INTO repositories (name, full_name, description, owner_id, private) VALUES (?, ?, ?, ?, 0)'
  ).run('<img src=x onerror=alert(1)>', 'bob/<img src=x onerror=alert(1)>', 'desc', user.id);
  const res = await request(ctx.app).get('/api/search/repos').query({ q: 'onerror' });
  assert.equal(res.status, 200);
  const html = renderSearchResults(res.body);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
