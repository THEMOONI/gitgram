const express = require('express');
const router = express.Router();
const fs = require('fs');
const git = require('../lib/git');
const { isValidName, isValidRef, isValidTreePath, repoPathFor } = require('../lib/paths');

module.exports = function (db) {
  function notFound(res) {
    return res.status(404).render('404', { title: 'Not Found - GITGRAM' });
  }

  function getRepo(req, res, next) {
    const { owner, repo } = req.params;
    if (!isValidName(owner) || !isValidName(repo)) return notFound(res);
    const repoData = db
      .prepare(
        `SELECT r.*, u.username as owner_name FROM repositories r
         JOIN users u ON r.owner_id = u.id WHERE r.full_name = ?`
      )
      .get(owner + '/' + repo);
    if (!repoData) return notFound(res);
    if (repoData.private && req.session.userId !== repoData.owner_id) return notFound(res);
    const repoPath = repoPathFor(owner, repo);
    if (!repoPath) return notFound(res);
    req.repo = repoData;
    req.repoPath = repoPath;
    next();
  }

  // Express 5 exposes a named wildcard as an array of decoded path segments.
  function wildcardPath(value) {
    if (Array.isArray(value)) return value.join('/');
    return typeof value === 'string' ? value : '';
  }

  function breadcrumbsFor(treePath) {
    const segments = treePath === '' ? [] : treePath.split('/');
    return segments.map((segment, index) => ({
      name: segment,
      path: segments.slice(0, index + 1).join('/'),
      isLast: index === segments.length - 1,
    }));
  }

  router.get('/new', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.render('new-repo', { title: 'New Repository - GITGRAM', error: null });
  });

  router.post('/new', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { description, is_private } = req.body;
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const renderError = (error) =>
      res.status(400).render('new-repo', { title: 'New Repository - GITGRAM', error });

    if (!name) return renderError('Repository name is required');
    if (!isValidName(name)) {
      return renderError(
        'Name must start with a letter or number and may only contain letters, numbers, dots, hyphens and underscores'
      );
    }

    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.redirect('/login');

    const fullName = user.username + '/' + name;
    if (db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName)) {
      return renderError('A repository with that name already exists');
    }

    const repoPath = repoPathFor(user.username, name);
    if (!repoPath) return renderError('Invalid repository name');
    if (!git.initBareRepo(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
      return res.status(500).render('new-repo', {
        title: 'New Repository - GITGRAM',
        error: 'Failed to initialise the repository on disk',
      });
    }

    db.prepare(
      'INSERT INTO repositories (name, full_name, description, owner_id, private) VALUES (?, ?, ?, ?, ?)'
    ).run(name, fullName, description || '', req.session.userId, is_private ? 1 : 0);
    res.redirect('/' + fullName);
  });

  function renderTree(req, res, ref, treePath) {
    if (!isValidRef(ref) || !isValidTreePath(treePath)) return notFound(res);

    const hasCommits = git.hasCommits(req.repoPath);
    const isOwner = req.session.userId === req.repo.owner_id;
    const base = {
      repo: req.repo,
      ref,
      currentPath: treePath,
      breadcrumbs: breadcrumbsFor(treePath),
      isOwner,
    };

    if (!hasCommits) {
      return res.render('repo', {
        ...base,
        title: req.repo.full_name + ' - GITGRAM',
        files: [],
        commits: [],
        readme: null,
        hasCommits: false,
      });
    }

    if (treePath !== '' && git.objectType(req.repoPath, ref, treePath) !== 'tree') {
      return notFound(res);
    }

    const files = git.listTree(req.repoPath, ref, treePath);
    if (treePath !== '' && files.length === 0) return notFound(res);

    const readmeEntry = files.find((file) => !file.isDir && /^readme(\.|$)/i.test(file.name));
    const readmeBlob = readmeEntry ? git.readBlob(req.repoPath, ref, readmeEntry.path) : null;

    res.render('repo', {
      ...base,
      title: req.repo.full_name + ' - GITGRAM',
      files,
      commits: git.log(req.repoPath, 10),
      readme: readmeBlob && !readmeBlob.isBinary ? readmeBlob.content : null,
      hasCommits: true,
    });
  }

  router.get('/:owner/:repo', getRepo, (req, res) => {
    renderTree(req, res, req.repo.default_branch, '');
  });

  router.get('/:owner/:repo/tree/:ref/*treePath', getRepo, (req, res) => {
    renderTree(req, res, req.params.ref, wildcardPath(req.params.treePath));
  });

  router.get('/:owner/:repo/tree/:ref', getRepo, (req, res) => {
    renderTree(req, res, req.params.ref, '');
  });

  router.get('/:owner/:repo/blob/:ref/*filepath', getRepo, (req, res) => {
    const ref = req.params.ref;
    const filepath = wildcardPath(req.params.filepath);
    if (!isValidRef(ref) || !isValidTreePath(filepath) || filepath === '') return notFound(res);

    // Directory links and file links share a URL shape in older bookmarks, so
    // send tree requests that arrive here to the tree view instead of 404ing.
    if (git.objectType(req.repoPath, ref, filepath) === 'tree') {
      return res.redirect(`/${req.repo.full_name}/tree/${encodeURIComponent(ref)}/${filepath}`);
    }

    const blob = git.readBlob(req.repoPath, ref, filepath);
    if (!blob) return notFound(res);

    res.render('file-view', {
      title: filepath + ' - GITGRAM',
      repo: req.repo,
      filepath,
      content: blob.content,
      isBinary: blob.isBinary,
      size: blob.size,
      ref,
      breadcrumbs: breadcrumbsFor(filepath),
      isOwner: req.session.userId === req.repo.owner_id,
    });
  });

  router.get('/:owner/:repo/commits', getRepo, (req, res) => {
    res.render('commits', {
      title: 'Commits - GITGRAM',
      repo: req.repo,
      commits: git.log(req.repoPath, 50),
      isOwner: req.session.userId === req.repo.owner_id,
    });
  });

  router.get('/:owner/:repo/settings', getRepo, (req, res) => {
    if (req.session.userId !== req.repo.owner_id) {
      return res.status(403).render('404', { title: 'Access Denied - GITGRAM' });
    }
    res.render('repo-settings', {
      title: 'Settings - GITGRAM',
      repo: req.repo,
      success: null,
      error: null,
    });
  });

  router.post('/:owner/:repo/settings/delete', getRepo, (req, res) => {
    if (req.session.userId !== req.repo.owner_id) {
      return res.status(403).render('404', { title: 'Access Denied - GITGRAM' });
    }
    fs.rmSync(req.repoPath, { recursive: true, force: true });
    db.prepare('DELETE FROM repositories WHERE id = ?').run(req.repo.id);
    res.redirect('/@' + req.repo.owner_name);
  });

  return router;
};
