const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

module.exports = function(db) {
  const router = express.Router();

  function getRepo(req, res, next) {
    const { owner, repo } = req.params;
    const repoData = db.prepare(`SELECT r.*, u.username as owner_name FROM repositories r JOIN users u ON r.owner_id = u.id WHERE r.full_name = ?`).get(owner + '/' + repo);
    if (!repoData) return res.status(404).render('404', { title: 'Not Found - GITGRAM' });
    if (repoData.private && req.session.userId !== repoData.owner_id) {
      return res.status(404).render('404', { title: 'Not Found - GITGRAM' });
    }
    req.repo = repoData;
    next();
  }

  router.get('/new', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.render('new-repo', { title: 'New Repository - GITGRAM', error: null });
  });

  router.post('/new', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { name, description, is_private } = req.body;
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.userId);
    if (!name || name.trim().length === 0) {
      return res.render('new-repo', { title: 'New Repository - GITGRAM', error: 'Name required' });
    }
    const fullName = user.username + '/' + name.trim();
    const existing = db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName);
    if (existing) {
      return res.render('new-repo', { title: 'New Repository - GITGRAM', error: 'Repo already exists' });
    }
    const repoPath = path.join(__dirname, '..', 'data', 'repos', user.username, name.trim());
    fs.mkdirSync(repoPath, { recursive: true });
    try {
      execSync('git init --bare "' + repoPath + '"', { stdio: 'pipe' });
      execSync('git --git-dir="' + repoPath + '" symbolic-ref HEAD refs/heads/main', { stdio: 'pipe' });
      execSync('git --git-dir="' + repoPath + '" config http.receivepack true', { stdio: 'pipe' });
      execSync('git --git-dir="' + repoPath + '" config http.uploadpack true', { stdio: 'pipe' });
    } catch (e) {
      return res.render('new-repo', { title: 'New Repository - GITGRAM', error: 'Failed to create repo' });
    }
    db.prepare('INSERT INTO repositories (name, full_name, description, owner_id, private) VALUES (?, ?, ?, ?, ?)').run(name.trim(), fullName, description || '', req.session.userId, is_private ? 1 : 0);
    res.redirect('/' + fullName);
  });

  router.get('/:owner/:repo', getRepo, (req, res) => {
    const repoPath = path.join(__dirname, '..', 'data', 'repos', req.params.owner, req.params.repo);
    let files = [], commits = [], readme = null, hasCommits = false;
    try {
      const fileOutput = execSync('git --git-dir="' + repoPath + '" ls-tree --name-only HEAD 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }).trim();
      if (fileOutput) {
        hasCommits = true;
        fileOutput.split('\n').forEach(fn => {
          try {
            const type = execSync('git --git-dir="' + repoPath + '" ls-tree HEAD "' + fn + '" 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim();
            files.push({ name: fn, isDir: type.startsWith('040000') || type.startsWith('40000') });
          } catch (e) { files.push({ name: fn, isDir: false }); }
        });
        const readmeName = files.find(f => /^readme/i.test(f.name));
        if (readmeName) {
          try { readme = execSync('git --git-dir="' + repoPath + '" show HEAD:"' + readmeName.name + '" 2>/dev/null', { encoding: 'utf8', timeout: 5000 }); } catch (e) {}
        }
        try {
          const co = execSync('git --git-dir="' + repoPath + '" log --oneline -10 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }).trim();
          if (co) commits = co.split('\n').map(l => { const m = l.match(/^([a-f0-9]+)\s+(.*)/); return m ? { hash: m[1], shortHash: m[1].substring(0,7), message: m[2] } : null; }).filter(Boolean);
        } catch (e) {}
      }
    } catch (e) { hasCommits = false; }
    res.render('repo', { title: req.params.owner + '/' + req.params.repo + ' - GITGRAM', repo: req.repo, files, commits, readme, hasCommits, isOwner: req.session.userId === req.repo.owner_id });
  });

  router.get('/:owner/:repo/blob/:ref/:filepath', getRepo, (req, res) => {
    const repoPath = path.join(__dirname, '..', 'data', 'repos', req.params.owner, req.params.repo);
    let content = '';
    try { content = execSync('git --git-dir="' + repoPath + '" show ' + req.params.ref + ':"' + req.params.filepath + '" 2>/dev/null', { encoding: 'utf8', timeout: 5000 }); } catch (e) { return res.status(404).render('404', { title: 'Not Found' }); }
    res.render('file-view', { title: req.params.filepath + ' - GITGRAM', repo: req.repo, filepath: req.params.filepath, content, ref: req.params.ref, isOwner: req.session.userId === req.repo.owner_id });
  });

  router.get('/:owner/:repo/commits', getRepo, (req, res) => {
    const repoPath = path.join(__dirname, '..', 'data', 'repos', req.params.owner, req.params.repo);
    let commits = [];
    try {
      const co = execSync('git --git-dir="' + repoPath + '" log --format="%H|%an|%ae|%aI|%s" -50 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }).trim();
      if (co) commits = co.split('\n').map(l => { const p = l.split('|'); return { hash: p[0], shortHash: p[0].substring(0,7), author: p[1], email: p[2], date: p[3], message: p[4] }; });
    } catch (e) {}
    res.render('commits', { title: 'Commits - GITGRAM', repo: req.repo, commits, isOwner: req.session.userId === req.repo.owner_id });
  });

  router.get('/:owner/:repo/settings', getRepo, (req, res) => {
    if (req.session.userId !== req.repo.owner_id) return res.status(403).render('404', { title: 'Access Denied' });
    res.render('repo-settings', { title: 'Settings - GITGRAM', repo: req.repo, success: null, error: null });
  });

  router.post('/:owner/:repo/settings/delete', getRepo, (req, res) => {
    if (req.session.userId !== req.repo.owner_id) return res.status(403).render('404', { title: 'Access Denied' });
    const repoPath = path.join(__dirname, '..', 'data', 'repos', req.params.owner, req.params.repo);
    fs.rmSync(repoPath, { recursive: true, force: true });
    db.prepare('DELETE FROM repositories WHERE id = ?').run(req.repo.id);
    res.redirect('/@' + req.params.owner);
  });

  return router;
};
