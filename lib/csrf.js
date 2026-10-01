const crypto = require('crypto');
const { DEMO_NOTICE } = require('./demo-notice');

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

function hasBearer(req) {
  const header = req.get('authorization') || '';
  return /^Bearer\s+\S+/.test(header);
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
      // Agent calls authenticate with a bearer key. They do not use the session cookie.
      if (hasBearer(req)) return next();
      const provided = req.body && req.body._csrf;
      if (!tokensMatch(provided, req.session && req.session.csrfToken)) {
        if (req.path.startsWith('/api/demo')) {
          return res.status(403).json({
            demo: true,
            notice: DEMO_NOTICE,
            simulated: true,
            error: 'csrf',
            message: 'Invalid CSRF token',
          });
        }
        return res.status(403).send('Invalid CSRF token');
      }
      next();
    },
  };
}

module.exports = { csrfProtection, isGitSmartHttp };
