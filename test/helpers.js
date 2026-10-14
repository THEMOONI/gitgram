const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const bcrypt = require('bcryptjs');

// The cloud image signs commits and enables fsmonitor globally. Both make
// git commands in this process (and in the server's children) hang or drop
// the next HTTP request. Override them for the test process only.
process.env.GIT_CONFIG_COUNT = '2';
process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign';
process.env.GIT_CONFIG_VALUE_0 = 'false';
process.env.GIT_CONFIG_KEY_1 = 'core.fsmonitor';
process.env.GIT_CONFIG_VALUE_1 = 'false';

const { createApp, openDatabase } = require('../server');

const REPOS_ROOT = path.join(__dirname, '..', 'data', 'repos');

function gitEnv(extra = {}) {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extra };
}

function runGit(args, options = {}) {
  try {
    const output = execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv(),
      ...options,
    });
    return String(output || '').trim();
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';
    throw new Error(`git ${args.join(' ')} failed: ${stderr || stdout || err.message}`);
  }
}

function gitAsync(args, options = {}) {
  const env = options.env || gitEnv();
  return new Promise((resolve, reject) => {
    execFile('git', args, { encoding: 'utf8', ...options, env }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        err.message = `git ${args.join(' ')} failed: ${stderr || err.message}`;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-'));
  const db = openDatabase(path.join(dir, 'app.db'));
  const app = createApp(db);
  const server = http.createServer(app);
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 130000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (err) {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const { port } = server.address();
  return {
    dir,
    db,
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    usernames: new Set(),
  };
}

async function close(ctx) {
  if (!ctx) return;
  await new Promise((resolve) => {
    if (typeof ctx.server.closeAllConnections === 'function') ctx.server.closeAllConnections();
    ctx.server.close(() => resolve());
  });
  try { ctx.db.close(); } catch { /* already closed */ }
  fs.rmSync(ctx.dir, { recursive: true, force: true });
  for (const username of ctx.usernames) {
    fs.rmSync(path.join(REPOS_ROOT, username), { recursive: true, force: true });
  }
}

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await close(ctx);
  }
}

class Session {
  constructor(ctx) {
    this.ctx = ctx;
    this.base = ctx.base;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
    for (const raw of list) {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const expired = /expires=thu, 01 jan 1970/i.test(raw) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async fetch(pathname, options = {}) {
    const headers = new Headers(options.headers || {});
    const cookie = this.cookieHeader();
    if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
    const { signal, ...rest } = options;
    const res = await fetch(this.base + pathname, {
      redirect: 'manual',
      ...rest,
      headers,
      signal: signal || AbortSignal.timeout(20000),
    });
    this.absorb(res);
    return res;
  }
}

async function readBody(res) {
  const text = await res.text();
  return {
    status: res.status,
    text,
    location: res.headers.get('location'),
    type: res.headers.get('content-type'),
    res,
  };
}

async function getText(session, pathname, options) {
  return readBody(await session.fetch(pathname, options));
}

async function postForm(session, pathname, fields) {
  return readBody(await session.fetch(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  }));
}

async function getJson(session, pathname) {
  const body = await getText(session, pathname);
  try {
    body.json = JSON.parse(body.text);
  } catch {
    body.json = undefined;
  }
  return body;
}

async function register(session, { username, email, password }) {
  if (username) session.ctx.usernames.add(username);
  return postForm(session, '/register', { username, email, password });
}

async function login(session, username, password) {
  return postForm(session, '/login', { username, password });
}

async function createRepo(session, { name, description = '', isPrivate = false }) {
  const fields = { name, description };
  if (isPrivate) fields.is_private = '1';
  return postForm(session, '/new', fields);
}

function passwordHash(ctx, username) {
  const row = ctx.db.prepare('SELECT password FROM users WHERE username = ?').get(username);
  return row ? row.password : undefined;
}

function userId(ctx, username) {
  const row = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  return row ? row.id : undefined;
}

function counts(ctx) {
  return {
    users: ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    repos: ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n,
  };
}

function repoRow(ctx, fullName) {
  return ctx.db.prepare('SELECT * FROM repositories WHERE full_name = ?').get(fullName);
}

function setUpdatedAt(ctx, fullName, stamp) {
  ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE full_name = ?').run(stamp, fullName);
}

async function waitForUpdatedAt(ctx, fullName, previous, timeoutMs = 2000) {
  const started = Date.now();
  let current = getUpdatedAt(ctx, fullName);
  while (current === previous && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = getUpdatedAt(ctx, fullName);
  }
  return current;
}

function getUpdatedAt(ctx, fullName) {
  const row = repoRow(ctx, fullName);
  return row ? row.updated_at : undefined;
}

function repoDisk(username, name) {
  return path.join(REPOS_ROOT, username, name);
}

function reposDir(username) {
  return path.join(REPOS_ROOT, username);
}

function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

function commitToBare(repoPath, spec) {
  const revisions = spec.revisions || [spec];
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-wt-'));
  try {
    runGit(['init', '-b', 'main'], { cwd: wt });
    runGit(['config', 'commit.gpgsign', 'false'], { cwd: wt });
    runGit(['config', 'core.fsmonitor', 'false'], { cwd: wt });
    runGit(['config', 'user.email', 'tester@example.com'], { cwd: wt });
    runGit(['config', 'user.name', 'Tester'], { cwd: wt });
    if (fs.existsSync(repoPath)) {
      runGit(['--git-dir', repoPath, 'config', 'core.fsmonitor', 'false']);
    }
    let branch = 'main';
    for (const rev of revisions) {
      if (rev.branch && rev.branch !== branch) {
        runGit(['checkout', '-B', rev.branch], { cwd: wt });
        branch = rev.branch;
      }
      for (const file of rev.remove || []) {
        fs.rmSync(path.join(wt, file), { force: true });
      }
      for (const [name, content] of Object.entries(rev.files || {})) {
        const full = path.join(wt, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
      runGit(['add', '-A'], { cwd: wt });
      const env = gitEnv();
      if (rev.author) {
        env.GIT_AUTHOR_NAME = rev.author;
        env.GIT_COMMITTER_NAME = rev.author;
      }
      if (rev.email) {
        env.GIT_AUTHOR_EMAIL = rev.email;
        env.GIT_COMMITTER_EMAIL = rev.email;
      }
      runGit(['commit', '--allow-empty', '-m', rev.message || 'update'], { cwd: wt, env });
    }
    runGit(['remote', 'add', 'origin', repoPath], { cwd: wt });
    runGit(['push', 'origin', '--all'], { cwd: wt });
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

function insertRepo(ctx, { username, name, description = '', isPrivate = 0, updatedAt = '2020-01-01 00:00:00' }) {
  const id = userId(ctx, username);
  ctx.db.prepare(
    'INSERT INTO repositories (name, full_name, description, owner_id, private, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, `${username}/${name}`, description, id, isPrivate, updatedAt);
}

function locationPath(location) {
  if (!location) return '';
  const url = new URL(location, 'http://127.0.0.1');
  return decodeURIComponent(url.pathname);
}

function passwordMatches(password, hash) {
  return bcrypt.compareSync(password, hash);
}

module.exports = {
  bcrypt,
  basicAuth,
  close,
  commitToBare,
  counts,
  createRepo,
  getJson,
  getText,
  getUpdatedAt,
  gitAsync,
  gitEnv,
  insertRepo,
  locationPath,
  login,
  passwordHash,
  passwordMatches,
  postForm,
  readBody,
  register,
  repoDisk,
  repoRow,
  reposDir,
  runGit,
  Session,
  setUpdatedAt,
  start,
  waitForUpdatedAt,
  userId,
  withApp,
};
