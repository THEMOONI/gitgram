const express = require('express');
const bcrypt = require('bcryptjs');
const { isValidUsername } = require('../lib/validate');

module.exports = function(db) {
  const router = express.Router();

  router.get('/register', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.render('register', { title: 'Sign Up - GITGRAM', error: null });
  });

  router.post('/register', (req, res) => {
    const { username, email, password } = req.body;
    if (typeof username !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
      return res.render('register', { title: 'Sign Up - GITGRAM', error: 'All fields required' });
    }
    if (!username || !email || !password) {
      return res.render('register', { title: 'Sign Up - GITGRAM', error: 'All fields required' });
    }
    if (!isValidUsername(username)) {
      return res.render('register', { title: 'Sign Up - GITGRAM', error: 'Username must be 3-39 characters and use only letters, numbers, underscores, and hyphens' });
    }
    if (password.length < 6) {
      return res.render('register', { title: 'Sign Up - GITGRAM', error: 'Password too short' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) {
      return res.render('register', { title: 'Sign Up - GITGRAM', error: 'User already exists' });
    }
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').run(username, email, hash);
    req.session.userId = result.lastInsertRowid;
    res.redirect('/');
  });

  router.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.render('login', { title: 'Login - GITGRAM', error: null });
  });

  router.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.render('login', { title: 'Login - GITGRAM', error: 'Invalid credentials' });
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.render('login', { title: 'Login - GITGRAM', error: 'Invalid credentials' });
    }
    req.session.userId = user.id;
    res.redirect('/');
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.redirect('/');
    });
  });

  router.get('/@:username', (req, res) => {
    if (!isValidUsername(req.params.username)) {
      return res.status(404).render('404', { title: 'Not Found - GITGRAM' });
    }
    const user = db.prepare('SELECT id, username, bio, created_at FROM users WHERE username = ?').get(req.params.username);
    if (!user) return res.status(404).render('404', { title: 'Not Found - GITGRAM' });
    const repos = req.session.userId === user.id
      ? db.prepare('SELECT * FROM repositories WHERE owner_id = ? ORDER BY updated_at DESC').all(user.id)
      : db.prepare('SELECT * FROM repositories WHERE owner_id = ? AND private = 0 ORDER BY updated_at DESC').all(user.id);
    const isOwner = req.session.userId === user.id;
    res.render('profile', { title: user.username + ' - GITGRAM', user, repos, isOwner });
  });

  return router;
};
