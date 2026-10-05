function createLoginLimiter(options = {}) {
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const maxFailures = options.maxFailures ?? 8;
  const attempts = new Map();

  function keyFor(req) {
    const ip = req.ip || 'unknown';
    const username = typeof req.body?.username === 'string' ? req.body.username.slice(0, 200).toLowerCase() : '';
    return ip + '\0' + username;
  }

  function bucket(req) {
    const key = keyFor(req);
    const now = Date.now();
    const current = attempts.get(key);
    if (!current || now - current.start >= windowMs) {
      const fresh = { start: now, count: 0 };
      attempts.set(key, fresh);
      return fresh;
    }
    return current;
  }

  return {
    isLimited(req) {
      return bucket(req).count >= maxFailures;
    },
    recordFailure(req) {
      bucket(req).count += 1;
    },
    clear(req) {
      attempts.delete(keyFor(req));
    },
  };
}

module.exports = { createLoginLimiter };
