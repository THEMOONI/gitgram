const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

let server;
let baseUrl;
let workDir;

function git(args, options = {}) {
  return spawnSync('git', args, {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    ...options,
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        PORT: '0',
        NODE_ENV: 'test',
        SESSION_SECRET: 'test-secret',
        GITGRAM_DATA_DIR: path.join(workDir, 'data'),
        GITGRAM_DB_PATH: path.join(workDir, 'db', 'test.db'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => reject(new Error('server did not start in time')), 15000);
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const match = buffered.match(/http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: `http://localhost:${match[1]}` });
      }
    });
    child.on('error', reject);
  });
}

// Minimal cookie jar: enough to carry a single session cookie per user.
function createClient() {
  let cookie = null;
  return async function request(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(baseUrl + pathname, { redirect: 'manual', ...options, headers });
    const setCookie = response.headers.getSetCookie?.() || [];
    if (setCookie.length > 0) cookie = setCookie.map((value) => value.split(';')[0]).join('; ');
    return response;
  };
}

function form(fields) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

const ALICE = { username: 'alice', email: 'alice@example.com', password: 'alicepassword' };
const MALLORY = { username: 'mallory', email: 'mallory@example.com', password: 'mallorypassword' };

let alice;
let mallory;

test.before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-test-'));
  const started = await startServer();
  server = started.child;
  baseUrl = started.url;

  alice = createClient();
  mallory = createClient();
  await alice('/register', form(ALICE));
  await mallory('/register', form(MALLORY));
  await alice('/new', form({ name: 'public-repo', description: 'a public repo' }));
  await alice('/new', form({ name: 'private-repo', is_private: '1' }));

  // A source repository with one commit, including a nested file, to push up.
  const source = path.join(workDir, 'source');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(source, 'src', 'app.js'), 'console.log("hi");\n');
  git(['init', '-q', '-b', 'main'], { cwd: source });
  git(['config', 'user.email', 'alice@example.com'], { cwd: source });
  git(['config', 'user.name', 'Alice'], { cwd: source });
  git(['add', '-A'], { cwd: source });
  git(['commit', '-q', '-m', 'initial commit'], { cwd: source });

  const authority = baseUrl.replace('http://', '');
  ['public-repo', 'private-repo'].forEach((repo) => {
    const push = git(
      ['push', '-q', `http://${ALICE.username}:${ALICE.password}@${authority}/alice/${repo}.git`, 'main'],
      { cwd: source }
    );
    assert.strictEqual(push.status, 0, `push to ${repo} failed: ${push.stderr}`);
  });
});

