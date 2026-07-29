const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');

module.exports = function(db) {
  function cleanRepo(name) { return name.replace(/\.git$/, ''); }
  function findRepo(owner, repoRaw) {
    const repo = cleanRepo(repoRaw);
    return db.prepare('SELECT * FROM repositories WHERE full_name = ?').get(owner + '/' + repo);
  }
  function getRepoPath(owner, repoRaw) {
    return path.join(__dirname, '..', 'data', 'repos', owner, cleanRepo(repoRaw));
  }

  function gitAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="GITGRAM"');
      return res.status(401).send('Authentication required');
    }
    const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
    const [username, password] = credentials.split(':');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="GITGRAM"');
      return res.status(401).send('Invalid credentials');
    }
    req.gitUser = user;
    next();
  }

  router.get('/:owner/:repo/info/refs', (req, res) => {
    const repoName = cleanRepo(req.params.repo);
    const service = req.query.service;
    if (!service || !['git-upload-pack', 'git-receive-pack'].includes(service)) return res.status(400).send('Invalid service');
    const repo = findRepo(req.params.owner, repoName);
    if (!repo) return res.status(404).send('Not found');
    const repoPath = getRepoPath(req.params.owner, repoName);
    if (!fs.existsSync(repoPath)) return res.status(404).send('Not found');
    const gitCommand = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
    const proc = spawn('git', [gitCommand, '--stateless-rpc', '--advertise-refs', repoPath]);
    res.setHeader('Content-Type', 'application/x-' + service + '-advertisement');
    res.setHeader('Cache-Control', 'no-cache');
    const header = '# service=' + service + '\n';
    const headerLen = (header.length + 4).toString(16).padStart(4, '0');
    res.write(headerLen); res.write(header); res.write('0000');
    proc.stdout.on('data', d => res.write(d));
    proc.on('close', () => res.end());
    proc.on('error', () => res.status(500).end());
  });

  router.post('/:owner/:repo/git-upload-pack', (req, res) => {
    const repoName = cleanRepo(req.params.repo);
    const repo = findRepo(req.params.owner, repoName);
    if (!repo) return res.status(404).send('Not found');
    const repoPath = getRepoPath(req.params.owner, repoName);
    const proc = spawn('git', ['upload-pack', '--stateless-rpc', repoPath]);
    res.setHeader('Content-Type', 'application/x-git-upload-pack-result');
    req.pipe(proc.stdin); proc.stdout.pipe(res);
    proc.on('error', () => res.status(500).end());
  });

  router.post('/:owner/:repo/git-receive-pack', gitAuth, (req, res) => {
    const repoName = cleanRepo(req.params.repo);
    const repo = findRepo(req.params.owner, repoName);
    if (!repo) return res.status(404).send('Not found');
    if (req.gitUser.id !== repo.owner_id) return res.status(403).send('Permission denied');
    const repoPath = getRepoPath(req.params.owner, repoName);
    const proc = spawn('git', ['receive-pack', '--stateless-rpc', repoPath]);
    res.setHeader('Content-Type', 'application/x-git-receive-pack-result');
    req.pipe(proc.stdin); proc.stdout.pipe(res);
    proc.on('close', () => { db.prepare('UPDATE repositories SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(repo.id); });
    proc.on('error', () => res.status(500).end());
  });

  return router;
};
