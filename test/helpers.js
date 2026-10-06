const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes } = require('crypto');
const { execFileSync } = require('child_process');
const assert = require('node:assert/strict');
const { createApp, openDatabase } = require('../server');

function uid(prefix) {
  return prefix + randomBytes(4).toString('hex');
}

function repoDiskPath(username, repo) {
  return path.join(__dirname, '..', 'data', 'repos', username, repo);
}

class Session {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.jar = new Map();
  }

  cookieHeader() {
    return [...this.jar.entries()].map(([name, value]) => name + '=' + value).join('; ');
  }

  absorb(response) {
    const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async fetch(urlPath, options = {}) {
    const headers = new Headers(options.headers || {});
    const cookie = this.cookieHeader();
    if (cookie) headers.set('cookie', cookie);
    const response = await fetch(this.baseUrl + urlPath, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      redirect: 'manual'
    });
    this.absorb(response);
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  }

  postForm(urlPath, fields) {
    return this.fetch(urlPath, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString()
    });
  }
}

async function createTestContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const app = createApp(db);
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const users = new Set();

  return {
    db,
    baseUrl,
    users,
    session() {
      return new Session(baseUrl);
    },
    async close() {
      await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
      for (const username of users) {
        fs.rmSync(path.join(__dirname, '..', 'data', 'repos', username), { recursive: true, force: true });
      }
    }
  };
}

async function registerUser(ctx, overrides = {}) {
  const username = overrides.username || uid('user');
  const email = overrides.email || username + '@example.com';
  const password = overrides.password || 'correct-horse';
  ctx.users.add(username);
  const session = ctx.session();
  const res = await session.postForm('/register', { username, email, password });
  return { username, email, password, session, res };
}

function assertStatus(res, status) {
  assert.equal(res.status, status, 'expected ' + status + ', got ' + res.status + ': ' + res.text.slice(0, 400));
}

function commitToBare(repoPath, { message, authorName, authorEmail, files, revisions }) {
  const commits = revisions || [{ message, files }];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-work-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: work, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', authorEmail], { cwd: work, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', authorName], { cwd: work, stdio: 'pipe' });
    for (const rev of commits) {
      for (const [name, content] of Object.entries(rev.files)) {
        const filePath = path.join(work, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
      }
      execFileSync('git', ['add', '.'], { cwd: work, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', rev.message], { cwd: work, stdio: 'pipe' });
    }
    execFileSync('git', ['remote', 'add', 'origin', repoPath], { cwd: work, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: work, stdio: 'pipe' });
    return execFileSync('git', ['--git-dir', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function passwordHash(ctx, username) {
  return ctx.db.prepare('SELECT password FROM users WHERE username = ?').get(username).password;
}

module.exports = {
  uid,
  repoDiskPath,
  createTestContext,
  registerUser,
  assertStatus,
  commitToBare,
  passwordHash
};
