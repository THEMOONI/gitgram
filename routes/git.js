const express = require('express');
const router = express.Router();
const fs = require('fs');
const zlib = require('zlib');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const { isValidName, stripGitSuffix, repoPathFor } = require('../lib/paths');

const SERVICES = ['git-upload-pack', 'git-receive-pack'];

module.exports = function (db) {
  function findRepo(owner, repoRaw) {
    const repo = stripGitSuffix(repoRaw);
    if (!isValidName(owner) || !isValidName(repo)) return null;
    return db
      .prepare(
        `SELECT r.*, u.username as owner_name FROM repositories r
         JOIN users u ON r.owner_id = u.id WHERE r.full_name = ?`
      )
      .get(owner + '/' + repo);
  }

  function requestAuth(res, message) {
    res.setHeader('WWW-Authenticate', 'Basic realm="GITGRAM"');
    return res.status(401).send(message);
  }

  function authenticate(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) return null;
    const decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString();
    const separator = decoded.indexOf(':');
    if (separator === -1) return null;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password)) return null;
    return user;
  }

  // Reads need authentication only for private repositories; writes always do.
  // Private repos must not be distinguishable from missing ones to an
  // unauthorized client, so both cases return 404 once auth has been supplied.
  function authorize(req, res, { write }) {
    const repo = findRepo(req.params.owner, req.params.repo);
    const needsAuth = write || (repo && repo.private);

    let user = null;
    if (needsAuth || req.headers.authorization) {
      user = authenticate(req);
      if (needsAuth && !user) {
        requestAuth(res, 'Authentication required');
        return null;
      }
    }

    if (!repo) {
      res.status(404).send('Not found');
      return null;
    }
    if (repo.private && (!user || user.id !== repo.owner_id)) {
      res.status(404).send('Not found');
      return null;
    }
    if (write && user.id !== repo.owner_id) {
      res.status(403).send('Permission denied');
      return null;
    }

    const repoPath = repoPathFor(req.params.owner, req.params.repo);
    if (!repoPath || !fs.existsSync(repoPath)) {
      res.status(404).send('Not found');
      return null;
    }
    return { repo, repoPath };
  }

  function noCache(res) {
    res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', 'Fri, 01 Jan 1980 00:00:00 GMT');
  }

  function pktLine(payload) {
    const length = (payload.length + 4).toString(16).padStart(4, '0');
    return length + payload;
  }

  router.get('/:owner/:repo/info/refs', (req, res) => {
    const service = req.query.service;
    if (!SERVICES.includes(service)) return res.status(400).send('Invalid service');

    const authorized = authorize(req, res, { write: service === 'git-receive-pack' });
    if (!authorized) return;

    const subcommand = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
    const proc = spawn('git', [subcommand, '--stateless-rpc', '--advertise-refs', authorized.repoPath], {
      windowsHide: true,
    });

    noCache(res);
    res.setHeader('Content-Type', `application/x-${service}-advertisement`);
    res.write(pktLine(`# service=${service}\n`));
    res.write('0000');

    proc.stdout.pipe(res);
    proc.on('error', () => res.destroy());
  });

  // Git may compress the request body, so decompress before handing it to the
  // pack process rather than piping the raw stream through.
  function requestBodyStream(req) {
    if ((req.headers['content-encoding'] || '').includes('gzip')) {
      const gunzip = zlib.createGunzip();
      req.pipe(gunzip);
      return gunzip;
    }
    return req;
  }

  function servicePack(subcommand, service, write) {
    return (req, res) => {
      const authorized = authorize(req, res, { write });
      if (!authorized) return;

      const proc = spawn('git', [subcommand, '--stateless-rpc', authorized.repoPath], {
        windowsHide: true,
      });

      noCache(res);
      res.setHeader('Content-Type', `application/x-${service}-result`);

      requestBodyStream(req).pipe(proc.stdin);
      proc.stdout.pipe(res);
      proc.stdin.on('error', () => {});
      proc.on('error', () => res.destroy());
      proc.on('close', () => {
        if (write) {
          db.prepare('UPDATE repositories SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
            authorized.repo.id
          );
        }
      });
    };
  }

  router.post(
    '/:owner/:repo/git-upload-pack',
    servicePack('upload-pack', 'git-upload-pack', false)
  );
  router.post(
    '/:owner/:repo/git-receive-pack',
    servicePack('receive-pack', 'git-receive-pack', true)
  );

  return router;
};
