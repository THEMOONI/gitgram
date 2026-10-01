const express = require('express');
const fs = require('fs');
const { isValidUsername, isValidRepoName, isValidRef, isValidFilePath, resolveRepoPath } = require('../lib/validate');
const { gitInitBare, hasHead, listTree, showFile, commitLog } = require('../lib/git');

module.exports = function(db, options) {
  const router = express.Router();
  const dataDir = options.dataDir;

  function notFound(res) {
    return res.status(404).render('404', { title: 'Not Found - GITGRAM' });
  }

  function getRepo(req, res, next) {
    const { owner, repo } = req.params;
    if (!isValidUsername(owner) || !isValidRepoName(repo)) return notFound(res);
    const repoData = db.prepare(`
      SELECT r.*, u.username as owner_name
      FROM repositories r
      JOIN users u ON r.owner_id = u.id
      WHERE r.full_name = ?
    `).get(owner + '/' + repo);
    if (!repoData) return notFound(res);
    if (repoData.private && req.session.userId !== repoData.owner_id) return notFound(res);
    req.repo = repoData;
    next();
  }

  function diskPath(repo) {
    return resolveRepoPath(dataDir, repo.owner_name, repo.name);
  }

  router.get('/new', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.render('new-repo', { title: 'New Repository - GITGRAM', error: null });
  });

  router.post('/new', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { name, description, is_private } = req.body;
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.userId);
    const repoName = typeof name === 'string' ? name.trim() : '';
    if (!repoName) {
      return res.render('new-repo', { title: 'New Repository - GITGRAM', error: 'Name required' });
    }
    if (!isValidRepoName(repoName) || !isValidUsername(user.username)) {
      return res.render('new-repo', { title: 'New Repository - GITGRAM', error: 'Invalid repository name' });
    }
    const fullName = user.username + '/' + repoName;
    const existing = db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName);
    if (existing) {
      return res.render('new-repo', { title: 'New Repository - GITGRAM', error: 'Repo already exists' });
    }
    const repoPath = resolveRepoPath(dataDir, user.username, repoName);
    if (!repoPath) {
      return res.render('new-repo', { title: 'New Repository - GITGRAM', error: 'Invalid repository name' });
    }
    try {
      fs.mkdirSync(repoPath, { recursive: true });
      gitInitBare(repoPath);
    } catch {
      return res.render('new-repo', { title: 'New Repository - GITGRAM', error: 'Failed to create repo' });
    }
    const descriptionText = typeof description === 'string' ? description : '';
    db.prepare('INSERT INTO repositories (name, full_name, description, owner_id, private) VALUES (?, ?, ?, ?, ?)').run(
      repoName,
      fullName,
      descriptionText,
      req.session.userId,
      is_private ? 1 : 0
    );
    res.redirect('/' + fullName);
  });

  router.get('/:owner/:repo', getRepo, (req, res) => {
    const repoPath = diskPath(req.repo);
    let files = [];
    let commits = [];
    let readme = null;
    let hasCommits = false;
    if (repoPath && fs.existsSync(repoPath) && hasHead(repoPath)) {
      hasCommits = true;
      files = listTree(repoPath);
      const readmeFile = files.find((file) => /^readme/i.test(file.name) && !file.isDir);
      if (readmeFile) {
        try { readme = showFile(repoPath, 'HEAD', readmeFile.name); } catch { readme = null; }
      }
      commits = commitLog(repoPath, 10).map((commit) => ({
        hash: commit.hash,
        shortHash: commit.shortHash,
        message: commit.message,
      }));
    }
    res.render('repo', {
      title: req.repo.owner_name + '/' + req.repo.name + ' - GITGRAM',
      repo: req.repo,
      files,
      commits,
      readme,
      hasCommits,
      isOwner: req.session.userId === req.repo.owner_id,
    });
  });

  router.get('/:owner/:repo/blob/:ref/:filepath', getRepo, (req, res) => {
    if (!isValidRef(req.params.ref) || !isValidFilePath(req.params.filepath)) {
      return res.status(400).send('Invalid path');
    }
    const repoPath = diskPath(req.repo);
    if (!repoPath) return notFound(res);
    let content = '';
    try {
      content = showFile(repoPath, req.params.ref, req.params.filepath);
    } catch {
      return notFound(res);
    }
    res.render('file-view', {
      title: req.params.filepath + ' - GITGRAM',
      repo: req.repo,
      filepath: req.params.filepath,
      content,
      ref: req.params.ref,
      isOwner: req.session.userId === req.repo.owner_id,
    });
  });

  router.get('/:owner/:repo/commits', getRepo, (req, res) => {
    const repoPath = diskPath(req.repo);
    const commits = repoPath && fs.existsSync(repoPath) ? commitLog(repoPath, 50) : [];
    res.render('commits', {
      title: 'Commits - GITGRAM',
      repo: req.repo,
      commits,
      isOwner: req.session.userId === req.repo.owner_id,
    });
  });

  router.get('/:owner/:repo/settings', getRepo, (req, res) => {
    if (req.session.userId !== req.repo.owner_id) {
      return res.status(403).render('404', { title: 'Access Denied' });
    }
    res.render('repo-settings', { title: 'Settings - GITGRAM', repo: req.repo, success: null, error: null });
  });

  router.post('/:owner/:repo/settings/delete', getRepo, (req, res) => {
    if (req.session.userId !== req.repo.owner_id) {
      return res.status(403).render('404', { title: 'Access Denied' });
    }
    const repoPath = diskPath(req.repo);
    if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
    db.prepare('DELETE FROM repositories WHERE id = ?').run(req.repo.id);
    res.redirect('/@' + req.repo.owner_name);
  });

  return router;
};
