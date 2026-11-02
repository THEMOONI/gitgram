const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const {
  assertUpdatedAtStays,
  barePath,
  basicAuth,
  commitToBare,
  createRepo,
  gitSync,
  passwordHash,
  registerUser,
  repoRow,
  setUpdatedAt,
  start,
  waitForUpdatedAt,
} = require('./helpers');

const FROZEN = '2018-04-01 00:00:00';
const NEW_PASSWORD = 'replacement-horse-z8';

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

describe('account identity and stored passwords', { concurrency: 1 }, () => {
  test('the same password is stored as two hashes and each username stays its own account', async () => {
    await withApp(async (ctx) => {
      const password = 'shared-horse-z3';
      const firstSession = ctx.session();
      const first = await registerUser(ctx, firstSession, { password });
      const secondSession = ctx.session();
      const second = await registerUser(ctx, secondSession, { password });
      await createRepo(firstSession, { name: 'vault', description: 'FIRST_SECRET_z3', isPrivate: true });
      await createRepo(secondSession, { name: 'vault', description: 'SECOND_SECRET_z3', isPrivate: true });

      const firstHash = passwordHash(ctx.db, first.username);
      const secondHash = passwordHash(ctx.db, second.username);
      assert.match(firstHash, /^\$2[aby]\$10\$/);
      assert.match(secondHash, /^\$2[aby]\$10\$/);
      assert.notEqual(firstHash, secondHash);
      assert.notEqual(firstHash, password);
      assert.notEqual(secondHash, password);
      assert.notEqual(first.id, second.id);

      const firstHome = await (await firstSession.fetch('/')).text();
      assert.match(firstHome, new RegExp(`/@${first.username}\\b`));
      assert.doesNotMatch(firstHome, new RegExp(`/@${second.username}\\b`));
      const secondHome = await (await secondSession.fetch('/')).text();
      assert.match(secondHome, new RegExp(`/@${second.username}\\b`));
      assert.doesNotMatch(secondHome, new RegExp(`/@${first.username}\\b`));

      const firstPage = await (await firstSession.fetch(`/${first.username}/vault`)).text();
      assert.match(firstPage, /FIRST_SECRET_z3/);
      assert.equal(firstPage.includes('SECOND_SECRET_z3'), false);
      const secondPage = await (await secondSession.fetch(`/${second.username}/vault`)).text();
      assert.match(secondPage, /SECOND_SECRET_z3/);
      assert.equal(secondPage.includes('FIRST_SECRET_z3'), false);
      const crossed = await firstSession.fetch(`/${second.username}/vault`);
      assert.equal(crossed.status, 404);
      assert.equal((await crossed.text()).includes('SECOND_SECRET_z3'), false);

      const again = ctx.session();
      const loggedIn = await again.postForm('/login', { username: first.username, password });
      assert.equal(loggedIn.status, 302);
      assert.equal(loggedIn.headers.get('location'), '/');
      await loggedIn.text();
      const againPage = await (await again.fetch(`/${first.username}/vault`)).text();
      assert.match(againPage, /FIRST_SECRET_z3/);
      assert.equal(againPage.includes('SECOND_SECRET_z3'), false);
      const otherName = await again.fetch(`/${second.username}/vault`);
      assert.equal(otherName.status, 404);
      assert.equal((await otherName.text()).includes('SECOND_SECRET_z3'), false);

      assert.equal(passwordHash(ctx.db, first.username), firstHash);
      assert.equal(passwordHash(ctx.db, second.username), secondHash);
      const home = await (await ctx.session().fetch('/')).text();
      assert.equal(home.includes('FIRST_SECRET_z3'), false);
      assert.equal(home.includes('SECOND_SECRET_z3'), false);
      assert.equal(home.includes(password), false);
      assert.equal(home.includes(firstHash), false);
    });
  });

  test('replacing the stored hash retires the old password and keeps the existing session', async () => {
    await withApp(async (ctx) => {
      const ownerSession = ctx.session();
      const user = await registerUser(ctx, ownerSession, { password: 'original-horse-z8' });
      await createRepo(ownerSession, { name: 'vault', description: 'HASH_SECRET_z8', isPrivate: true });
      await createRepo(ownerSession, { name: 'notes', description: 'PUBLIC_SIBLING_z8' });
      const bare = barePath(user.username, 'vault');
      commitToBare(bare, { files: { 'keep.txt': 'KEEP_SECRET_z8\n' }, message: 'keep-secret' });
      const head = gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim();
      const target = `${user.username}/vault`;
      const sibling = `${user.username}/notes`;
      const originalHash = passwordHash(ctx.db, user.username);
      const replacement = bcrypt.hashSync(NEW_PASSWORD, 10);
      ctx.db.prepare('UPDATE users SET password = ? WHERE id = ?').run(replacement, user.id);
      assert.notEqual(passwordHash(ctx.db, user.username), originalHash);
      assert.match(passwordHash(ctx.db, user.username), /^\$2[aby]\$10\$/);
      setUpdatedAt(ctx.db, target, FROZEN);
      setUpdatedAt(ctx.db, sibling, FROZEN);

      const still = await ownerSession.fetch(`/${user.username}/vault/blob/main/keep.txt`);
      const stillText = await still.text();
      assert.equal(still.status, 200);
      assert.match(stillText, /KEEP_SECRET_z8/);
      assert.match(await (await ownerSession.fetch('/')).text(), /Log out/);
      const stranger = ctx.session();
      const hidden = await stranger.fetch(`/${user.username}/vault`);
      const hiddenText = await hidden.text();
      assert.equal(hidden.status, 404);
      assert.equal(hiddenText.includes('HASH_SECRET_z8'), false);
      assert.equal(hiddenText.includes('KEEP_SECRET_z8'), false);

      const retired = ctx.session();
      const denied = await retired.postForm('/login', { username: user.username, password: user.password });
      const deniedText = await denied.text();
      assert.equal(denied.status, 200);
      assert.equal(denied.headers.get('location'), null);
      assert.match(deniedText, /Invalid credentials/);
      assert.equal(deniedText.includes(user.password), false);
      assert.equal(deniedText.includes(NEW_PASSWORD), false);
      assert.equal(deniedText.includes(originalHash), false);
      assert.equal(deniedText.includes(passwordHash(ctx.db, user.username)), false);
      assert.doesNotMatch(await (await retired.fetch('/')).text(), /Log out/);

      const pack = `/${user.username}/vault/git-receive-pack`;
      const oldBasic = await stranger.fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(user.username, user.password) },
        body: '',
      });
      const oldBasicText = await oldBasic.text();
      assert.equal(oldBasic.status, 401);
      assert.equal(oldBasic.headers.get('www-authenticate'), 'Basic realm="GITGRAM"');
      assert.equal(oldBasicText.includes(user.password), false);
      assert.equal(oldBasicText.includes(NEW_PASSWORD), false);
      assert.equal(oldBasicText.includes(originalHash), false);
      await assertUpdatedAtStays(ctx.db, target, FROZEN, 400);
      assert.equal(repoRow(ctx.db, sibling).updated_at, FROZEN);
      assert.equal(gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim(), head);

      const fresh = ctx.session();
      const accepted = await fresh.postForm('/login', { username: user.email, password: NEW_PASSWORD });
      assert.equal(accepted.status, 302);
      assert.equal(accepted.headers.get('location'), '/');
      await accepted.text();
      const freshBlob = await (await fresh.fetch(`/${user.username}/vault/blob/main/keep.txt`)).text();
      assert.match(freshBlob, /KEEP_SECRET_z8/);
      assert.equal(freshBlob.includes(NEW_PASSWORD), false);
      assert.match(await (await ownerSession.fetch(`/${user.username}/vault`)).text(), /HASH_SECRET_z8/);

      const newBasic = await stranger.fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(user.username, NEW_PASSWORD) },
        body: '',
      });
      const newBasicText = await newBasic.text();
      assert.equal(newBasic.status, 200);
      assert.equal(newBasic.headers.get('content-type'), 'application/x-git-receive-pack-result');
      assert.equal(newBasicText.includes(user.password), false);
      assert.equal(newBasicText.includes(NEW_PASSWORD), false);
      assert.equal(newBasicText.includes(passwordHash(ctx.db, user.username)), false);
      const refreshed = await waitForUpdatedAt(ctx.db, target, FROZEN);
      assert.notEqual(refreshed, FROZEN);
      assert.equal(repoRow(ctx.db, sibling).updated_at, FROZEN);
      assert.equal(gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim(), head);
      assert.equal(passwordHash(ctx.db, user.username), replacement);
      const found = await (await ctx.session().fetch('/api/search/repos?q=HASH_SECRET_z8')).json();
      assert.deepEqual(found, []);
    });
  });

  test('a username equal to another account email stays a separate account', async () => {
    await withApp(async (ctx) => {
      const adaSession = ctx.session();
      const ada = await registerUser(ctx, adaSession, { password: 'ada-secret-z4' });
      const beaSession = ctx.session();
      const bea = await registerUser(ctx, beaSession, {
        username: ada.email,
        email: `bea-${ada.username}@example.test`,
        password: 'bea-secret-z4',
      });
      await createRepo(adaSession, { name: 'vault', description: 'ADA_SECRET_z4', isPrivate: true });
      await createRepo(beaSession, { name: 'vault', description: 'BEA_SECRET_z4', isPrivate: true });
      commitToBare(barePath(ada.username, 'vault'), { files: { 'keep.txt': 'ADA_FILE_z4\n' }, message: 'ada-ship' });
      commitToBare(barePath(bea.username, 'vault'), { files: { 'keep.txt': 'BEA_FILE_z4\n' }, message: 'bea-ship' });
      const adaName = `${ada.username}/vault`;
      const beaName = `${bea.username}/vault`;
      setUpdatedAt(ctx.db, adaName, FROZEN);
      setUpdatedAt(ctx.db, beaName, FROZEN);
      const adaHash = passwordHash(ctx.db, ada.username);
      const beaHash = passwordHash(ctx.db, bea.username);
      assert.notEqual(ada.id, bea.id);
      assert.notEqual(adaHash, beaHash);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);

      const adaLogin = ctx.session();
      const adaOk = await adaLogin.postForm('/login', { username: ada.username, password: ada.password });
      assert.equal(adaOk.status, 302);
      await adaOk.text();
      const adaPage = await (await adaLogin.fetch(`/${encodeURIComponent(ada.username)}/vault`)).text();
      assert.match(adaPage, /ADA_SECRET_z4/);
      assert.match(adaPage, /keep\.txt/);
      assert.match(adaPage, /ada-ship/);
      assert.equal(adaPage.includes('ADA_FILE_z4'), false);
      assert.equal(adaPage.includes('BEA_SECRET_z4'), false);
      assert.equal(adaPage.includes('BEA_FILE_z4'), false);
      const adaBlob = await (await adaLogin.fetch(`/${encodeURIComponent(ada.username)}/vault/blob/main/keep.txt`)).text();
      assert.match(adaBlob, /ADA_FILE_z4/);
      assert.equal(adaBlob.includes('BEA_FILE_z4'), false);

      const beaLogin = ctx.session();
      const beaOk = await beaLogin.postForm('/login', { username: bea.email, password: bea.password });
      assert.equal(beaOk.status, 302);
      await beaOk.text();
      const beaPage = await (await beaLogin.fetch(`/${encodeURIComponent(bea.username)}/vault/blob/main/keep.txt`)).text();
      assert.match(beaPage, /BEA_FILE_z4/);
      assert.equal(beaPage.includes('ADA_FILE_z4'), false);
      const beaCross = await beaLogin.fetch(`/${encodeURIComponent(ada.username)}/vault`);
      assert.equal(beaCross.status, 404);
      assert.equal((await beaCross.text()).includes('ADA_SECRET_z4'), false);

      const wrongAda = ctx.session();
      const adaDenied = await wrongAda.postForm('/login', { username: ada.username, password: bea.password });
      const adaDeniedText = await adaDenied.text();
      assert.equal(adaDenied.status, 200);
      assert.match(adaDeniedText, /Invalid credentials/);
      assert.equal(adaDeniedText.includes(ada.password), false);
      assert.equal(adaDeniedText.includes(bea.password), false);
      assert.equal(adaDeniedText.includes(adaHash), false);
      assert.doesNotMatch(await (await wrongAda.fetch('/')).text(), /Log out/);

      const wrongBea = ctx.session();
      const beaDenied = await wrongBea.postForm('/login', { username: bea.email, password: ada.password });
      assert.equal(beaDenied.status, 200);
      assert.match(await beaDenied.text(), /Invalid credentials/);
      assert.equal(passwordHash(ctx.db, ada.username), adaHash);
      assert.equal(passwordHash(ctx.db, bea.username), beaHash);

      const pack = `/${encodeURIComponent(bea.username)}/vault/git-receive-pack`;
      const adaOnBea = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(bea.username, ada.password) },
        body: '',
      });
      const adaOnBeaText = await adaOnBea.text();
      assert.equal(adaOnBea.status, 401);
      assert.equal(adaOnBea.headers.get('www-authenticate'), 'Basic realm="GITGRAM"');
      assert.equal(adaOnBeaText.includes(ada.password), false);
      assert.equal(adaOnBeaText.includes(bea.password), false);
      await assertUpdatedAtStays(ctx.db, beaName, FROZEN, 400);
      assert.equal(repoRow(ctx.db, adaName).updated_at, FROZEN);

      const beaPack = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(bea.username, bea.password) },
        body: '',
      });
      assert.equal(beaPack.status, 200);
      assert.equal(beaPack.headers.get('content-type'), 'application/x-git-receive-pack-result');
      await beaPack.text();
      const refreshed = await waitForUpdatedAt(ctx.db, beaName, FROZEN);
      assert.notEqual(refreshed, FROZEN);
      assert.equal(repoRow(ctx.db, adaName).updated_at, FROZEN);
      assert.match(
        await (await adaSession.fetch(`/${encodeURIComponent(ada.username)}/vault/blob/main/keep.txt`)).text(),
        /ADA_FILE_z4/
      );
      const anon = await (await ctx.session().fetch('/')).text();
      assert.equal(anon.includes('ADA_SECRET_z4'), false);
      assert.equal(anon.includes('BEA_SECRET_z4'), false);
      assert.deepEqual(await (await ctx.session().fetch('/api/search/repos?q=ADA_SECRET_z4')).json(), []);
      assert.deepEqual(await (await ctx.session().fetch('/api/search/repos?q=BEA_SECRET_z4')).json(), []);
    });
  });

  test('a padded repository name is trimmed and the description keeps its spaces', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const user = await registerUser(ctx, session);
      const created = await session.postForm('/new', {
        name: '  spaced-name  ',
        description: '  PAD_DESC_z5  ',
      });
      assert.equal(created.status, 302);
      assert.equal(created.headers.get('location'), `/${user.username}/spaced-name`);
      await created.text();

      const row = repoRow(ctx.db, `${user.username}/spaced-name`);
      assert.equal(row.name, 'spaced-name');
      assert.equal(row.full_name, `${user.username}/spaced-name`);
      assert.equal(row.description, '  PAD_DESC_z5  ');
      assert.equal(row.private, 0);
      assert.equal(repoRow(ctx.db, `${user.username}/  spaced-name  `), undefined);
      assert.equal(fs.existsSync(barePath(user.username, 'spaced-name')), true);
      assert.equal(fs.existsSync(barePath(user.username, '  spaced-name  ')), false);
      assert.equal(
        gitSync(['--git-dir', barePath(user.username, 'spaced-name'), 'symbolic-ref', 'HEAD']).trim(),
        'refs/heads/main'
      );

      const page = await (await session.fetch(`/${user.username}/spaced-name`)).text();
      assert.match(page, /  PAD_DESC_z5  /);
      assert.equal(page.includes('undefined'), false);
      const home = await (await ctx.session().fetch('/')).text();
      assert.match(home, /  PAD_DESC_z5  /);
      const found = await (await ctx.session().fetch(`/api/search/repos?q=${encodeURIComponent('PAD_DESC_z5')}`)).json();
      assert.equal(found.length, 1);
      assert.equal(found[0].name, 'spaced-name');
      assert.equal(found[0].description, '  PAD_DESC_z5  ');
      assert.equal(Object.hasOwn(found[0], 'password'), false);

      const spaces = await session.postForm('/new', { name: 'blank-desc', description: '   ' });
      assert.equal(spaces.status, 302);
      assert.equal(spaces.headers.get('location'), `/${user.username}/blank-desc`);
      await spaces.text();
      assert.equal(repoRow(ctx.db, `${user.username}/blank-desc`).description, '   ');
      const blankPage = await (await session.fetch(`/${user.username}/blank-desc`)).text();
      assert.equal(blankPage.includes('undefined'), false);
      assert.equal(blankPage.includes('>null<'), false);
      assert.equal(repoRow(ctx.db, `${user.username}/spaced-name`).description, '  PAD_DESC_z5  ');
    });
  });
});
