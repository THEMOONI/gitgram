const { spawnSync } = require('child_process');
const fs = require('fs');
const { isValidRef, isValidTreePath } = require('./paths');

const TIMEOUT_MS = 10000;
const MAX_BUFFER = 10 * 1024 * 1024;

// Every git invocation goes through here with an argv array and no shell, so
// user-supplied refs and paths can never be interpreted as shell syntax.
function runGit(repoPath, args, { encoding = 'utf8' } = {}) {
  const result = spawnSync('git', ['--git-dir', repoPath, ...args], {
    encoding,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, stdout: encoding === 'buffer' ? Buffer.alloc(0) : '' };
  }
  return { ok: true, stdout: result.stdout };
}

function initBareRepo(repoPath, defaultBranch = 'main') {
  fs.mkdirSync(repoPath, { recursive: true });
  const init = spawnSync('git', ['init', '--bare', '--initial-branch', defaultBranch, repoPath], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
  if (init.error || init.status !== 0) return false;
  const config = [
    ['config', 'http.receivepack', 'true'],
    ['config', 'http.uploadpack', 'true'],
  ];
  return config.every((args) => runGit(repoPath, args).ok);
}

function hasCommits(repoPath) {
  return runGit(repoPath, ['rev-parse', '--verify', 'HEAD']).ok;
}

// `git cat-file -t` distinguishes a directory from a file so the web UI can
// render a tree listing instead of trying to display a directory as text.
function objectType(repoPath, ref, treePath) {
  if (!isValidRef(ref) || !isValidTreePath(treePath)) return null;
  const target = treePath === '' ? ref : `${ref}:${treePath}`;
  const { ok, stdout } = runGit(repoPath, ['cat-file', '-t', target]);
  return ok ? stdout.trim() : null;
}

function listTree(repoPath, ref, treePath = '') {
  if (!isValidRef(ref) || !isValidTreePath(treePath)) return [];
  const args = ['ls-tree', '-z', ref];
  if (treePath !== '') args.push('--', `${treePath}/`);
  const { ok, stdout } = runGit(repoPath, args);
  if (!ok) return [];

  return stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tabIndex = entry.indexOf('\t');
      if (tabIndex === -1) return null;
      const [, type] = entry.slice(0, tabIndex).split(' ');
      const fullPath = entry.slice(tabIndex + 1);
      return { name: fullPath.split('/').pop(), path: fullPath, isDir: type === 'tree' };
    })
    .filter(Boolean)
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

// Blobs are read as a Buffer so binary content can be detected rather than
// mangled into replacement characters by a utf8 decode.
function readBlob(repoPath, ref, treePath) {
  if (!isValidRef(ref) || !isValidTreePath(treePath) || treePath === '') return null;
  const { ok, stdout } = runGit(repoPath, ['cat-file', 'blob', `${ref}:${treePath}`], {
    encoding: 'buffer',
  });
  if (!ok) return null;
  const isBinary = stdout.includes(0);
  return {
    isBinary,
    size: stdout.length,
    content: isBinary ? '' : stdout.toString('utf8'),
  };
}

const LOG_SEPARATOR = '\u001f';

function log(repoPath, limit = 50) {
  const { ok, stdout } = runGit(repoPath, [
    'log',
    `--format=%H${LOG_SEPARATOR}%an${LOG_SEPARATOR}%ae${LOG_SEPARATOR}%aI${LOG_SEPARATOR}%s`,
    `-${limit}`,
  ]);
  if (!ok) return [];
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, author, email, date, ...rest] = line.split(LOG_SEPARATOR);
      return {
        hash,
        shortHash: hash.slice(0, 7),
        author,
        email,
        date,
        message: rest.join(LOG_SEPARATOR),
      };
    });
}

function currentBranch(repoPath) {
  const { ok, stdout } = runGit(repoPath, ['symbolic-ref', '--short', 'HEAD']);
  return ok ? stdout.trim() : null;
}

module.exports = {
  runGit,
  initBareRepo,
  hasCommits,
  objectType,
  listTree,
  readBlob,
  log,
  currentBranch,
};