test.after(() => {
  if (server) server.kill('SIGTERM');
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test('a missing page renders the 404 view without leaking a stack trace', async () => {
  const response = await fetch(baseUrl + '/@nobody');
  const body = await response.text();
  assert.strictEqual(response.status, 404);
  assert.match(body, /Page not found/);
  assert.doesNotMatch(body, /at Function|node_modules/);
});

test('an unknown route is handled by the catch-all 404', async () => {
  const response = await fetch(baseUrl + '/no/such/route/at/all');
  assert.strictEqual(response.status, 404);
  assert.match(await response.text(), /Page not found/);
});

test('a shell metacharacter in a ref does not execute a command', async () => {
  const marker = path.join(workDir, 'PWNED');
  const ref = encodeURIComponent(`main;touch ${marker};`);
  const response = await fetch(`${baseUrl}/alice/public-repo/blob/${ref}/README.md`);
  assert.strictEqual(response.status, 404);
  assert.strictEqual(fs.existsSync(marker), false, 'injected command was executed');
});

test('a traversing repository name is rejected and creates nothing on disk', async () => {
  const escaped = path.join(workDir, 'ESCAPED');
  const response = await alice('/new', form({ name: `../../${path.basename(escaped)}` }));
  assert.strictEqual(response.status, 400);
  assert.strictEqual(fs.existsSync(escaped), false);
});

test('a username that is not filesystem-safe is rejected', async () => {
  const response = await fetch(
    baseUrl + '/register',
    form({ username: 'ev/il', email: 'ev@example.com', password: 'evilpassword' })
  );
  assert.strictEqual(response.status, 400);
});

test('a short password is rejected', async () => {
  const response = await fetch(
    baseUrl + '/register',
    form({ username: 'shorty', email: 's@example.com', password: 'short' })
  );
  assert.strictEqual(response.status, 400);
});

test('a nested file is viewable', async () => {
  const response = await fetch(baseUrl + '/alice/public-repo/blob/main/src/app.js');
  assert.strictEqual(response.status, 200);
  assert.match(await response.text(), /console\.log/);
});

test('a directory renders a tree listing', async () => {
  const response = await fetch(baseUrl + '/alice/public-repo/tree/main/src');
  assert.strictEqual(response.status, 200);
  assert.match(await response.text(), /app\.js/);
});

test('a blob URL pointing at a directory redirects to the tree view', async () => {
  const response = await fetch(baseUrl + '/alice/public-repo/blob/main/src', {
    redirect: 'manual',
  });
  assert.strictEqual(response.status, 302);
  assert.match(response.headers.get('location'), /\/tree\/main\/src$/);
});

test('a private repository is hidden from anonymous web visitors', async () => {
  const response = await fetch(baseUrl + '/alice/private-repo');
  assert.strictEqual(response.status, 404);
});

test('a private repository is hidden from a signed-in non-owner', async () => {
  const response = await mallory('/alice/private-repo');
  assert.strictEqual(response.status, 404);
});

test('the owner can view their own private repository', async () => {
  const response = await alice('/alice/private-repo');
  assert.strictEqual(response.status, 200);
});

test('a public repository can be cloned anonymously', async () => {
  const target = path.join(workDir, 'clone-public');
  const result = git(['clone', '-q', `${baseUrl}/alice/public-repo.git`, target]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(fs.existsSync(path.join(target, 'src', 'app.js')), true);
});

test('a private repository cannot be cloned anonymously', async () => {
  const target = path.join(workDir, 'clone-private-anon');
  const result = git(['clone', '-q', `${baseUrl}/alice/private-repo.git`, target]);
  assert.notStrictEqual(result.status, 0, 'anonymous clone of a private repo succeeded');
  assert.strictEqual(fs.existsSync(target), false);
});

test('a private repository cannot be cloned by an authenticated non-owner', async () => {
  const authority = baseUrl.replace('http://', '');
  const target = path.join(workDir, 'clone-private-mallory');
  const result = git([
    'clone',
    '-q',
    `http://${MALLORY.username}:${MALLORY.password}@${authority}/alice/private-repo.git`,
    target,
  ]);
  assert.notStrictEqual(result.status, 0);
  assert.strictEqual(fs.existsSync(target), false);
});

test('the owner can clone their own private repository', async () => {
  const authority = baseUrl.replace('http://', '');
  const target = path.join(workDir, 'clone-private-owner');
  const result = git([
    'clone',
    '-q',
    `http://${ALICE.username}:${ALICE.password}@${authority}/alice/private-repo.git`,
    target,
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(fs.existsSync(path.join(target, 'README.md')), true);
});

test('a non-owner cannot push to someone else\'s repository', async () => {
  const authority = baseUrl.replace('http://', '');
  const source = path.join(workDir, 'source');
  const result = git(
    [
      'push',
      `http://${MALLORY.username}:${MALLORY.password}@${authority}/alice/public-repo.git`,
      'main',
    ],
    { cwd: source }
  );
  assert.notStrictEqual(result.status, 0, 'non-owner push succeeded');
});

test('an anonymous push is rejected', async () => {
  const source = path.join(workDir, 'source');
  const result = git(['push', `${baseUrl}/alice/public-repo.git`, 'main'], { cwd: source });
  assert.notStrictEqual(result.status, 0, 'anonymous push succeeded');
});

test('repository search escapes LIKE wildcards', async () => {
  const wildcard = await fetch(baseUrl + '/api/search/repos?q=%25');
  assert.deepStrictEqual(await wildcard.json(), []);

  const real = await fetch(baseUrl + '/api/search/repos?q=public');
  const results = await real.json();
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].full_name, 'alice/public-repo');
});

test('search results never include private repositories', async () => {
  const response = await fetch(baseUrl + '/api/search/repos?q=repo');
  const results = await response.json();
  assert.ok(results.every((repo) => repo.full_name !== 'alice/private-repo'));
});
