const { createApp, initDatabase } = require('../server');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', 'data', 'repos');

function uniqueId() {
  return crypto.randomBytes(6).toString('hex');
}

async function createTestContext() {
  const db = new Database(':memory:');
  initDatabase(db);
  const app = createApp(db);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return { db, app, server, cleanupPaths: [] };
}

function closeTestContext(ctx) {
  for (const target of ctx.cleanupPaths) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  return new Promise((resolve, reject) => {
    ctx.server.close((err) => {
      ctx.db.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

class Agent {
  constructor(server) {
    this.server = server;
    this.cookies = new Map();
  }

  async request(method, urlPath, { form, headers, body } = {}) {
    const address = this.server.address();
    const reqHeaders = { connection: 'close', ...(headers || {}) };
    const cookie = [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
    if (cookie) reqHeaders.cookie = cookie;

    let payload;
    if (form) {
      payload = new URLSearchParams(form).toString();
      reqHeaders['content-type'] = 'application/x-www-form-urlencoded';
    } else if (body !== undefined) {
      payload = body;
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${urlPath}`, {
      method,
      headers: reqHeaders,
      body: payload,
      redirect: 'manual',
    });
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const cookieHeader of setCookies) {
      const pair = cookieHeader.split(';')[0];
      const separator = pair.indexOf('=');
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      headers: response.headers,
      buffer,
      text: buffer.toString('utf8'),
    };
  }
}

async function registerUser(agent, fields) {
  const username = fields.username || `user${uniqueId()}`;
  const email = fields.email || `${username}@example.com`;
  const password = fields.password || 'correct-horse';
  const response = await agent.request('POST', '/register', {
    form: { username, email, password },
  });
  return { response, username, email, password };
}

function trackRepo(ctx, username) {
  ctx.cleanupPaths.push(path.join(repoRoot, username));
}

function seedBareRepo(repoPath, { files, message, authorName, authorEmail }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-work-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: work });
    execFileSync('git', ['config', 'user.email', authorEmail], { cwd: work });
    execFileSync('git', ['config', 'user.name', authorName], { cwd: work });
    for (const file of files) {
      const destination = path.join(work, file.name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content);
    }
    execFileSync('git', ['add', '.'], { cwd: work });
    execFileSync('git', ['commit', '-m', message], { cwd: work });
    fs.rmSync(repoPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    execFileSync('git', ['clone', '--bare', work, repoPath]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function repoPathFor(username, name) {
  return path.join(repoRoot, username, name);
}

module.exports = {
  Agent,
  closeTestContext,
  createTestContext,
  registerUser,
  repoPathFor,
  seedBareRepo,
  trackRepo,
  uniqueId,
};
