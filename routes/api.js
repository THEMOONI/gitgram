const express = require('express');

module.exports = function(db) {
  const router = express.Router();

  router.get('/search/repos', (req, res) => {
    const q = req.query.q;
    if (!q || typeof q !== 'string') return res.json([]);
    const like = '%' + q + '%';
    const repos = db.prepare(`
      SELECT r.*, u.username as owner_name
      FROM repositories r
      JOIN users u ON r.owner_id = u.id
      WHERE (r.name LIKE ? OR r.description LIKE ?) AND r.private = 0
      ORDER BY r.updated_at DESC
      LIMIT 20
    `).all(like, like);
    res.json(repos);
  });

  router.get('/users/:username/repos', (req, res) => {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const repos = req.session.userId === user.id
      ? db.prepare('SELECT * FROM repositories WHERE owner_id = ? ORDER BY updated_at DESC').all(user.id)
      : db.prepare('SELECT * FROM repositories WHERE owner_id = ? AND private = 0 ORDER BY updated_at DESC').all(user.id);
    res.json(repos);
  });

  return router;
};
