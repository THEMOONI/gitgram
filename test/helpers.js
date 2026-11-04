const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { createApp } = require('../server');

const REPOS_ROOT = path.join(__dirname, '..', 'data', 'repos');

function nid(prefix) {
  return prefix + crypto.randomBytes(4).toString('hex');
}

function createTestApp() {
  const db = new Database(':memory:');
  const app = createApp(db, { sessionSecret: 'gitgram-test-secret', port: 3000 });
  app.set('env', 'test');
  return { app, db };
}

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

class Client {
  constructor(server) {
    const { port } = server.address();
    this.base = 'http://127.0.0.1:' + port;
    this.cookies = new Map();
  }

  async request(method, urlPath, { form, body, headers = {}, raw = false } = {}) {
    const headersOut = { ...headers };
    let payload;
    if (form) {
      payload = new URLSearchParams(form).toString();
      if (!headersOut['Content-Type'] && !headersOut['content-type']) {
        headersOut['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    } else if (body != null) {
      payload = body;
    }
    if (this.cookies.size) {
      headersOut.Cookie = [...this.cookies.entries()].map(([name, value]) => name + '=' + value).join('; ');
    }

    const res = await fetch(new URL(urlPath, this.base), {
      method,
      headers: headersOut,
      body: payload,
      redirect: 'manual',
    });

    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const cookie of setCookies) {
      const pair = cookie.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      if (!value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }

    const location = res.headers.get('location');
    if (raw) {
      return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()), location };
    }
    return { status: res.status, headers: res.headers, text: await res.text(), location };
  }

  get(urlPath, opts) {
    return this.request('GET', urlPath, opts);
  }

  post(urlPath, form, opts = {}) {
    return this.request('POST', urlPath, { ...opts, form });
  }
}

function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(username + ':' + password, 'utf8').toString('base64');
}

function repoPath(owner, name) {
  return path.join(REPOS_ROOT, owner, name);
}

function removeOwner(owner) {
  fs.rmSync(path.join(REPOS_ROOT, owner), { recursive: true, force: true });
}

function commitFiles(owner, name, commits) {
  const gitDir = repoPath(owner, name);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Ada Lovelace',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_COMMITTER_NAME: 'Ada Lovelace',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const commit of commits) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-'));
    try {
      for (const file of commit.files) {
        const dest = path.join(work, file.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, file.content);
      }
      const git = ['--git-dir', gitDir, '--work-tree', work, '-c', 'core.bare=false'];
      execFileSync('git', [...git, 'add', '--', ...commit.files.map((file) => file.path)], { env });
      execFileSync('git', [...git, 'commit', '-m', commit.message], { env });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}

function json(res) {
  return JSON.parse(res.text);
}

module.exports = {
  nid,
  createTestApp,
  listen,
  close,
  Client,
  basicAuth,
  repoPath,
  removeOwner,
  commitFiles,
  json,
};
