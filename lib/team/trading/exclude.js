const fs = require('fs');

function createExcludeList(filePath, now = () => Date.now()) {
  let cache = { at: 0, mtimeMs: null, size: null, mints: new Set() };

  function load() {
    if (!filePath) return new Set();
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return new Set();
    }
    if (!stat.isFile()) return cache.mints;
    const fresh = cache.mtimeMs === stat.mtimeMs
      && cache.size === stat.size
      && now() - cache.at < 10_000;
    if (fresh) return cache.mints;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const mints = new Set();
      if (parsed && Array.isArray(parsed.mints)) {
        for (const mint of parsed.mints) {
          if (typeof mint === 'string' && mint.trim()) mints.add(mint.trim());
        }
      }
      cache = { at: now(), mtimeMs: stat.mtimeMs, size: stat.size, mints };
      return mints;
    } catch {
      cache = { ...cache, at: now(), mtimeMs: stat.mtimeMs, size: stat.size };
      return cache.mints;
    }
  }

  return {
    has(mint) {
      return load().has(mint);
    },
    reload() {
      cache.at = 0;
      return load();
    },
  };
}

module.exports = { createExcludeList };
