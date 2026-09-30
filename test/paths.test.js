const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { isValidName, isValidRef, isValidTreePath, repoPathFor, REPO_ROOT } = require('../lib/paths');

test('isValidName accepts ordinary repository and user names', () => {
  ['repo', 'my-repo', 'my_repo', 'repo.js', 'a1', 'Alice'].forEach((name) => {
    assert.strictEqual(isValidName(name), true, `expected ${name} to be valid`);
  });
});

test('isValidName rejects traversal and separators', () => {
  ['..', '.', '../etc', 'a/b', 'a\\b', '', '-flag', '.hidden', 'a b', 'a;b', 'a'.repeat(101)].forEach(
    (name) => {
      assert.strictEqual(isValidName(name), false, `expected ${name} to be rejected`);
    }
  );
});

test('isValidName rejects non-string input', () => {
  [null, undefined, 42, {}, []].forEach((value) => {
    assert.strictEqual(isValidName(value), false);
  });
});

test('isValidRef allows slashes but rejects option-like and traversal refs', () => {
  assert.strictEqual(isValidRef('main'), true);
  assert.strictEqual(isValidRef('refs/heads/main'), true);
  assert.strictEqual(isValidRef('v1.2.3'), true);
  assert.strictEqual(isValidRef('--upload-pack=sh'), false);
  assert.strictEqual(isValidRef('main;touch /tmp/x'), false);
  assert.strictEqual(isValidRef('a..b'), false);
  assert.strictEqual(isValidRef(''), false);
});

test('isValidTreePath rejects traversal segments and absolute paths', () => {
  assert.strictEqual(isValidTreePath(''), true);
  assert.strictEqual(isValidTreePath('src/app.js'), true);
  assert.strictEqual(isValidTreePath('a/b/c/d.txt'), true);
  assert.strictEqual(isValidTreePath('../secret'), false);
  assert.strictEqual(isValidTreePath('src/../../etc/passwd'), false);
  assert.strictEqual(isValidTreePath('/etc/passwd'), false);
  assert.strictEqual(isValidTreePath('src//app.js'), false);
});

test('repoPathFor resolves inside the repository root', () => {
  const resolved = repoPathFor('alice', 'demo');
  assert.strictEqual(resolved, path.join(REPO_ROOT, 'alice', 'demo'));
});

test('repoPathFor strips a trailing .git suffix', () => {
  assert.strictEqual(repoPathFor('alice', 'demo.git'), path.join(REPO_ROOT, 'alice', 'demo'));
});

test('repoPathFor refuses to escape the repository root', () => {
  assert.strictEqual(repoPathFor('alice', '../../etc'), null);
  assert.strictEqual(repoPathFor('..', 'demo'), null);
  assert.strictEqual(repoPathFor('alice', '/etc/passwd'), null);
});
