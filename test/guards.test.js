const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  barePath,
  commitToBare,
  createRepo,
  gitSync,
  passwordHash,
  pushFiles,
  registerUser,
  remoteUrl,
  repoRow,
  start,
} = require('./helpers');

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

describe('branch scope, privacy flags, and account switching', { concurrency: 1 }, () => {
  test('commits that exist only on another branch stay off the default branch', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'side', description: 'side branch only' });
      const bare = barePath(user.username, 'side');
      commitToBare(bare, {
        branch: 'dev',
        files: { 'secret-dev.txt': 'DEV_ONLY_BODY\n' },
        message: 'dev-only-message',
      });
      assert.equal(gitSync(['--git-dir', bare, 'symbolic-ref', 'HEAD']).trim(), 'refs/heads/main');

      const page = await ctx.session().fetch(`/${user.username}/side`);
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.match(html, /Quick setup/);
      assert.equal(html.includes('DEV_ONLY_BODY'), false);
      assert.equal(html.includes('dev-only-message'), false);

      const history = await ctx.session().fetch(`/${user.username}/side/commits`);
      const historyHtml = await history.text();
      assert.equal(history.status, 200);
      assert.match(historyHtml, /No commits yet/);
      assert.equal(historyHtml.includes('DEV_ONLY_BODY'), false);
      assert.equal(historyHtml.includes('dev-only-message'), false);

      const mainBlob = await ctx.session().fetch(`/${user.username}/side/blob/main/secret-dev.txt`);
      const mainHtml = await mainBlob.text();
      assert.equal(mainBlob.status, 404);
      assert.equal(mainHtml.includes('DEV_ONLY_BODY'), false);

      const devBlob = await ctx.session().fetch(`/${user.username}/side/blob/dev/secret-dev.txt`);
      const devHtml = await devBlob.text();
      assert.equal(devBlob.status, 200);
      assert.match(devHtml, /DEV_ONLY_BODY/);

      const refs = await ctx.session().fetch(`/${user.username}/side.git/info/refs?service=git-upload-pack`);
      const refsText = await refs.text();
      assert.equal(refs.status, 200);
      assert.match(refsText, /refs\/heads\/dev/);
    });
  });

  test('a private side branch is visible only to the owner', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'vault', description: 'SIDE_PRIVATE_DESC', isPrivate: true });
      commitToBare(barePath(user.username, 'vault'), {
        branch: 'dev',
        files: { 'secret-dev.txt': 'SIDE_PRIVATE_BODY\n' },
        message: 'side-private-message',
      });
      const stranger = ctx.session();
      await registerUser(ctx, stranger);

      for (const pathname of [
        `/${user.username}/vault`,
        `/${user.username}/vault/commits`,
        `/${user.username}/vault/blob/main/secret-dev.txt`,
        `/${user.username}/vault/blob/dev/secret-dev.txt`,
      ]) {
        const res = await stranger.fetch(pathname);
        const html = await res.text();
        assert.equal(res.status, 404, pathname);
        assert.equal(html.includes('SIDE_PRIVATE_BODY'), false, pathname);
        assert.equal(html.includes('SIDE_PRIVATE_DESC'), false, pathname);
        assert.equal(html.includes('side-private-message'), false, pathname);
      }

      const owned = await owner.fetch(`/${user.username}/vault/blob/dev/secret-dev.txt`);
      assert.equal(owned.status, 200);
      assert.match(await owned.text(), /SIDE_PRIVATE_BODY/);

      const page = await (await owner.fetch(`/${user.username}/vault`)).text();
      assert.match(page, /Quick setup/);
      assert.equal(page.includes('SIDE_PRIVATE_BODY'), false);
      assert.ok(repoRow(ctx.db, `${user.username}/vault`));
    });
  });

  test('a missing blob ref does not fall back to HEAD', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'pinned', description: '' });
      commitToBare(barePath(user.username, 'pinned'), {
        files: { 'readme.txt': 'HEAD_BODY\n' },
        message: 'on-main',
      });

      const missing = await ctx.session().fetch(`/${user.username}/pinned/blob/no-such-ref/readme.txt`);
      const missingHtml = await missing.text();
      assert.equal(missing.status, 404);
      assert.equal(missingHtml.includes('HEAD_BODY'), false);
      assert.equal(missingHtml.includes('on-main'), false);

      const head = await ctx.session().fetch(`/${user.username}/pinned/blob/main/readme.txt`);
      assert.equal(head.status, 200);
      assert.match(await head.text(), /HEAD_BODY/);
    });
  });

  test('registering another account switches only that session', async () => {
    await withApp(async (ctx) => {
      const firstSession = ctx.session();
      const first = await registerUser(ctx, firstSession, { password: 'first-password' });
      const firstHash = passwordHash(ctx.db, first.username);
      await createRepo(firstSession, { name: 'vault', description: 'FIRST_PRIVATE_DESC', isPrivate: true });
      commitToBare(barePath(first.username, 'vault'), {
        files: { 'readme.txt': 'FIRST_PRIVATE_BODY\n' },
        message: 'first-private-commit',
      });

      const secondUsername = `Second${ctx.nextId('S')}`;
      const secondPassword = 'second-password';
      ctx.users.add(secondUsername);
      const created = await firstSession.postForm('/register', {
        username: secondUsername,
        email: `${secondUsername}@example.test`,
        password: secondPassword,
      });
      assert.equal(created.status, 302);
      assert.equal(created.headers.get('location'), '/');
      await created.text();

      assert.equal(passwordHash(ctx.db, first.username), firstHash);
      const secondHash = passwordHash(ctx.db, secondUsername);
      assert.notEqual(secondHash, firstHash);
      assert.match(secondHash, /^\$2[aby]\$/);

      const home = await (await firstSession.fetch('/')).text();
      assert.match(home, new RegExp(`/@${secondUsername}`));
      assert.equal(home.includes(`/@${first.username}`), false);
      assert.equal(home.includes('FIRST_PRIVATE_DESC'), false);
      assert.equal(home.includes('FIRST_PRIVATE_BODY'), false);

      const hidden = await firstSession.fetch(`/${first.username}/vault/blob/main/readme.txt`);
      const hiddenHtml = await hidden.text();
      assert.equal(hidden.status, 404);
      assert.equal(hiddenHtml.includes('FIRST_PRIVATE_BODY'), false);

      const made = await createRepo(firstSession, { name: 'notes', description: 'second-notes' });
      assert.equal(made.location, `/${secondUsername}/notes`);
      assert.equal(repoRow(ctx.db, `${first.username}/notes`), undefined);
      assert.equal(repoRow(ctx.db, `${secondUsername}/notes`).description, 'second-notes');

      const again = ctx.session();
      const login = await again.postForm('/login', { username: first.username, password: first.password });
      assert.equal(login.status, 302);
      await login.text();
      const owned = await again.fetch(`/${first.username}/vault/blob/main/readme.txt`);
      assert.equal(owned.status, 200);
      assert.match(await owned.text(), /FIRST_PRIVATE_BODY/);

      const stillHidden = await firstSession.fetch(`/${first.username}/vault`);
      assert.equal(stillHidden.status, 404);
      assert.equal((await stillHidden.text()).includes('FIRST_PRIVATE_BODY'), false);
    });
  });

  test('JSON repository creation honors the privacy flag and requires a session', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);

      const anon = await ctx.session().fetch('/new', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'nope', description: 'should-not-exist', is_private: true }),
      });
      assert.equal(anon.status, 302);
      assert.equal(anon.headers.get('location'), '/login');
      await anon.text();
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n, 0);

      const blank = await owner.fetch('/new', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: 'json-blank', is_private: true }),
      });
      assert.equal(blank.status, 200);
      assert.match(await blank.text(), /Name required/);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n, 0);

      async function createJson(fields) {
        const res = await owner.fetch('/new', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fields),
        });
        const text = await res.text();
        assert.equal(res.status, 302, text.slice(0, 200));
        return res.headers.get('location');
      }

      assert.equal(
        await createJson({ name: 'hidden', description: 'JSON_PRIVATE_DESC', is_private: true }),
        `/${user.username}/hidden`
      );
      assert.equal(
        await createJson({ name: 'shown', description: 'JSON_PUBLIC_DESC', is_private: false }),
        `/${user.username}/shown`
      );
      assert.equal(repoRow(ctx.db, `${user.username}/hidden`).private, 1);
      assert.equal(repoRow(ctx.db, `${user.username}/shown`).private, 0);

      const stranger = ctx.session();
      await registerUser(ctx, stranger);
      const hidden = await stranger.fetch(`/${user.username}/hidden`);
      const hiddenHtml = await hidden.text();
      assert.equal(hidden.status, 404);
      assert.equal(hiddenHtml.includes('JSON_PRIVATE_DESC'), false);
      const shown = await stranger.fetch(`/${user.username}/shown`);
      assert.equal(shown.status, 200);
      assert.match(await shown.text(), /JSON_PUBLIC_DESC/);

      const found = await (await ctx.session().fetch('/api/search/repos?q=JSON_')).json();
      assert.deepEqual(found.map((repo) => repo.name), ['shown']);
      assert.equal(JSON.stringify(found).includes('JSON_PRIVATE_DESC'), false);
    });
  });

  test('an owner push of unrelated history does not replace main', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'shipped', description: 'keep history' });
      const bare = barePath(user.username, 'shipped');
      commitToBare(bare, {
        files: { 'keep.txt': 'version-one\n' },
        message: 'first-ship',
      });
      const hash1 = gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim();

      const pushed = await pushFiles({
        url: remoteUrl(ctx, user.username, 'shipped', user.password),
        files: { 'other.txt': 'replacement\n' },
        message: 'rewrite-ship',
      });
      assert.notEqual(pushed.code, 0);
      assert.equal(gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim(), hash1);
      assert.equal(gitSync(['--git-dir', bare, 'show', 'HEAD:keep.txt']), 'version-one\n');

      const blob = await (await owner.fetch(`/${user.username}/shipped/blob/main/keep.txt`)).text();
      assert.match(blob, /version-one/);
      assert.equal(blob.includes('replacement'), false);
      const other = await owner.fetch(`/${user.username}/shipped/blob/main/other.txt`);
      assert.equal(other.status, 404);
      assert.equal((await other.text()).includes('replacement'), false);
      const history = await (await owner.fetch(`/${user.username}/shipped/commits`)).text();
      assert.match(history, /first-ship/);
      assert.equal(history.includes('rewrite-ship'), false);
    });
  });
});
