const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', 'data', 'repos');

// Git refuses some of these itself, but the web layer must reject them before
// they ever reach the filesystem: a name like `../../etc` would otherwise
// create a bare repository outside REPO_ROOT.
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function isValidName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) return false;
  return name !== '.' && name !== '..' && !name.includes('..');
}

// A ref may contain slashes (refs/heads/main) but must never look like an
// option, since git would interpret a leading dash as a flag.
function isValidRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 255) return false;
  if (ref.startsWith('-') || ref.includes('..')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(ref);
}

// Paths inside a tree are validated per segment so that `a/../../b` cannot
// escape the repository when it is handed to `git cat-file`.
function isValidTreePath(treePath) {
  if (typeof treePath !== 'string') return false;
  if (treePath === '') return true;
  if (treePath.length > 1024 || treePath.startsWith('-') || treePath.startsWith('/')) return false;
  return treePath.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function stripGitSuffix(name) {
  return name.replace(/\.git$/, '');
}

// Returns null when the resolved location would fall outside REPO_ROOT, so
// callers can treat traversal attempts as a plain "not found".
function repoPathFor(owner, repo) {
  const repoName = stripGitSuffix(repo);
  if (!isValidName(owner) || !isValidName(repoName)) return null;
  const resolved = path.resolve(REPO_ROOT, owner, repoName);
  const prefix = path.resolve(REPO_ROOT) + path.sep;
  if (!resolved.startsWith(prefix)) return null;
  return resolved;
}

module.exports = {
  REPO_ROOT,
  isValidName,
  isValidRef,
  isValidTreePath,
  stripGitSuffix,
  repoPathFor,
};
