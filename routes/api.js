const express = require('express');
const router = express.Router();

const MAX_RESULTS = 20;

module.exports = function (db) {
  router.get('/search/repos', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) return res.json([]);
    // Escape the LIKE wildcards so a query of "%" does not match everything.
    const pattern = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
    const repos = db
      .prepare(
        `SELECT r.id, r.name, r.full_name, r.description, r.default_branch, r.updated_at,
                u.username as owner_name
         FROM repositories r JOIN users u ON r.owner_id = u.id
         WHERE (r.name LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\') AND r.private = 0
         ORDER BY r.updated_at DESC LIMIT ?`
      )
      .all(pattern, pattern, MAX_RESULTS);
    res.json(repos);
  });

  router.get('/users/:username/repos', (req, res) => {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
    if (!user) return res.status(404).json({ error: 'Not found' });

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
    res.json(repos);
  });

  return router;
};
