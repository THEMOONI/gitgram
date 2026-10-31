const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertUpdatedAtStays,
  barePath,
  basicAuth,
  commitToBare,
  createRepo,
  gitSync,
  passwordHash,
  registerUser,
  remoteUrl,
  repoRow,
  runGit,
  setUpdatedAt,
  start,
} = require('./helpers');

const FROZEN = '2000-01-01 00:00:00';

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

async function deleteRemoteMain(url) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-del-'));
  try {
    gitSync(['init', '-b', 'main'], { cwd: work });
    gitSync(['config', 'commit.gpgsign', 'false'], { cwd: work });
    gitSync(['config', 'core.fsmonitor', 'false'], { cwd: work });
    return await runGit(['push', url, ':refs/heads/main'], { cwd: work, timeout: 20000 });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

describe('registration, history, and metadata boundaries', { concurrency: 1 }, () => {
  test('registration rejects each missing field and does not start a session', async () => {
    await withApp(async (ctx) => {
      const username = ctx.nextId('miss');
      const email = `${username}@example.test`;
      const password = 'correct-horse';
      const cases = [
        { label: 'username', fields: { email, password } },
        { label: 'email', fields: { username, password } },
        { label: 'password', fields: { username, email } },
      ];

      for (const attempt of cases) {
        const session = ctx.session();
        const res = await session.postForm('/register', attempt.fields);
        assert.equal(res.status, 200, attempt.label);
        const text = await res.text();
        assert.match(text, /All fields required/);
        assert.equal(text.includes(password), false);
        assert.equal(res.headers.get('location'), null);
        assert.doesNotMatch(await (await session.fetch('/')).text(), /Log out/);
      }

      assert.equal(
        ctx.db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email),
        undefined
      );

      ctx.users.add(username);
      const created = await ctx.session().postForm('/register', { username, email, password });
      assert.equal(created.status, 302);
      assert.equal(created.headers.get('location'), '/');
      await created.text();
      const hash = passwordHash(ctx.db, username);
      assert.match(hash, /^\$2[aby]\$/);
      assert.notEqual(hash, password);
    });
  });

  test('an empty commit is history before any file exists', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'empty-only', description: 'no files yet' });
      const bare = barePath(user.username, 'empty-only');
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-empty-only-'));
      try {
        gitSync(['init', '-b', 'main'], { cwd: work });
        gitSync(['config', 'commit.gpgsign', 'false'], { cwd: work });
        gitSync(['config', 'core.fsmonitor', 'false'], { cwd: work });
        gitSync(['config', 'user.email', 'ada@example.com'], { cwd: work });
        gitSync(['config', 'user.name', 'Ada'], { cwd: work });
        gitSync(['commit', '--allow-empty', '-m', 'empty-only-ship'], { cwd: work });
        gitSync(['remote', 'add', 'origin', bare], { cwd: work });
        gitSync(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work });
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }

      const history = await owner.fetch(`/${user.username}/empty-only/commits`);
      const historyHtml = await history.text();
      assert.equal(history.status, 200);
      assert.match(historyHtml, /empty-only-ship/);
      assert.equal(historyHtml.includes('No commits yet'), false);

      const stranger = await ctx.session().fetch(`/${user.username}/empty-only/commits`);
      const strangerHtml = await stranger.text();
      assert.equal(stranger.status, 200);
      assert.match(strangerHtml, /empty-only-ship/);

      const page = await owner.fetch(`/${user.username}/empty-only`);
      const pageHtml = await page.text();
      assert.equal(page.status, 200);
      assert.equal(pageHtml.includes('NOT_A_REAL_FILE_BODY'), false);

      const missing = await owner.fetch(`/${user.username}/empty-only/blob/main/README.md`);
      assert.equal(missing.status, 404);
      assert.equal((await missing.text()).includes('empty-only-ship'), false);
    });
  });

  test('an executable file stays a file and its body is served', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'tools', description: '' });
      const bare = barePath(user.username, 'tools');
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-mode-'));
      try {
        gitSync(['init', '-b', 'main'], { cwd: work });
        gitSync(['config', 'commit.gpgsign', 'false'], { cwd: work });
        gitSync(['config', 'core.fsmonitor', 'false'], { cwd: work });
        gitSync(['config', 'user.email', 'ada@example.com'], { cwd: work });
        gitSync(['config', 'user.name', 'Ada'], { cwd: work });
        fs.mkdirSync(path.join(work, 'bin'));
        fs.writeFileSync(path.join(work, 'bin', 'nested.txt'), 'NESTED_MODE_BODY\n');
        fs.writeFileSync(path.join(work, 'script.sh'), '#!/bin/sh\necho shipped');
        gitSync(['add', '-A'], { cwd: work });
        gitSync(['update-index', '--chmod=+x', 'script.sh'], { cwd: work });
        gitSync(['commit', '-m', 'add-script'], { cwd: work });
        gitSync(['remote', 'add', 'origin', bare], { cwd: work });
        gitSync(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work });
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }

      const mode = gitSync(['--git-dir', bare, 'ls-tree', 'HEAD', 'script.sh']);
      assert.match(mode, /^100755 /);

      const page = await (await owner.fetch(`/${user.username}/tools`)).text();
      assert.match(page, /<span>📄<\/span><a href="\/[^"]+\/script\.sh"/);
      assert.match(page, /<span><\/span><a href="\/[^"]+\/bin"/);
      assert.doesNotMatch(page, /<span>📄<\/span><a href="\/[^"]+\/bin"/);
      assert.equal(page.includes('NESTED_MODE_BODY'), false);

      const blob = await owner.fetch(`/${user.username}/tools/blob/main/script.sh`);
      const html = await blob.text();
      assert.equal(blob.status, 200);
      assert.match(html, /2 lines/);
      assert.match(html, /<pre>#!\/bin\/sh<\/pre>/);
      assert.match(html, /<pre>echo shipped<\/pre>/);
      assert.equal(html.includes('NESTED_MODE_BODY'), false);
    });
  });

  test('unicode descriptions, authors, messages, and file contents round-trip', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      const description = 'résumé du dépôt';
      await createRepo(owner, { name: 'unicode', description });
      commitToBare(barePath(user.username, 'unicode'), {
        files: { 'cafe.txt': 'héllo 你好\n' },
        message: 'corrige le café',
        author: 'José',
        email: 'jose-hidden@example.test',
      });

      const stored = gitSync([
        '--git-dir', barePath(user.username, 'unicode'),
        'show', 'HEAD:cafe.txt',
      ]);
      assert.equal(stored, 'héllo 你好\n');

      const page = await (await owner.fetch(`/${user.username}/unicode`)).text();
      assert.match(page, /résumé du dépôt/);
      assert.match(page, /corrige le café/);
      assert.match(page, /cafe\.txt/);

      const blob = await (await owner.fetch(`/${user.username}/unicode/blob/main/cafe.txt`)).text();
      assert.match(blob, /héllo 你好/);
      assert.match(blob, /2 lines/);

      const commits = await (await ctx.session().fetch(`/${user.username}/unicode/commits`)).text();
      assert.match(commits, /José/);
      assert.match(commits, /corrige le café/);
      assert.equal(commits.includes('jose-hidden@example.test'), false);

      const home = await (await ctx.session().fetch('/')).text();
      assert.match(home, /résumé du dépôt/);
    });
  });

  test('search matches names and descriptions, not file contents', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'listed-code', description: 'ordinary public notes' });
      commitToBare(barePath(user.username, 'listed-code'), {
        files: { 'secret-notes.txt': 'CODESEARCH_TOKEN public-body\n' },
        message: 'add notes',
      });
      await createRepo(owner, {
        name: 'hidden-code',
        description: 'CODESEARCH_TOKEN private',
        isPrivate: true,
      });

      const rows = await (await ctx.session().fetch('/api/search/repos?q=CODESEARCH_TOKEN')).json();
      assert.deepEqual(rows, []);

      const byName = await (await ctx.session().fetch('/api/search/repos?q=listed-code')).json();
      assert.deepEqual(byName.map((repo) => repo.name), ['listed-code']);
      assert.equal(JSON.stringify(byName).includes('CODESEARCH_TOKEN'), false);
      assert.equal(JSON.stringify(byName).includes('public-body'), false);

      const page = await (await ctx.session().fetch(`/${user.username}/listed-code`)).text();
      assert.equal(page.includes('public-body'), false);
      assert.match(page, /secret-notes\.txt/);
    });
  });

  test('an anonymous clone of an empty public repository does not create a commit', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'blank', description: 'clone the empty repo' });
      const fullName = `${user.username}/blank`;
      const bare = barePath(user.username, 'blank');
      setUpdatedAt(ctx.db, fullName, FROZEN);
      const before = await runGit(['--git-dir', bare, 'rev-parse', 'HEAD']);
      assert.notEqual(before.code, 0);

      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-empty-clone-'));
      try {
        const cloned = await runGit(['clone', remoteUrl(ctx, user.username, 'blank'), dest], { timeout: 20000 });
        assert.equal(cloned.code, 0, cloned.stderr);
        assert.deepEqual(fs.readdirSync(dest).filter((name) => name !== '.git'), []);
        assert.equal(gitSync(['--git-dir', bare, 'symbolic-ref', 'HEAD']).trim(), 'refs/heads/main');
      } finally {
        fs.rmSync(dest, { recursive: true, force: true });
      }

      const after = await runGit(['--git-dir', bare, 'rev-parse', 'HEAD']);
      assert.notEqual(after.code, 0);
      await assertUpdatedAtStays(ctx.db, fullName, FROZEN);
    });
  });

  test('deleting the current branch is refused and the files stay in place', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      const stranger = ctx.session();
      const other = await registerUser(ctx, stranger, { password: 'stranger-pass-9' });
      await createRepo(owner, { name: 'mainline', description: 'keep' });
      await createRepo(owner, { name: 'sibling', description: 'sibling-desc' });
      commitToBare(barePath(user.username, 'mainline'), {
        files: { 'keep.txt': 'KEEP_BODY\n' },
        message: 'keep-main',
      });
      commitToBare(barePath(user.username, 'sibling'), {
        files: { 'other.txt': 'SIBLING_BODY\n' },
        message: 'sibling-ship',
      });
      const mainHead = gitSync(['--git-dir', barePath(user.username, 'mainline'), 'rev-parse', 'HEAD']).trim();
      const siblingHead = gitSync(['--git-dir', barePath(user.username, 'sibling'), 'rev-parse', 'HEAD']).trim();
      const mainName = `${user.username}/mainline`;
      const siblingName = `${user.username}/sibling`;
      setUpdatedAt(ctx.db, mainName, FROZEN);
      setUpdatedAt(ctx.db, siblingName, FROZEN);

      const denied = await deleteRemoteMain(
        `http://${encodeURIComponent(other.username)}:${encodeURIComponent(other.password)}@127.0.0.1:${ctx.port}/${encodeURIComponent(user.username)}/mainline.git`
      );
      assert.notEqual(denied.code, 0);
      await assertUpdatedAtStays(ctx.db, mainName, FROZEN);
      assert.equal(repoRow(ctx.db, siblingName).updated_at, FROZEN);
      assert.equal(gitSync(['--git-dir', barePath(user.username, 'mainline'), 'rev-parse', 'HEAD']).trim(), mainHead);
      const still = await (await owner.fetch(`/${user.username}/mainline/blob/main/keep.txt`)).text();
      assert.match(still, /KEEP_BODY/);

      const removed = await deleteRemoteMain(remoteUrl(ctx, user.username, 'mainline', user.password));
      assert.notEqual(removed.code, 0);
      assert.equal(gitSync(['--git-dir', barePath(user.username, 'mainline'), 'rev-parse', 'HEAD']).trim(), mainHead);
      assert.equal(gitSync(['--git-dir', barePath(user.username, 'sibling'), 'rev-parse', 'HEAD']).trim(), siblingHead);
      await assertUpdatedAtStays(ctx.db, siblingName, FROZEN);

      const page = await (await owner.fetch(`/${user.username}/mainline`)).text();
      assert.match(page, /keep\.txt/);
      assert.match(page, /keep-main/);
      assert.equal(page.includes('KEEP_BODY'), false);
      const blob = await (await owner.fetch(`/${user.username}/mainline/blob/main/keep.txt`)).text();
      assert.match(blob, /KEEP_BODY/);
      const history = await (await owner.fetch(`/${user.username}/mainline/commits`)).text();
      assert.match(history, /keep-main/);
      const siblingPage = await (await owner.fetch(`/${user.username}/sibling/blob/main/other.txt`)).text();
      assert.match(siblingPage, /SIBLING_BODY/);
    });
  });

  test('an authenticated receive-pack for a missing repository creates nothing', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'kept', description: 'stays' });
      const fullName = `${user.username}/kept`;
      setUpdatedAt(ctx.db, fullName, FROZEN);

      const res = await owner.fetch(`/${user.username}/no-such/git-receive-pack`, {
        method: 'POST',
        headers: { authorization: basicAuth(user.username, user.password) },
        body: '',
      });
      assert.equal(res.status, 404);
      const text = await res.text();
      assert.match(text, /Not found/);
      assert.equal(text.includes(user.password), false);
      assert.equal(fs.existsSync(barePath(user.username, 'no-such')), false);
      assert.equal(repoRow(ctx.db, `${user.username}/no-such`), undefined);
      await assertUpdatedAtStays(ctx.db, fullName, FROZEN);
      assert.equal(repoRow(ctx.db, fullName).description, 'stays');
    });
  });
});
