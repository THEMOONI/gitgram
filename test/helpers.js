const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The cloud image signs commits and enables fsmonitor. A signing commit can
// block long enough for the next HTTP request to fail, and fsmonitor daemons
// outlive the test. Server-side git uses spawn(), so the flags have to be in
// the process environment before the app starts.
const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.fsmonitor',
  GIT_CONFIG_VALUE_1: 'false',
};
for (const key of ['GIT_TERMINAL_PROMPT', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1']) {
  process.env[key] = gitEnv[key];
}

const { createApp, openDatabase } = require('../server');

const reposRoot = path.join(__dirname, '..', 'data', 'repos');

class Session {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  async fetch(pathname, options = {}) {
    const headers = new Headers(options.headers || {});
    if (this.cookies.size > 0 && !headers.has('cookie')) {
      headers.set('cookie', [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; '));
    }
    const res = await fetch(this.base + pathname, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      redirect: options.redirect ?? 'manual',
      signal: options.signal ?? AbortSignal.timeout(options.timeout ?? 20000),
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const part = raw.split(';')[0];
      const eq = part.indexOf('=');
      if (eq > 0) this.cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    return res;
  }

  postForm(pathname, fields) {
    return this.fetch(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  }
}

function gitSync(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    env: options.env || gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? 15000,
  });
}

function runGit(args, options = {}) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: options.cwd,
      env: options.env || gitEnv,
      encoding: 'utf8',
      timeout: options.timeout ?? 20000,
      killSignal: 'SIGKILL',
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        errorCode: err ? err.code : 0,
        signal: err ? err.signal : undefined,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

function barePath(username, repo) {
  return path.join(reposRoot, username, repo);
}

function commitToBare(repoPath, spec) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-wt-'));
  const hashes = [];
  try {
    gitSync(['init', '-b', 'main'], { cwd: work });
    gitSync(['config', 'commit.gpgsign', 'false'], { cwd: work });
    gitSync(['config', 'core.fsmonitor', 'false'], { cwd: work });
    gitSync(['config', 'user.email', 'ada@example.com'], { cwd: work });
    gitSync(['config', 'user.name', 'Ada'], { cwd: work });
    gitSync(['--git-dir', repoPath, 'config', 'core.fsmonitor', 'false']);
    const revisions = spec.revisions || [{
      files: spec.files || {},
      message: spec.message || 'update',
      remove: spec.remove,
      author: spec.author,
      email: spec.email,
    }];
    for (const rev of revisions) {
      for (const [name, content] of Object.entries(rev.files || {})) {
        const full = path.join(work, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
      for (const name of rev.remove || []) {
        fs.rmSync(path.join(work, name), { recursive: true, force: true });
      }
      gitSync(['add', '-A'], { cwd: work });
      const author = rev.author || 'Ada';
      const email = rev.email || 'ada@example.com';
      gitSync(['commit', '-m', rev.message || 'update'], {
        cwd: work,
        env: {
          ...gitEnv,
          GIT_AUTHOR_NAME: author,
          GIT_AUTHOR_EMAIL: email,
          GIT_COMMITTER_NAME: author,
          GIT_COMMITTER_EMAIL: email,
        },
      });
      hashes.push(gitSync(['rev-parse', 'HEAD'], { cwd: work }).trim());
    }
    gitSync(['remote', 'add', 'origin', repoPath], { cwd: work });
    gitSync(['push', 'origin', `HEAD:refs/heads/${spec.branch || 'main'}`], { cwd: work });
    return hashes;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function pushFiles({ url, files, message, force = false }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-push-'));
  try {
    gitSync(['init', '-b', 'main'], { cwd: work });
    gitSync(['config', 'commit.gpgsign', 'false'], { cwd: work });
    gitSync(['config', 'core.fsmonitor', 'false'], { cwd: work });
    gitSync(['config', 'user.email', 'ada@example.com'], { cwd: work });
    gitSync(['config', 'user.name', 'Ada'], { cwd: work });
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(work, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    gitSync(['add', '-A'], { cwd: work });
    gitSync(['commit', '-m', message], { cwd: work });
    const args = ['push'];
    if (force) args.push('--force');
    args.push(url, 'HEAD:refs/heads/main');
    return await runGit(args, { cwd: work, timeout: 20000 });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

function passwordHash(db, username) {
  const row = db.prepare('SELECT password FROM users WHERE username = ?').get(username);
  return row ? row.password : undefined;
}

function repoRow(db, fullName) {
  return db.prepare('SELECT * FROM repositories WHERE full_name = ?').get(fullName);
}

function insertRepo(db, { ownerId, username, name, description = '', isPrivate = 0, updatedAt = '2020-06-01 00:00:00' }) {
  db.prepare(`INSERT INTO repositories (name, full_name, description, owner_id, private, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    name,
    `${username}/${name}`,
    description,
    ownerId,
    isPrivate ? 1 : 0,
    updatedAt
  );
}

function setUpdatedAt(db, fullName, stamp) {
  db.prepare('UPDATE repositories SET updated_at = ? WHERE full_name = ?').run(stamp, fullName);
  return stamp;
}

async function waitForUpdatedAt(db, fullName, previous, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = repoRow(db, fullName);
    if (row && row.updated_at !== previous) return row.updated_at;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return repoRow(db, fullName)?.updated_at;
}

async function assertUpdatedAtStays(db, fullName, expected, ms = 300) {
  const start = Date.now();
  do {
    assert.equal(repoRow(db, fullName).updated_at, expected);
    if (Date.now() - start >= ms) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() - start < ms);
}

function remoteUrl(ctx, username, repo, password) {
  const user = encodeURIComponent(username);
  const repoName = encodeURIComponent(repo);
  const auth = password == null ? '' : `${user}:${encodeURIComponent(password)}@`;
  return `http://${auth}127.0.0.1:${ctx.port}/${user}/${repoName}.git`;
}

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-db-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const app = createApp(db);
  const server = app.listen(0, '127.0.0.1');
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const users = new Set();
  let seq = 0;
  return {
    db,
    server,
    port,
    base,
    dir,
    users,
    session() {
      return new Session(base);
    },
    nextId(prefix = 'user') {
      seq += 1;
      return `${prefix}${seq}`;
    },
    usernameOfLength(length) {
      seq += 1;
      const core = `u${seq.toString(36)}`;
      if (core.length > length) throw new Error(`cannot build a username of length ${length}`);
      return core.padEnd(length, 'x');
    },
    async close() {
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
      for (const username of users) {
        fs.rmSync(path.join(reposRoot, username), { recursive: true, force: true });
      }
    },
  };
}

async function registerUser(ctx, session, overrides = {}) {
  const username = overrides.username || ctx.nextId('user');
  const email = overrides.email || `${username}@example.test`;
  const password = overrides.password ?? 'correct-horse';
  ctx.users.add(username);
  const res = await session.postForm('/register', { username, email, password });
  const text = await res.text();
  if (res.status !== 302) {
    throw new Error(`register ${username} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  const row = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  return { username, email, password, id: row.id };
}

async function createRepo(session, { name, description = '', isPrivate = false }) {
  const fields = { name, description };
  if (isPrivate) fields.is_private = '1';
  const res = await session.postForm('/new', fields);
  const text = await res.text();
  if (res.status !== 302) {
    throw new Error(`createRepo ${name} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return { status: res.status, location: res.headers.get('location'), text };
}

async function readText(res) {
  return { status: res.status, headers: res.headers, text: await res.text() };
}

module.exports = {
  Session,
  assertUpdatedAtStays,
  barePath,
  basicAuth,
  commitToBare,
  createRepo,
  gitSync,
  insertRepo,
  passwordHash,
  pushFiles,
  readText,
  registerUser,
  remoteUrl,
  repoRow,
  reposRoot,
  runGit,
  setUpdatedAt,
  start,
  waitForUpdatedAt,
};
