module.exports = function applySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      bio TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      full_name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      owner_id INTEGER NOT NULL,
      private INTEGER DEFAULT 0,
      default_branch TEXT DEFAULT 'main',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_repositories_owner_id ON repositories(owner_id);
    CREATE INDEX IF NOT EXISTS idx_repositories_updated_at ON repositories(updated_at);
  `);
};
