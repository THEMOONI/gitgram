const crypto = require('crypto');

function isGitSmartHttp(req) {
  return /\/(?:git-upload-pack|git-receive-pack|info\/refs)$/.test(req.path);
}

function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function csrfProtection() {
  return {
    ensure(req, res, next) {
      if (isGitSmartHttp(req)) return next();
      if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      }
      res.locals.csrfToken = req.session.csrfToken;
      next();
    },
    verify(req, res, next) {
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
      if (isGitSmartHttp(req)) return next();
      const provided = req.body && req.body._csrf;
      if (!tokensMatch(provided, req.session && req.session.csrfToken)) {
        return res.status(403).send('Invalid CSRF token');
      }
      next();
    },
  };
}

module.exports = { csrfProtection, isGitSmartHttp };
