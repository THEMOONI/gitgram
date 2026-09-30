const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { isValidName } = require('../lib/paths');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 12;

module.exports = function (db) {
  router.get('/register', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.render('register', { title: 'Sign Up - GITGRAM', error: null });
  });

  router.post('/register', (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const renderError = (error) =>
      res.status(400).render('register', { title: 'Sign Up - GITGRAM', error });

    if (!username || !email || !password) return renderError('All fields are required');
    if (username.length < 3) return renderError('Username must be at least 3 characters');
    // Usernames become directory names under data/repos, so they are held to the
    // same character rules as repository names.
    if (!isValidName(username)) {
      return renderError(
        'Username must start with a letter or number and may only contain letters, numbers, dots, hyphens and underscores'
      );
    }
    if (!EMAIL_PATTERN.test(email)) return renderError('Enter a valid email address');
    if (password.length < 8) return renderError('Password must be at least 8 characters');

    const existing = db
      .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
      .get(username, email);
    if (existing) return renderError('That username or email is already taken');

    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const result = db
      .prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)')
      .run(username, email, hash);

    // Regenerating defends against session fixation, where an attacker primes a
    // victim's browser with a known session id before they authenticate.
    req.session.regenerate((err) => {
      if (err) return renderError('Could not start your session, please try again');
      req.session.userId = result.lastInsertRowid;
      res.redirect('/');
    });
  });

  router.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.render('login', { title: 'Login - GITGRAM', error: null });
  });

  router.post('/login', (req, res) => {
    const identifier = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const renderError = () =>
      res.status(401).render('login', { title: 'Login - GITGRAM', error: 'Invalid credentials' });

    const user = db
      .prepare('SELECT * FROM users WHERE username = ? OR email = ?')
      .get(identifier, identifier.toLowerCase());
    if (!user || !bcrypt.compareSync(password, user.password)) return renderError();

    req.session.regenerate((err) => {
      if (err) return renderError();
      req.session.userId = user.id;
      res.redirect('/');
    });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('gitgram.sid');
      res.redirect('/');
    });
  });

  router.get('/@:username', (req, res) => {
    const user = db
      .prepare('SELECT id, username, email, bio, created_at FROM users WHERE username = ?')
      .get(req.params.username);
    if (!user) return res.status(404).render('404', { title: 'Not Found - GITGRAM' });

    const isOwner = req.session.userId === user.id;
    const repos = isOwner
      ? db
          .prepare('SELECT * FROM repositories WHERE owner_id = ? ORDER BY updated_at DESC')
          .all(user.id)
      : db
          .prepare(
            'SELECT * FROM repositories WHERE owner_id = ? AND private = 0 ORDER BY updated_at DESC'
          )
          .all(user.id);

    res.render('profile', { title: user.username + ' - GITGRAM', user, repos, isOwner });
  });

  return router;
};
