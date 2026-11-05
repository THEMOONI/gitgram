const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createApp } = require('../server');

const repoRoot = path.join(__dirname, '..', 'data', 'repos');

let seq = 0;

function unique(prefix) {
  seq += 1;
  return `${prefix}${process.pid}x${seq}z`;
}

function createTestContext() {
  const db = new Database(':memory:');
  const app = createApp(db);
  const server = http.createServer(app);
  const users = new Set();
  return { db, app, server, users };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function cleanupUsers(users) {
  for (const username of users) {
    fs.rmSync(path.join(repoRoot, username), { recursive: true, force: true });
  }
}

function storeCookies(jar, setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const cookie of list) {
    const pair = cookie.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

class Session {
  constructor(port) {
    this.port = port;
    this.jar = new Map();
  }

  request(method, reqPath, { headers = {}, body } = {}) {
    const cookie = [...this.jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
    const finalHeaders = { ...headers };
    if (cookie) finalHeaders.cookie = cookie;
    if (body != null && finalHeaders['content-length'] == null) {
      finalHeaders['content-length'] = Buffer.byteLength(body);
    }

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: this.port,
        method,
        path: reqPath,
        headers: finalHeaders,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          storeCookies(this.jar, res.headers['set-cookie']);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      req.on('error', reject);
      if (body != null) req.write(body);
      req.end();
    });
  }

  form(method, reqPath, fields) {
    const body = new URLSearchParams(fields).toString();
    return this.request(method, reqPath, {
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  }
}

function basic(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

module.exports = {
  unique,
  createTestContext,
  listen,
  close,
  cleanupUsers,
  Session,
  basic,
  repoRoot,
};
