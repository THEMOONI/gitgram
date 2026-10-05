const path = require('path');

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,38}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isValidUsername(name) {
  return typeof name === 'string' && USERNAME_RE.test(name);
}

function isValidRepoName(name) {
  if (typeof name !== 'string' || !REPO_RE.test(name)) return false;
  if (name.includes('..')) return false;
  if (name.endsWith('.git')) return false;
  return true;
}

function cleanRepoName(name) {
  if (typeof name !== 'string') return '';
  return name.endsWith('.git') ? name.slice(0, -4) : name;
}

function isValidRef(ref) {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) return false;
  if (ref.includes('..')) return false;
  return true;
}

function isValidFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 1024) return false;
  if (filePath.includes('\0')) return false;
  const parts = filePath.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function resolveRepoPath(dataDir, owner, repoName) {
  if (!isValidUsername(owner) || !isValidRepoName(repoName)) return null;
  const root = path.resolve(dataDir, 'repos');
  const resolved = path.resolve(root, owner, repoName);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

module.exports = {
  isValidUsername,
  isValidRepoName,
  cleanRepoName,
  isValidRef,
  isValidFilePath,
  resolveRepoPath,
};
