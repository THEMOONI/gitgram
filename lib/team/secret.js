const crypto = require('crypto');

function tokensEqual(provided, expected) {
  const left = crypto.createHash('sha256').update(String(provided), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

function bearerToken(header) {
  if (typeof header !== 'string') return '';
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

module.exports = { tokensEqual, bearerToken, sha256 };
