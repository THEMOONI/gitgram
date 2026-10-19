const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertUpdatedAtStays,
  barePath,
  commitToBare,
  createRepo,
  gitSync,
  pushFiles,
  registerUser,
  remoteUrl,
  repoRow,
  runGit,
  setUpdatedAt,
  start,
} = require('./helpers');

const FROZEN = '2000-01-01 00:00:00';
const SEVEN_DAYS = 7 * 24 * 60 * 60;

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

describe('uncovered auth, clone, and empty-state boundaries', { concurrency: 1 }, () => {
  test('an anonymous clone of a public repository returns the file bytes and does not refresh it', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'published', description: 'clone me' });
      const fullName = `${user.username}/published`;
      commitToBare(barePath(user.username, 'published'), {
        files: { 'notes.txt': 'clone-bytes-9f3\n' },
        message: 'publish notes',
      });
      setUpdatedAt(ctx.db, fullName, FROZEN);

      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-clone-'));
      try {
        const cloned = await runGit(['clone', remoteUrl(ctx, user.username, 'published'), dest], { timeout: 20000 });
        assert.equal(cloned.code, 0, cloned.stderr);
        assert.equal(fs.readFileSync(path.join(dest, 'notes.txt'), 'utf8'), 'clone-bytes-9f3\n');
      } finally {
        fs.rmSync(dest, { recursive: true, force: true });
      }

      await assertUpdatedAtStays(ctx.db, fullName, FROZEN);

      const missingDest = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-missing-'));
      try {
        const missing = await runGit(
          ['clone', remoteUrl(ctx, user.username, 'does-not-exist'), missingDest],
          { timeout: 20000 }
        );
        assert.notEqual(missing.code, 0);
      } finally {
        fs.rmSync(missingDest, { recursive: true, force: true });
      }
      assert.equal(repoRow(ctx.db, `${user.username}/does-not-exist`), undefined);
    });
  });

  test('git receive-pack rejects the account email even when the password is correct', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'writes', description: '' });
      const fullName = `${user.username}/writes`;
      commitToBare(barePath(user.username, 'writes'), {
        files: { 'keep.txt': 'original-bytes\n' },
        message: 'base',
      });
      const head = gitSync(['--git-dir', barePath(user.username, 'writes'), 'rev-parse', 'HEAD']).trim();
      setUpdatedAt(ctx.db, fullName, FROZEN);

      const asEmail = await pushFiles({
        url: `http://${encodeURIComponent(user.email)}:${encodeURIComponent(user.password)}@127.0.0.1:${ctx.port}/${encodeURIComponent(user.username)}/writes.git`,
        files: { 'keep.txt': 'replaced-bytes\n' },
        message: 'email push',
        force: true,
      });
      assert.notEqual(asEmail.code, 0);
      await assertUpdatedAtStays(ctx.db, fullName, FROZEN);
      assert.equal(gitSync(['--git-dir', barePath(user.username, 'writes'), 'rev-parse', 'HEAD']).trim(), head);

      const blob = await (await owner.fetch(`/${user.username}/writes/blob/main/keep.txt`)).text();
      assert.match(blob, /original-bytes/);
      assert.equal(blob.includes('replaced-bytes'), false);
    });
  });

  test('a registration cookie lasts seven days and the homepage hero follows that session', async () => {
    await withApp(async (ctx) => {
      const anon = await (await ctx.session().fetch('/')).text();
      assert.match(anon, /Start for free/);
      assert.match(anon, /Sign in/);
      assert.equal(anon.includes('Create a repository'), false);
      assert.equal(anon.includes('My repos'), false);

      const session = ctx.session();
      const username = ctx.nextId('session');
      const email = `${username}@example.test`;
      const password = 'correct-horse';
      ctx.users.add(username);
      const created = await session.postForm('/register', { username, email, password });
      assert.equal(created.status, 302);
      assert.equal(created.headers.get('location'), '/');
      const cookies = created.headers.getSetCookie();
      const sessionCookie = cookies.find((cookie) => cookie.startsWith('connect.sid='));
      assert.ok(sessionCookie);
      assert.match(sessionCookie, /HttpOnly/);
      assert.match(sessionCookie, /Path=\//);
      const expires = sessionCookie.match(/Expires=([^;]+)/);
      assert.ok(expires);
      const lifetimeMs = new Date(expires[1]).getTime() - Date.now();
      assert.ok(lifetimeMs > (SEVEN_DAYS - 120) * 1000);
      assert.ok(lifetimeMs < (SEVEN_DAYS + 120) * 1000);
      assert.equal(cookies.join('\n').includes(password), false);
      await created.text();

      const home = await (await session.fetch('/')).text();
      assert.match(home, new RegExp(username));
      assert.match(home, /Create a repository/);
      assert.match(home, /My repos/);
      assert.equal(home.includes('Start for free'), false);
      assert.equal(home.includes(password), false);
    });
  });

  test('a private repository leaves the homepage empty and stays off other profiles', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      const secret = `ONLY_PRIVATE_${ctx.nextId('sec')}`;
      await createRepo(owner, { name: 'vault-empty', description: secret, isPrivate: true });

      for (const session of [owner, ctx.session()]) {
        const home = await (await session.fetch('/')).text();
        assert.match(home, /No public repositories yet/);
        assert.equal(home.includes('vault-empty'), false);
        assert.equal(home.includes(secret), false);
      }

      const ownProfile = await (await owner.fetch(`/@${encodeURIComponent(user.username)}`)).text();
      assert.match(ownProfile, /vault-empty/);
      assert.match(ownProfile, new RegExp(secret));

      const stranger = ctx.session();
      await registerUser(ctx, stranger);
      const hidden = await (await stranger.fetch(`/@${encodeURIComponent(user.username)}`)).text();
      assert.equal(hidden.includes('vault-empty'), false);
      assert.equal(hidden.includes(secret), false);
      assert.match(hidden, /No repositories yet/);
    });
  });

  test('a blob numbers each line and keeps a trailing-free file at that count', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'lines', description: '' });
      commitToBare(barePath(user.username, 'lines'), {
        files: { 'count.txt': 'alpha\nbeta' },
        message: 'two lines',
      });

      const html = await (await ctx.session().fetch(`/${user.username}/lines/blob/main/count.txt`)).text();
      assert.match(html, /2 lines/);
      assert.match(html, /class="line-number">1</);
      assert.match(html, /class="line-number">2</);
      assert.equal(html.includes('class="line-number">3<'), false);
      assert.match(html, /<pre>alpha<\/pre>/);
      assert.match(html, /<pre>beta<\/pre>/);
    });
  });

  test('deleting a user removes that user\'s repository rows and leaves another owner intact', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'gone', description: 'cascade-marker' });
      const other = ctx.session();
      const otherUser = await registerUser(ctx, other);
      await createRepo(other, { name: 'stays', description: 'cascade-keep' });

      ctx.db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

      assert.equal(ctx.db.prepare('SELECT id FROM users WHERE id = ?').get(user.id), undefined);
      assert.equal(repoRow(ctx.db, `${user.username}/gone`), undefined);
      assert.ok(repoRow(ctx.db, `${otherUser.username}/stays`));

      const gone = await ctx.session().fetch(`/${user.username}/gone`);
      assert.equal(gone.status, 404);
      await gone.text();
      const kept = await ctx.session().fetch(`/${otherUser.username}/stays`);
      assert.equal(kept.status, 200);
      assert.match(await kept.text(), /cascade-keep/);
      const profile = await ctx.session().fetch(`/@${encodeURIComponent(user.username)}`);
      assert.equal(profile.status, 404);
      await profile.text();
    });
  });
});
