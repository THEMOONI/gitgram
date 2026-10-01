const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { createApp, initDatabase } = require('../server');

const repoRoot = path.join(__dirname, '..', 'data', 'repos');

function applySetCookie(jar, setCookie) {
  const list = !setCookie ? [] : (Array.isArray(setCookie) ? setCookie : [setCookie]);
  for (const raw of list) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    const expires = /expires=([^;]+)/i.exec(raw);
    const maxAge = /max-age=([^;]+)/i.exec(raw);
    const expired = value.length === 0
      || (maxAge && Number(maxAge[1]) <= 0)
      || (expires && new Date(expires[1]).getTime() <= Date.now());
    if (expired) delete jar[name];
    else jar[name] = value;
  }
  return jar;
}

function request(app, { method = 'GET', path: urlPath = '/', headers = {}, body = null, jar = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const reqHeaders = { ...headers, Connection: 'close' };
      const cookie = Object.entries(jar).map(([key, value]) => key + '=' + value).join('; ');
      if (cookie) reqHeaders.Cookie = cookie;
      if (body != null) {
        if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
          reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        reqHeaders['Content-Length'] = Buffer.byteLength(body);
      }
      const req = http.request({
        method,
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        headers: reqHeaders,
        agent: false
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          server.close();
          applySetCookie(jar, res.headers['set-cookie']);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            jar
          });
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (body != null) req.write(body);
      req.end();
    });
    server.on('error', reject);
  });
}

function form(data) {
  return new URLSearchParams(data).toString();
}

function unique(prefix) {
  return prefix + crypto.randomBytes(4).toString('hex');
}

function basic(username, password) {
  return 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
}

function repoPath(username, name) {
  return path.join(repoRoot, username, name);
}

async function withApp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-'));
  const db = initDatabase(new Database(path.join(dir, 'app.db')));
  const createdUsers = new Set();
  const app = createApp(db, { sessionSecret: 'gitgram-test-secret' });
  const api = {
    app,
    db,
    request: (opts) => request(app, opts),
    trackUser(username) { createdUsers.add(username); },
    seedUser(username, password = 'password1') {
      createdUsers.add(username);
      const email = username + '@example.com';
      const hash = bcrypt.hashSync(password, 4);
      const info = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').run(username, email, hash);
      return { id: Number(info.lastInsertRowid), username, email, password };
    },
    seedRepo(owner, name, fields = {}) {
      const description = fields.description || '';
      const isPrivate = !!fields.isPrivate;
      const fullName = owner.username + '/' + name;
      const info = db.prepare(
        'INSERT INTO repositories (name, full_name, description, owner_id, private) VALUES (?, ?, ?, ?, ?)'
      ).run(name, fullName, description, owner.id, isPrivate ? 1 : 0);
      return { id: Number(info.lastInsertRowid), name, fullName, description, isPrivate };
    }
  };
  try {
    await fn(api);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const username of createdUsers) {
      fs.rmSync(path.join(repoRoot, username), { recursive: true, force: true });
    }
  }
}

async function login(api, user, jar = {}) {
  const res = await api.request({
    method: 'POST',
    path: '/login',
    body: form({ username: user.username, password: user.password }),
    jar
  });
  if (res.status !== 302) {
    throw new Error('login failed with status ' + res.status);
  }
  return jar;
}

function pushCommits(barePath, commits) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-work-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Ada Lovelace',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_COMMITTER_NAME: 'Ada Lovelace',
    GIT_COMMITTER_EMAIL: 'ada@example.com'
  };
  const git = (args) => execFileSync('git', args, { cwd: work, env, stdio: 'pipe' });
  try {
    git(['init', '-b', 'main', work]);
    git(['remote', 'add', 'origin', barePath]);
    for (const commit of commits) {
      for (const [rel, content] of Object.entries(commit.files)) {
        const dest = path.join(work, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
      }
      git(['add', '-A']);
      git(['-c', 'commit.gpgsign=false', 'commit', '-m', commit.message]);
    }
    git(['push', 'origin', 'HEAD:main']);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = {
  withApp,
  login,
  form,
  basic,
  unique,
  repoPath,
  pushCommits,
  repoRoot
};
