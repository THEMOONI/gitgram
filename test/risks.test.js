const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  assertUpdatedAtStays,
  barePath,
  basicAuth,
  commitToBare,
  createRepo,
  passwordHash,
  registerUser,
  repoRow,
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

describe('account, git auth, and rendered-data boundaries', { concurrency: 1 }, () => {
  test('the owner can delete a private repository and the secret leaves every surface', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      const secret = `PRIVATE_DELETE_${ctx.nextId('sec')}`;
      await createRepo(owner, { name: 'vault', description: secret, isPrivate: true });
      commitToBare(barePath(user.username, 'vault'), {
        files: { 'readme.txt': `${secret}-file\n` },
        message: 'private',
      });
      const stranger = ctx.session();
      await registerUser(ctx, stranger);

      const settings = await owner.fetch(`/${user.username}/vault/settings`);
      const settingsHtml = await settings.text();
      assert.equal(settings.status, 200);
      assert.match(settingsHtml, /Delete this repository/);
      assert.match(settingsHtml, new RegExp(`action="/${user.username}/vault/settings/delete"`));

      const hidden = await stranger.fetch(`/${user.username}/vault/settings`);
      assert.equal(hidden.status, 404);
      assert.equal((await hidden.text()).includes(secret), false);

      const removed = await owner.postForm(`/${user.username}/vault/settings/delete`, {});
      assert.equal(removed.status, 302);
      assert.equal(removed.headers.get('location'), `/@${user.username}`);
      await removed.text();

      assert.equal(repoRow(ctx.db, `${user.username}/vault`), undefined);
      assert.equal(fs.existsSync(barePath(user.username, 'vault')), false);

      for (const session of [owner, stranger, ctx.session()]) {
        const page = await session.fetch(`/${user.username}/vault`);
        assert.equal(page.status, 404);
        assert.equal((await page.text()).includes(secret), false);
        const profile = await (await session.fetch(`/@${encodeURIComponent(user.username)}`)).text();
        assert.equal(profile.includes(secret), false);
        assert.equal(profile.includes('vault'), false);
      }

      const listed = await (await owner.fetch(`/api/users/${encodeURIComponent(user.username)}/repos`)).json();
      assert.deepEqual(listed, []);
      const home = await (await ctx.session().fetch('/')).text();
      assert.equal(home.includes(secret), false);
    });
  });

  test('a deleted account session cannot create or delete a repository, and login does not recreate it', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'mine', description: 'gone-with-user' });
      const victim = ctx.session();
      const victimUser = await registerUser(ctx, victim);
      await createRepo(victim, { name: 'theirs', description: 'VICTIM_KEEP' });
      commitToBare(barePath(victimUser.username, 'theirs'), {
        files: { 'keep.txt': 'victim-bytes\n' },
        message: 'keep',
      });
      const hash = passwordHash(ctx.db, victimUser.username);
      const reposBefore = ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n;

      ctx.db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      assert.equal(ctx.db.prepare('SELECT id FROM users WHERE id = ?').get(user.id), undefined);
      assert.equal(repoRow(ctx.db, `${user.username}/mine`), undefined);

      const retry = ctx.session();
      const login = await retry.postForm('/login', {
        username: user.username,
        password: user.password,
      });
      assert.equal(login.status, 200);
      assert.match(await login.text(), /Invalid credentials/);
      assert.equal(ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(user.username), undefined);
      assert.equal((await (await retry.fetch('/')).text()).includes('Log out'), false);

      const created = await owner.postForm('/new', { name: 'sneaky', description: 'should-not-land' });
      assert.notEqual(created.status, 302);
      const createdHtml = await created.text();
      assert.equal(createdHtml.includes('should-not-land'), false);
      assert.equal(repoRow(ctx.db, `${user.username}/sneaky`), undefined);
      assert.equal(fs.existsSync(barePath(user.username, 'sneaky')), false);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n, reposBefore - 1);

      const denied = await owner.postForm(`/${victimUser.username}/theirs/settings/delete`, {});
      assert.equal(denied.status, 403);
      assert.equal((await denied.text()).includes('victim-bytes'), false);
      assert.equal(repoRow(ctx.db, `${victimUser.username}/theirs`).description, 'VICTIM_KEEP');
      assert.equal(passwordHash(ctx.db, victimUser.username), hash);
      const blob = await victim.fetch(`/${victimUser.username}/theirs/blob/main/keep.txt`);
      assert.equal(blob.status, 200);
      assert.match(await blob.text(), /victim-bytes/);

      const home = await (await owner.fetch('/')).text();
      assert.equal(home.includes('Log out'), false);
      assert.equal(home.includes(user.username), false);
    });
  });

  test('an unknown login does not authenticate or create an account', async () => {
    await withApp(async (ctx) => {
      const username = ctx.nextId('missing');
      const session = ctx.session();
      const res = await session.postForm('/login', { username, password: 'not-a-real-password' });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Invalid credentials/);
      assert.equal(ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username), undefined);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
      const home = await (await session.fetch('/')).text();
      assert.match(home, /Start for free/);
      assert.equal(home.includes('Log out'), false);
    });
  });

  test('account email and password stay off other people\'s pages and the API', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const username = ctx.nextId('owner');
      const email = `mailbox-${ctx.nextId('box')}@hidden.example`;
      const password = `pw-${ctx.nextId('secret')}-keep`;
      const user = await registerUser(ctx, owner, { username, email, password });
      await createRepo(owner, { name: 'public-notes', description: 'visible-notes' });
      const hash = passwordHash(ctx.db, user.username);
      const stranger = ctx.session();
      await registerUser(ctx, stranger);

      const pages = [
        `/${user.username}/public-notes`,
        `/@${encodeURIComponent(user.username)}`,
        '/',
      ];
      for (const session of [ctx.session(), stranger]) {
        for (const pathname of pages) {
          const html = await (await session.fetch(pathname)).text();
          assert.equal(html.includes(email), false, pathname);
          assert.equal(html.includes(password), false, pathname);
          assert.equal(html.includes(hash), false, pathname);
        }
      }

      const ownerProfile = await (await owner.fetch(`/@${encodeURIComponent(user.username)}`)).text();
      assert.equal(ownerProfile.includes(password), false);
      assert.equal(ownerProfile.includes(hash), false);

      for (const session of [owner, stranger, ctx.session()]) {
        const listed = await (await session.fetch(`/api/users/${encodeURIComponent(user.username)}/repos`)).json();
        const body = JSON.stringify(listed);
        assert.equal(body.includes(email), false);
        assert.equal(body.includes(password), false);
        assert.equal(body.includes(hash), false);
        assert.equal(listed.some((repo) => repo.name === 'public-notes'), true);
      }

      const found = await (await ctx.session().fetch('/api/search/repos?q=visible-notes')).json();
      const searchBody = JSON.stringify(found);
      assert.equal(searchBody.includes(email), false);
      assert.equal(searchBody.includes(hash), false);
      assert.equal(found[0].full_name, `${user.username}/public-notes`);
    });
  });

  test('git challenges advertise Basic and a missing upload-pack inserts nothing', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'writes', description: '' });
      const fullName = `${user.username}/writes`;
      setUpdatedAt(ctx.db, fullName, FROZEN);
      const pack = `/${user.username}/writes/git-receive-pack`;

      const attempts = [
        { session: ctx.session(), authorization: undefined },
        { session: owner, authorization: undefined },
        {
          session: ctx.session(),
          authorization: `Basic ${Buffer.from('ghost-user').toString('base64')}`,
        },
        {
          session: ctx.session(),
          authorization: basicAuth(user.username, 'wrong-password'),
        },
      ];

      for (const attempt of attempts) {
        const headers = {};
        if (attempt.authorization) headers.authorization = attempt.authorization;
        const res = await attempt.session.fetch(pack, { method: 'POST', headers, body: '' });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Basic realm="GITGRAM"');
        const text = await res.text();
        assert.equal(text.includes(user.password), false);
        assert.equal(text.includes(passwordHash(ctx.db, user.username)), false);
      }

      await assertUpdatedAtStays(ctx.db, fullName, FROZEN);

      const missing = await ctx.session().fetch(`/${user.username}/no-such-repo/git-upload-pack`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-git-upload-pack-request' },
        body: '0000',
      });
      assert.equal(missing.status, 404);
      assert.match(await missing.text(), /Not found/);
      assert.equal(repoRow(ctx.db, `${user.username}/no-such-repo`), undefined);
      assert.equal(repoRow(ctx.db, fullName).updated_at, FROZEN);
    });
  });

  test('repository descriptions are escaped on the homepage and profile', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      const payload = '<script>alert(1)</script>';
      await createRepo(owner, { name: 'xss-repo', description: payload });
      const escaped = '&lt;script&gt;alert(1)&lt;/script&gt;';

      for (const pathname of ['/', `/@${encodeURIComponent(user.username)}`, `/${user.username}/xss-repo`]) {
        const html = await (await ctx.session().fetch(pathname)).text();
        assert.match(html, new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.equal(html.includes(payload), false, pathname);
        assert.match(html, /<script src="\/js\/app\.js">/);
      }

      const found = await (await ctx.session().fetch('/api/search/repos?q=xss-repo')).json();
      assert.equal(found.length, 1);
      assert.equal(found[0].description, payload);
      assert.equal(Object.hasOwn(found[0], 'password'), false);
    });
  });

  test('JSON registration and login use the same checks as the form', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const username = ctx.nextId('json');
      const email = `${username}@example.test`;
      const password = 'correct-horse';

      const missing = await session.fetch('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, email }),
      });
      assert.equal(missing.status, 200);
      assert.match(await missing.text(), /All fields required/);
      assert.equal(ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username), undefined);

      const tooShort = await session.fetch('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, email, password: 'abcde' }),
      });
      assert.equal(tooShort.status, 200);
      assert.match(await tooShort.text(), /Password too short/);
      assert.equal(ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username), undefined);

      ctx.users.add(username);
      const created = await session.fetch('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, email, password }),
      });
      assert.equal(created.status, 302);
      assert.equal(created.headers.get('location'), '/');
      await created.text();
      const hash = passwordHash(ctx.db, username);
      assert.match(hash, /^\$2[aby]\$/);
      assert.notEqual(hash, password);
      assert.match(await (await session.fetch('/')).text(), /Log out/);

      const wrong = ctx.session();
      const denied = await wrong.fetch('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'not-the-password' }),
      });
      assert.equal(denied.status, 200);
      assert.match(await denied.text(), /Invalid credentials/);
      assert.equal(passwordHash(ctx.db, username), hash);
      assert.doesNotMatch(await (await wrong.fetch('/')).text(), /Log out/);

      const fresh = ctx.session();
      const ok = await fresh.fetch('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: email, password }),
      });
      assert.equal(ok.status, 302);
      assert.equal(ok.headers.get('location'), '/');
      await ok.text();
      const home = await (await fresh.fetch('/')).text();
      assert.match(home, new RegExp(`/@${username}`));
      assert.equal(home.includes(password), false);
    });
  });

  test('an empty repository has an empty commit history', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'empty-hist', description: 'no commits yet please' });

      const history = await owner.fetch(`/${user.username}/empty-hist/commits`);
      const html = await history.text();
      assert.equal(history.status, 200);
      assert.match(html, /No commits yet/);
      assert.equal(html.includes('commit-hash-full'), false);
      assert.equal(html.includes('no commits yet please'), false);

      const stranger = ctx.session();
      const anon = await stranger.fetch(`/${user.username}/empty-hist/commits`);
      assert.equal(anon.status, 200);
      assert.match(await anon.text(), /No commits yet/);
    });
  });
});
