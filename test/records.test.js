const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertUpdatedAtStays,
  barePath,
  createRepo,
  gitSync,
  passwordHash,
  pushFiles,
  registerUser,
  remoteUrl,
  repoRow,
  setUpdatedAt,
  start,
  waitForUpdatedAt,
} = require('./helpers');

const FROZEN = '2000-01-01 00:00:00';
const CREATED = '1999-05-01 00:00:00';
const JOINED = '2024-03-15 08:00:00';
const OFFSITE = 'https://evil.example/phish';

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

describe('repository row identity and auth redirects', { concurrency: 1 }, () => {
  test('an owner push refreshes updated_at and leaves the rest of the row', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'locked', description: 'PRIVATE_ROW_DESC_z8', isPrivate: true });
      await createRepo(owner, { name: 'open-sibling', description: 'SIBLING_ROW_DESC_z8' });
      const fullName = `${user.username}/locked`;
      const siblingName = `${user.username}/open-sibling`;
      const hash = passwordHash(ctx.db, user.username);
      ctx.db.prepare('UPDATE repositories SET created_at = ? WHERE full_name = ?').run(CREATED, fullName);
      ctx.db.prepare('UPDATE repositories SET created_at = ? WHERE full_name = ?').run(CREATED, siblingName);
      setUpdatedAt(ctx.db, fullName, FROZEN);
      setUpdatedAt(ctx.db, siblingName, FROZEN);
      const before = repoRow(ctx.db, fullName);

      const pushed = await pushFiles({
        url: remoteUrl(ctx, user.username, 'locked', user.password),
        files: { 'keep.txt': 'ROW_PUSH_BODY_z8\n' },
        message: 'row-push-z8',
      });
      assert.equal(pushed.code, 0, pushed.stderr);
      const refreshed = await waitForUpdatedAt(ctx.db, fullName, FROZEN);
      assert.notEqual(refreshed, FROZEN);

      const after = repoRow(ctx.db, fullName);
      assert.equal(after.id, before.id);
      assert.equal(after.name, 'locked');
      assert.equal(after.full_name, fullName);
      assert.equal(after.description, 'PRIVATE_ROW_DESC_z8');
      assert.equal(after.owner_id, user.id);
      assert.equal(after.private, 1);
      assert.equal(after.default_branch, 'main');
      assert.equal(after.created_at, CREATED);
      assert.equal(after.updated_at, refreshed);
      assert.equal(passwordHash(ctx.db, user.username), hash);
      assert.equal(
        gitSync(['--git-dir', barePath(user.username, 'locked'), 'symbolic-ref', 'HEAD']).trim(),
        'refs/heads/main'
      );
      assert.equal(
        gitSync(['--git-dir', barePath(user.username, 'locked'), 'show', 'HEAD:keep.txt']),
        'ROW_PUSH_BODY_z8\n'
      );

      const sibling = repoRow(ctx.db, siblingName);
      assert.equal(sibling.updated_at, FROZEN);
      assert.equal(sibling.created_at, CREATED);
      assert.equal(sibling.private, 0);
      assert.equal(sibling.description, 'SIBLING_ROW_DESC_z8');
      assert.equal(sibling.owner_id, user.id);
      assert.equal(
        gitSync(['--git-dir', barePath(user.username, 'open-sibling'), 'symbolic-ref', 'HEAD']).trim(),
        'refs/heads/main'
      );

      const stranger = ctx.session();
      await registerUser(ctx, stranger);
      const hidden = await stranger.fetch(`/${user.username}/locked`);
      const hiddenHtml = await hidden.text();
      assert.equal(hidden.status, 404);
      assert.equal(hiddenHtml.includes('PRIVATE_ROW_DESC_z8'), false);
      assert.equal(hiddenHtml.includes('ROW_PUSH_BODY_z8'), false);

      const blob = await owner.fetch(`/${user.username}/locked/blob/main/keep.txt`);
      assert.equal(blob.status, 200);
      assert.match(await blob.text(), /ROW_PUSH_BODY_z8/);

      const page = await (await owner.fetch(`/${user.username}/locked`)).text();
      assert.match(page, /badge-private/);
      assert.match(page, /PRIVATE_ROW_DESC_z8/);
      assert.match(page, /class="branch-badge">🔀 main</);
      assert.match(page, /keep\.txt/);
      assert.equal(page.includes('ROW_PUSH_BODY_z8'), false);

      const home = await (await ctx.session().fetch('/')).text();
      assert.match(home, /SIBLING_ROW_DESC_z8/);
      assert.equal(home.includes('PRIVATE_ROW_DESC_z8'), false);
      assert.equal(home.includes('ROW_PUSH_BODY_z8'), false);

      const found = await (await stranger.fetch('/api/search/repos?q=PRIVATE_ROW_DESC_z8')).json();
      assert.deepEqual(found, []);
      const listed = await (await stranger.fetch(`/api/users/${encodeURIComponent(user.username)}/repos`)).json();
      assert.deepEqual(listed.map((repo) => repo.name), ['open-sibling']);
      const own = await (await owner.fetch(`/api/users/${encodeURIComponent(user.username)}/repos`)).json();
      assert.deepEqual(own.map((repo) => repo.name), ['locked', 'open-sibling']);
      assert.equal(own[0].private, 1);
      assert.equal(own[0].default_branch, 'main');
      assert.equal(own[0].created_at, CREATED);
      assert.equal(Object.hasOwn(own[0], 'password'), false);

      await assertUpdatedAtStays(ctx.db, siblingName, FROZEN);
    });
  });

  test('login, register, logout, and new ignore an off-site next URL', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'vault', description: 'NEXT_PRIVATE_DESC_z8', isPrivate: true });
      const next = encodeURIComponent(OFFSITE);

      const anon = ctx.session();
      const login = await anon.fetch(`/login?next=${next}`);
      const loginHtml = await login.text();
      assert.equal(login.status, 200);
      assert.match(loginHtml, /action="\/login"/);
      assert.equal(loginHtml.includes('evil.example'), false);
      assert.doesNotMatch(await (await anon.fetch('/')).text(), /Log out/);

      const register = await anon.fetch(`/register?next=${next}&return=${next}`);
      const registerHtml = await register.text();
      assert.equal(register.status, 200);
      assert.match(registerHtml, /action="\/register"/);
      assert.equal(registerHtml.includes('evil.example'), false);

      const anonNew = await anon.fetch(`/new?next=${next}`);
      assert.equal(anonNew.status, 302);
      assert.equal(anonNew.headers.get('location'), '/login');
      await anonNew.text();

      const ownerLogin = await owner.fetch(`/login?next=${next}`);
      assert.equal(ownerLogin.status, 302);
      assert.equal(ownerLogin.headers.get('location'), '/');
      await ownerLogin.text();

      const ownerRegister = await owner.fetch(`/register?return=${next}`);
      assert.equal(ownerRegister.status, 302);
      assert.equal(ownerRegister.headers.get('location'), '/');
      await ownerRegister.text();

      const ownerNew = await owner.fetch(`/new?next=${next}`);
      const ownerNewHtml = await ownerNew.text();
      assert.equal(ownerNew.status, 200);
      assert.match(ownerNewHtml, /action="\/new"/);
      assert.equal(ownerNewHtml.includes('evil.example'), false);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n, 1);

      const loggedOut = await owner.fetch(`/logout?next=${next}&return=${next}`);
      assert.equal(loggedOut.status, 302);
      assert.equal(loggedOut.headers.get('location'), '/');
      assert.equal(String(loggedOut.headers.get('location')).includes('evil.example'), false);
      await loggedOut.text();

      const home = await (await owner.fetch('/')).text();
      assert.doesNotMatch(home, /Log out/);
      assert.equal(home.includes('NEXT_PRIVATE_DESC_z8'), false);
      const hidden = await owner.fetch(`/${user.username}/vault`);
      const hiddenHtml = await hidden.text();
      assert.equal(hidden.status, 404);
      assert.equal(hiddenHtml.includes('NEXT_PRIVATE_DESC_z8'), false);

      const anonOut = await ctx.session().fetch(`/logout?next=${next}`);
      assert.equal(anonOut.status, 302);
      assert.equal(anonOut.headers.get('location'), '/');
      await anonOut.text();
    });
  });

  test('the profile shows the stored join month', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      ctx.db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(JOINED, user.id);

      const html = await (await owner.fetch(`/@${encodeURIComponent(user.username)}`)).text();
      assert.match(html, /Joined March 2024/);
      assert.equal(html.includes('Joined October'), false);
      assert.match(html, /New Repository/);

      const stranger = ctx.session();
      await registerUser(ctx, stranger);
      const other = await (await stranger.fetch(`/@${encodeURIComponent(user.username)}`)).text();
      assert.match(other, /Joined March 2024/);
      assert.equal(other.includes('New Repository'), false);
      assert.equal(other.includes('Create your first repository'), false);
    });
  });
});
