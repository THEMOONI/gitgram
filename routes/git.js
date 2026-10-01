const express = require('express');
const fs = require('fs');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const { isValidUsername, isValidRepoName, cleanRepoName, resolveRepoPath } = require('../lib/validate');
const { gitEnv } = require('../lib/git');

module.exports = function(db, options) {
  const router = express.Router();
  const dataDir = options.dataDir;

  function findRepo(owner, repoName) {
    return db.prepare('SELECT * FROM repositories WHERE full_name = ?').get(owner + '/' + repoName);
  }

  function readBasicAuth(req) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Basic ')) return null;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator === -1) return { username: decoded, password: '' };
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  }

  function authenticate(req, res, next) {
    const credentials = readBasicAuth(req);
    if (!credentials) {
      res.setHeader('WWW-Authenticate', 'Basic realm="GITGRAM"');
      return res.status(401).send('Authentication required');
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(credentials.username);
    if (!user || !bcrypt.compareSync(credentials.password, user.password)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="GITGRAM"');
      return res.status(401).send('Invalid credentials');
    }
    req.gitUser = user;
    next();
  }

  function optionalAuthenticate(req, res, next) {
    if (!req.headers.authorization) return next();
    return authenticate(req, res, next);
  }

  function loadRepo(req, res) {
    const repoName = cleanRepoName(req.params.repo);
    if (!isValidUsername(req.params.owner) || !isValidRepoName(repoName)) {
      res.status(404).send('Not found');
      return null;
    }
    const repo = findRepo(req.params.owner, repoName);
    if (!repo) {
      res.status(404).send('Not found');
      return null;
    }
    const repoPath = resolveRepoPath(dataDir, req.params.owner, repoName);
    if (!repoPath || !fs.existsSync(repoPath)) {
      res.status(404).send('Not found');
      return null;
    }
    return { repo, repoPath };
  }

  function canRead(req, repo) {
    if (!repo.private) return true;
    return !!(req.gitUser && req.gitUser.id === repo.owner_id);
  }

  function denyRead(res) {
    res.setHeader('WWW-Authenticate', 'Basic realm="GITGRAM"');
    res.status(401).send('Authentication required');
  }

  function spawnGit(res, args) {
    const proc = spawn('git', args, { stdio: ['pipe', 'pipe', 'ignore'], env: gitEnv() });
    proc.stdin.on('error', () => {});
    proc.stdout.on('error', () => {});
    proc.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    res.on('close', () => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    });
    return proc;
  }

  router.get('/:owner/:repo/info/refs', optionalAuthenticate, (req, res) => {
    const service = req.query.service;
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return res.status(400).send('Invalid service');
    }
    const loaded = loadRepo(req, res);
    if (!loaded) return;
    if (!canRead(req, loaded.repo)) return denyRead(res);
    const gitCommand = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
    const proc = spawnGit(res, [gitCommand, '--stateless-rpc', '--advertise-refs', '--', loaded.repoPath]);
    res.setHeader('Content-Type', 'application/x-' + service + '-advertisement');
    res.setHeader('Cache-Control', 'no-cache');
    const header = '# service=' + service + '\n';
    const headerLen = (header.length + 4).toString(16).padStart(4, '0');
    res.write(headerLen);
    res.write(header);
    res.write('0000');
    proc.stdout.on('data', (chunk) => res.write(chunk));
    proc.on('close', () => res.end());
  });

  router.post('/:owner/:repo/git-upload-pack', optionalAuthenticate, (req, res) => {
    const loaded = loadRepo(req, res);
    if (!loaded) return;
    if (!canRead(req, loaded.repo)) return denyRead(res);
    const proc = spawnGit(res, ['upload-pack', '--stateless-rpc', '--', loaded.repoPath]);
    res.setHeader('Content-Type', 'application/x-git-upload-pack-result');
    req.pipe(proc.stdin);
    proc.stdout.pipe(res);
  });

  router.post('/:owner/:repo/git-receive-pack', authenticate, (req, res) => {
    const loaded = loadRepo(req, res);
    if (!loaded) return;
    if (req.gitUser.id !== loaded.repo.owner_id) return res.status(403).send('Permission denied');
    const proc = spawnGit(res, ['receive-pack', '--stateless-rpc', '--', loaded.repoPath]);
    res.setHeader('Content-Type', 'application/x-git-receive-pack-result');
    req.pipe(proc.stdin);
    proc.stdout.pipe(res);
    proc.on('close', () => {
      db.prepare('UPDATE repositories SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(loaded.repo.id);
    });
  });

  return router;
};
