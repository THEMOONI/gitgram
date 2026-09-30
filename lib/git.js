const { execFileSync } = require('child_process');

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

function git(repoPath, args, options = {}) {
  return execFileSync('git', ['--git-dir', repoPath, ...args], {
    encoding: 'utf8',
    timeout: options.timeout ?? 5000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: gitEnv(),
  });
}

function gitInitBare(repoPath) {
  execFileSync('git', ['init', '--bare', '--', repoPath], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv(),
  });
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(repoPath, ['config', 'http.receivepack', 'true'], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(repoPath, ['config', 'http.uploadpack', 'true'], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function hasHead(repoPath) {
  try {
    git(repoPath, ['rev-parse', '--verify', '--end-of-options', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function listTree(repoPath) {
  let output;
  try {
    output = git(repoPath, ['ls-tree', '-z', '--end-of-options', 'HEAD']);
  } catch {
    return [];
  }
  if (!output) return [];
  const files = [];
  for (const line of output.split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const mode = line.slice(0, tab).split(' ')[0];
    files.push({ name: line.slice(tab + 1), isDir: mode === '040000' });
  }
  return files;
}

function showFile(repoPath, ref, filePath) {
  return git(repoPath, ['show', '--end-of-options', `${ref}:${filePath}`]);
}

function commitLog(repoPath, limit) {
  let output;
  try {
    output = git(repoPath, [
      'log',
      '-z',
      '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s',
      '-n',
      String(limit),
      '--end-of-options',
      'HEAD',
    ]);
  } catch {
    return [];
  }
  if (!output) return [];
  return output.split('\0').filter(Boolean).map((record) => {
    const [hash, author, email, date, message] = record.split('\x1f');
    if (!hash) return null;
    return {
      hash,
      shortHash: hash.slice(0, 7),
      author: author || '',
      email: email || '',
      date: date || '',
      message: message || '',
    };
  }).filter(Boolean);
}

module.exports = {
  gitEnv,
  git,
  gitInitBare,
  hasHead,
  listTree,
  showFile,
  commitLog,
};
