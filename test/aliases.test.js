const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  assertUpdatedAtStays,
  barePath,
  basicAuth,
  commitToBare,
  createRepo,
  gitSync,
  insertRepo,
  passwordHash,
  registerUser,
  repoRow,
  setUpdatedAt,
  start,
  waitForUpdatedAt,
} = require('./helpers');

const KEEP_FROZEN = '2015-03-01 00:00:00';
const DROP_FROZEN = '2015-04-01 00:00:00';
const THEIRS_FROZEN = '2015-05-01 00:00:00';
const PLUS_FROZEN = '2015-06-01 00:00:00';
const SPACE_FROZEN = '2015-07-01 00:00:00';
const BASE_FROZEN = '2015-08-01 00:00:00';
const TAG_FROZEN = '2015-09-01 00:00:00';

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function enc(value) {
  return encodeURIComponent(value);
}

describe('delete targets and plus-sign identity', { concurrency: 1 }, () => {
  test('deleting a repository ignores a spoofed id and leaves the named sibling', async () => {
    await withApp(async (ctx) => {
      const ownerSession = ctx.session();
      const owner = await registerUser(ctx, ownerSession);
      const strangerSession = ctx.session();
      const stranger = await registerUser(ctx, strangerSession);
      await createRepo(ownerSession, { name: 'keep-z9', description: 'KEEP_DESC_z9' });
      await createRepo(ownerSession, { name: 'drop-z9', description: 'DROP_DESC_z9' });
      await createRepo(strangerSession, { name: 'theirs-z9', description: 'THEIRS_DESC_z9' });
      const keepPath = barePath(owner.username, 'keep-z9');
      const dropPath = barePath(owner.username, 'drop-z9');
      const theirsPath = barePath(stranger.username, 'theirs-z9');
      commitToBare(keepPath, { files: { 'keep.txt': 'KEEP_BODY_z9\n' }, message: 'keep-ship-z9' });
      commitToBare(dropPath, { files: { 'drop.txt': 'DROP_BODY_z9\n' }, message: 'drop-ship-z9' });
      commitToBare(theirsPath, { files: { 'theirs.txt': 'THEIRS_BODY_z9\n' }, message: 'theirs-ship-z9' });
      const keepHead = gitSync(['--git-dir', keepPath, 'rev-parse', 'HEAD']).trim();
      const theirsHead = gitSync(['--git-dir', theirsPath, 'rev-parse', 'HEAD']).trim();
      const keepName = `${owner.username}/keep-z9`;
      const dropName = `${owner.username}/drop-z9`;
      const theirsName = `${stranger.username}/theirs-z9`;
      setUpdatedAt(ctx.db, keepName, KEEP_FROZEN);
      setUpdatedAt(ctx.db, dropName, DROP_FROZEN);
      setUpdatedAt(ctx.db, theirsName, THEIRS_FROZEN);
      const keep = repoRow(ctx.db, keepName);
      const drop = repoRow(ctx.db, dropName);
      const theirs = repoRow(ctx.db, theirsName);
      const ownerHash = passwordHash(ctx.db, owner.username);
      const strangerHash = passwordHash(ctx.db, stranger.username);

      const spoof = {
        id: String(keep.id),
        name: 'keep-z9',
        full_name: keepName,
        owner_id: String(stranger.id),
        repo_id: String(theirs.id),
      };
      const denied = await strangerSession.postForm(`/${owner.username}/drop-z9/settings/delete`, spoof);
      const deniedHtml = await denied.text();
      assert.equal(denied.status, 403);
      assert.match(deniedHtml, /Access Denied/);
      assert.equal(deniedHtml.includes('KEEP_BODY_z9'), false);
      assert.equal(deniedHtml.includes('DROP_BODY_z9'), false);
      assert.equal(deniedHtml.includes('THEIRS_BODY_z9'), false);
      assert.equal(deniedHtml.includes(ownerHash), false);
      assert.equal(repoRow(ctx.db, dropName).id, drop.id);
      assert.equal(repoRow(ctx.db, keepName).id, keep.id);
      assert.equal(repoRow(ctx.db, theirsName).id, theirs.id);
      await assertUpdatedAtStays(ctx.db, dropName, DROP_FROZEN);
      assert.equal(repoRow(ctx.db, keepName).updated_at, KEEP_FROZEN);
      assert.equal(repoRow(ctx.db, theirsName).updated_at, THEIRS_FROZEN);

      const removed = await ownerSession.postForm(`/${owner.username}/drop-z9/settings/delete`, spoof);
      assert.equal(removed.status, 302);
      assert.equal(removed.headers.get('location'), `/@${owner.username}`);
      await removed.text();

      assert.equal(repoRow(ctx.db, dropName), undefined);
      assert.equal(fs.existsSync(dropPath), false);
      const kept = repoRow(ctx.db, keepName);
      assert.equal(kept.id, keep.id);
      assert.equal(kept.name, 'keep-z9');
      assert.equal(kept.full_name, keepName);
      assert.equal(kept.description, 'KEEP_DESC_z9');
      assert.equal(kept.owner_id, owner.id);
      assert.equal(kept.private, 0);
      assert.equal(kept.default_branch, 'main');
      assert.equal(kept.updated_at, KEEP_FROZEN);
      assert.equal(gitSync(['--git-dir', keepPath, 'rev-parse', 'HEAD']).trim(), keepHead);
      assert.equal(fs.existsSync(keepPath), true);
      const stillTheirs = repoRow(ctx.db, theirsName);
      assert.equal(stillTheirs.id, theirs.id);
      assert.equal(stillTheirs.description, 'THEIRS_DESC_z9');
      assert.equal(stillTheirs.owner_id, stranger.id);
      assert.equal(stillTheirs.updated_at, THEIRS_FROZEN);
      assert.equal(gitSync(['--git-dir', theirsPath, 'rev-parse', 'HEAD']).trim(), theirsHead);
      assert.equal(passwordHash(ctx.db, owner.username), ownerHash);
      assert.equal(passwordHash(ctx.db, stranger.username), strangerHash);

      const gone = await ownerSession.fetch(`/${owner.username}/drop-z9`);
      assert.equal(gone.status, 404);
      const goneHtml = await gone.text();
      assert.equal(goneHtml.includes('DROP_BODY_z9'), false);
      assert.equal(goneHtml.includes('DROP_DESC_z9'), false);
      assert.equal(goneHtml.includes('KEEP_BODY_z9'), false);
      const keepBlob = await (await ownerSession.fetch(`/${owner.username}/keep-z9/blob/main/keep.txt`)).text();
      assert.match(keepBlob, /KEEP_BODY_z9/);
      assert.equal(keepBlob.includes('DROP_BODY_z9'), false);
      const theirsBlob = await (await strangerSession.fetch(`/${stranger.username}/theirs-z9/blob/main/theirs.txt`)).text();
      assert.match(theirsBlob, /THEIRS_BODY_z9/);

      const profile = await (await ownerSession.fetch(`/@${owner.username}`)).text();
      assert.match(profile, /KEEP_DESC_z9/);
      assert.equal(profile.includes('DROP_DESC_z9'), false);
      const home = await (await ctx.session().fetch('/')).text();
      assert.match(home, /KEEP_DESC_z9/);
      assert.match(home, /THEIRS_DESC_z9/);
      assert.equal(home.includes('DROP_DESC_z9'), false);
      assert.deepEqual(
        (await (await ctx.session().fetch('/api/search/repos?q=DROP_DESC_z9')).json()).map((repo) => repo.name),
        []
      );
      const found = await (await ctx.session().fetch('/api/search/repos?q=KEEP_DESC_z9')).json();
      assert.deepEqual(found.map((repo) => repo.full_name), [keepName]);
      assert.equal(found[0].id, keep.id);
      assert.equal(Object.hasOwn(found[0], 'password'), false);
    });
  });

  test('a plus sign and a space stay different usernames for sessions and receive-pack', async () => {
    await withApp(async (ctx) => {
      const stamp = ctx.nextId('z9');
      const plusName = `a+${stamp}`;
      const spaceName = `a ${stamp}`;
      const plusSession = ctx.session();
      const plus = await registerUser(ctx, plusSession, {
        username: plusName,
        email: `plus.${stamp}@example.test`,
        password: 'plus-secret-z9',
      });
      const spaceSession = ctx.session();
      const space = await registerUser(ctx, spaceSession, {
        username: spaceName,
        email: `space.${stamp}@example.test`,
        password: 'space-secret-z9',
      });
      assert.notEqual(plus.id, space.id);
      const plusHash = passwordHash(ctx.db, plus.username);
      const spaceHash = passwordHash(ctx.db, space.username);
      assert.match(plusHash, /^\$2[aby]\$10\$/);
      assert.match(spaceHash, /^\$2[aby]\$10\$/);
      assert.notEqual(plusHash, spaceHash);
      assert.equal(plus.username, plusName);
      assert.equal(space.username, spaceName);

      await createRepo(plusSession, { name: 'vault', description: 'PLUS_SECRET_z9', isPrivate: true });
      await createRepo(spaceSession, { name: 'vault', description: 'SPACE_SECRET_z9', isPrivate: true });
      await createRepo(plusSession, { name: 'notes', description: 'PLUS_PUBLIC_z9' });
      commitToBare(barePath(plus.username, 'vault'), {
        files: { 'keep.txt': 'PLUS_BODY_z9\n' },
        message: 'plus-ship-z9',
      });
      commitToBare(barePath(space.username, 'vault'), {
        files: { 'keep.txt': 'SPACE_BODY_z9\n' },
        message: 'space-ship-z9',
      });
      const plusHead = gitSync(['--git-dir', barePath(plus.username, 'vault'), 'rev-parse', 'HEAD']).trim();
      const plusRepo = `${plus.username}/vault`;
      const spaceRepo = `${space.username}/vault`;
      setUpdatedAt(ctx.db, plusRepo, PLUS_FROZEN);
      setUpdatedAt(ctx.db, spaceRepo, SPACE_FROZEN);

      const plusAsSpace = await ctx.session().postForm('/login', {
        username: plusName,
        password: space.password,
      });
      const plusAsSpaceHtml = await plusAsSpace.text();
      assert.equal(plusAsSpace.status, 200);
      assert.equal(plusAsSpace.headers.get('location'), null);
      assert.match(plusAsSpaceHtml, /Invalid credentials/);
      assert.equal(plusAsSpaceHtml.includes(plus.password), false);
      assert.equal(plusAsSpaceHtml.includes(space.password), false);
      assert.equal(plusAsSpaceHtml.includes(plusHash), false);

      const spaceAsPlus = await ctx.session().postForm('/login', {
        username: spaceName,
        password: plus.password,
      });
      assert.equal(spaceAsPlus.status, 200);
      assert.match(await spaceAsPlus.text(), /Invalid credentials/);
      assert.equal(passwordHash(ctx.db, plus.username), plusHash);
      assert.equal(passwordHash(ctx.db, space.username), spaceHash);

      const plusLogin = ctx.session();
      const plusOk = await plusLogin.postForm('/login', { username: plusName, password: plus.password });
      assert.equal(plusOk.status, 302);
      assert.equal(plusOk.headers.get('location'), '/');
      await plusOk.text();
      const spaceLogin = ctx.session();
      const spaceOk = await spaceLogin.postForm('/login', { username: spaceName, password: space.password });
      assert.equal(spaceOk.status, 302);
      await spaceOk.text();

      const plusPage = await (await plusLogin.fetch(`/@${enc(plusName)}`)).text();
      assert.match(plusPage, /PLUS_SECRET_z9/);
      assert.match(plusPage, /PLUS_PUBLIC_z9/);
      assert.equal(plusPage.includes('SPACE_SECRET_z9'), false);
      assert.equal(plusPage.includes(spaceName), false);
      const plusBlob = await (await plusLogin.fetch(`/${enc(plusName)}/vault/blob/main/keep.txt`)).text();
      assert.match(plusBlob, /PLUS_BODY_z9/);
      assert.equal(plusBlob.includes('SPACE_BODY_z9'), false);

      const spacePage = await (await spaceLogin.fetch(`/@${enc(spaceName)}`)).text();
      assert.match(spacePage, /SPACE_SECRET_z9/);
      assert.equal(spacePage.includes('PLUS_SECRET_z9'), false);
      assert.equal(spacePage.includes('PLUS_BODY_z9'), false);
      const spaceBlob = await (await spaceLogin.fetch(`/${enc(spaceName)}/vault/blob/main/keep.txt`)).text();
      assert.match(spaceBlob, /SPACE_BODY_z9/);
      assert.equal(spaceBlob.includes('PLUS_BODY_z9'), false);

      const crossed = await spaceLogin.fetch(`/${enc(plusName)}/vault`);
      assert.equal(crossed.status, 404);
      assert.equal((await crossed.text()).includes('PLUS_SECRET_z9'), false);
      const rawPlus = await spaceLogin.fetch(`/@${plusName}`);
      assert.equal(rawPlus.status, 200);
      const rawPlusHtml = await rawPlus.text();
      assert.match(rawPlusHtml, /PLUS_PUBLIC_z9/);
      assert.equal(rawPlusHtml.includes('PLUS_SECRET_z9'), false);
      assert.equal(rawPlusHtml.includes('SPACE_SECRET_z9'), false);

      const anonProfile = await ctx.session().fetch(`/@${enc(plusName)}`);
      assert.equal(anonProfile.headers.getSetCookie().some((cookie) => cookie.startsWith('connect.sid=')), false);
      const anonHtml = await anonProfile.text();
      assert.match(anonHtml, /PLUS_PUBLIC_z9/);
      assert.equal(anonHtml.includes('PLUS_SECRET_z9'), false);
      assert.equal(anonHtml.includes('SPACE_SECRET_z9'), false);
      const anonApi = await (await ctx.session().fetch(`/api/users/${enc(plusName)}/repos`)).json();
      assert.deepEqual(anonApi.map((repo) => repo.name), ['notes']);
      assert.equal(JSON.stringify(anonApi).includes('PLUS_SECRET_z9'), false);
      const ownerApi = await (await plusLogin.fetch(`/api/users/${enc(plusName)}/repos`)).json();
      assert.equal(ownerApi.some((repo) => repo.name === 'vault' && repo.private === 1), true);
      assert.equal(JSON.stringify(ownerApi).includes(plusHash), false);
      assert.equal(JSON.stringify(ownerApi).includes('SPACE_SECRET_z9'), false);

      const home = await (await ctx.session().fetch('/')).text();
      assert.match(home, /PLUS_PUBLIC_z9/);
      assert.equal(home.includes(plusName), true);
      assert.equal(home.includes('PLUS_SECRET_z9'), false);
      assert.equal(home.includes('SPACE_SECRET_z9'), false);
      assert.equal(home.includes(spaceName), false);

      const pack = `/${enc(plusName)}/vault/git-receive-pack`;
      const wrongPassword = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(plusName, space.password) },
        body: '',
      });
      const wrongText = await wrongPassword.text();
      assert.equal(wrongPassword.status, 401);
      assert.equal(wrongPassword.headers.get('www-authenticate'), 'Basic realm="GITGRAM"');
      assert.equal(wrongText.includes(plus.password), false);
      assert.equal(wrongText.includes(space.password), false);
      assert.equal(wrongText.includes(plusHash), false);
      await assertUpdatedAtStays(ctx.db, plusRepo, PLUS_FROZEN);
      assert.equal(repoRow(ctx.db, spaceRepo).updated_at, SPACE_FROZEN);

      const wrongOwner = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(spaceName, space.password) },
        body: '',
      });
      const wrongOwnerText = await wrongOwner.text();
      assert.equal(wrongOwner.status, 403);
      assert.match(wrongOwnerText, /Permission denied/);
      assert.equal(wrongOwnerText.includes(plus.password), false);
      assert.equal(wrongOwnerText.includes(space.password), false);
      await assertUpdatedAtStays(ctx.db, plusRepo, PLUS_FROZEN);
      assert.equal(repoRow(ctx.db, spaceRepo).updated_at, SPACE_FROZEN);

      const allowed = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(plusName, plus.password) },
        body: '',
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('content-type'), 'application/x-git-receive-pack-result');
      await allowed.text();
      const refreshed = await waitForUpdatedAt(ctx.db, plusRepo, PLUS_FROZEN);
      assert.notEqual(refreshed, PLUS_FROZEN);
      assert.equal(repoRow(ctx.db, spaceRepo).updated_at, SPACE_FROZEN);
      assert.equal(gitSync(['--git-dir', barePath(plus.username, 'vault'), 'rev-parse', 'HEAD']).trim(), plusHead);
      const still = await (await plusLogin.fetch(`/${enc(plusName)}/vault/blob/main/keep.txt`)).text();
      assert.match(still, /PLUS_BODY_z9/);
      assert.equal(still.includes('SPACE_BODY_z9'), false);
    });
  });

  test('an email plus-tag is a separate account and is not stripped at login', async () => {
    await withApp(async (ctx) => {
      const local = `alias.${ctx.nextId('m')}`;
      const baseEmail = `${local}@example.test`;
      const taggedEmail = `${local}+git@example.test`;
      const baseSession = ctx.session();
      const base = await registerUser(ctx, baseSession, {
        username: `base${ctx.nextId('b')}`,
        email: baseEmail,
        password: 'base-secret-z9',
      });
      const baseHash = passwordHash(ctx.db, base.username);
      const taggedSession = ctx.session();
      const tagged = await registerUser(ctx, taggedSession, {
        username: `tag${ctx.nextId('t')}`,
        email: taggedEmail,
        password: 'tag-secret-z9',
      });
      const taggedHash = passwordHash(ctx.db, tagged.username);
      assert.notEqual(base.id, tagged.id);
      assert.notEqual(baseHash, taggedHash);
      assert.match(taggedHash, /^\$2[aby]\$10\$/);
      assert.equal(ctx.db.prepare('SELECT email FROM users WHERE id = ?').get(base.id).email, baseEmail);
      assert.equal(ctx.db.prepare('SELECT email FROM users WHERE id = ?').get(tagged.id).email, taggedEmail);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);

      const duplicate = await ctx.session().postForm('/register', {
        username: `other${ctx.nextId('o')}`,
        email: baseEmail,
        password: 'other-secret-z9',
      });
      const duplicateHtml = await duplicate.text();
      assert.equal(duplicate.status, 200);
      assert.match(duplicateHtml, /User already exists/);
      assert.equal(duplicateHtml.includes('other-secret-z9'), false);
      assert.equal(duplicateHtml.includes(baseHash), false);
      assert.equal(passwordHash(ctx.db, base.username), baseHash);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);

      await createRepo(baseSession, { name: 'vault', description: 'BASE_SECRET_z9', isPrivate: true });
      await createRepo(taggedSession, { name: 'vault', description: 'TAG_SECRET_z9', isPrivate: true });
      commitToBare(barePath(base.username, 'vault'), {
        files: { 'keep.txt': 'BASE_BODY_z9\n' },
        message: 'base-ship-z9',
      });
      commitToBare(barePath(tagged.username, 'vault'), {
        files: { 'keep.txt': 'TAG_BODY_z9\n' },
        message: 'tag-ship-z9',
      });
      const baseRepo = `${base.username}/vault`;
      const taggedRepo = `${tagged.username}/vault`;
      setUpdatedAt(ctx.db, baseRepo, BASE_FROZEN);
      setUpdatedAt(ctx.db, taggedRepo, TAG_FROZEN);

      const tagAsBase = await ctx.session().postForm('/login', {
        username: taggedEmail,
        password: base.password,
      });
      const tagAsBaseHtml = await tagAsBase.text();
      assert.equal(tagAsBase.status, 200);
      assert.equal(tagAsBase.headers.get('location'), null);
      assert.match(tagAsBaseHtml, /Invalid credentials/);
      assert.equal(tagAsBaseHtml.includes(base.password), false);
      assert.equal(tagAsBaseHtml.includes(tagged.password), false);
      assert.equal(tagAsBaseHtml.includes(baseHash), false);
      assert.equal(tagAsBaseHtml.includes(taggedHash), false);

      const baseAsTag = await ctx.session().postForm('/login', {
        username: baseEmail,
        password: tagged.password,
      });
      assert.equal(baseAsTag.status, 200);
      assert.match(await baseAsTag.text(), /Invalid credentials/);

      const baseLogin = ctx.session();
      const baseOk = await baseLogin.postForm('/login', { username: baseEmail, password: base.password });
      assert.equal(baseOk.status, 302);
      await baseOk.text();
      const baseBlob = await (await baseLogin.fetch(`/${base.username}/vault/blob/main/keep.txt`)).text();
      assert.match(baseBlob, /BASE_BODY_z9/);
      assert.equal(baseBlob.includes('TAG_BODY_z9'), false);
      const baseCross = await baseLogin.fetch(`/${tagged.username}/vault`);
      assert.equal(baseCross.status, 404);
      assert.equal((await baseCross.text()).includes('TAG_SECRET_z9'), false);

      const tagLogin = ctx.session();
      const tagOk = await tagLogin.postForm('/login', { username: taggedEmail, password: tagged.password });
      assert.equal(tagOk.status, 302);
      await tagOk.text();
      const tagBlob = await (await tagLogin.fetch(`/${tagged.username}/vault/blob/main/keep.txt`)).text();
      assert.match(tagBlob, /TAG_BODY_z9/);
      assert.equal(tagBlob.includes('BASE_BODY_z9'), false);
      const tagCross = await tagLogin.fetch(`/${base.username}/vault`);
      assert.equal(tagCross.status, 404);
      assert.equal((await tagCross.text()).includes('BASE_SECRET_z9'), false);

      const home = await (await ctx.session().fetch('/')).text();
      assert.equal(home.includes('BASE_SECRET_z9'), false);
      assert.equal(home.includes('TAG_SECRET_z9'), false);
      assert.deepEqual(await (await ctx.session().fetch('/api/search/repos?q=BASE_SECRET_z9')).json(), []);
      assert.deepEqual(await (await tagLogin.fetch('/api/search/repos?q=TAG_SECRET_z9')).json(), []);
      assert.equal(passwordHash(ctx.db, base.username), baseHash);
      assert.equal(passwordHash(ctx.db, tagged.username), taggedHash);

      const pack = `/${base.username}/vault/git-receive-pack`;
      const denied = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(base.username, tagged.password) },
        body: '',
      });
      const deniedText = await denied.text();
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('www-authenticate'), 'Basic realm="GITGRAM"');
      assert.equal(deniedText.includes(base.password), false);
      assert.equal(deniedText.includes(tagged.password), false);
      assert.equal(deniedText.includes(baseHash), false);
      await assertUpdatedAtStays(ctx.db, baseRepo, BASE_FROZEN);
      assert.equal(repoRow(ctx.db, taggedRepo).updated_at, TAG_FROZEN);

      const allowed = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(base.username, base.password) },
        body: '',
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('content-type'), 'application/x-git-receive-pack-result');
      await allowed.text();
      const refreshed = await waitForUpdatedAt(ctx.db, baseRepo, BASE_FROZEN);
      assert.notEqual(refreshed, BASE_FROZEN);
      assert.equal(repoRow(ctx.db, taggedRepo).updated_at, TAG_FROZEN);
      assert.match(
        await (await baseLogin.fetch(`/${base.username}/vault/blob/main/keep.txt`)).text(),
        /BASE_BODY_z9/
      );
    });
  });

  test('a search plus sign is a space, and an encoded plus sign stays a plus', async () => {
    await withApp(async (ctx) => {
      const ownerSession = ctx.session();
      const owner = await registerUser(ctx, ownerSession);
      insertRepo(ctx.db, {
        ownerId: owner.id,
        username: owner.username,
        name: 'plus+name',
        description: 'PLUS_PUBLIC_z9',
        updatedAt: '2020-02-01 00:00:00',
      });
      insertRepo(ctx.db, {
        ownerId: owner.id,
        username: owner.username,
        name: 'space-lib',
        description: 'plus name token',
        updatedAt: '2020-01-01 00:00:00',
      });
      insertRepo(ctx.db, {
        ownerId: owner.id,
        username: owner.username,
        name: 'plus+name-hidden',
        description: 'plus+name secret',
        isPrivate: 1,
        updatedAt: '2020-03-01 00:00:00',
      });

      const encoded = await ctx.session().fetch(`/api/search/repos?q=${enc('plus+name')}`);
      assert.equal(encoded.headers.getSetCookie().some((cookie) => cookie.startsWith('connect.sid=')), false);
      assert.equal(encoded.status, 200);
      const encodedRows = await encoded.json();
      assert.deepEqual(encodedRows.map((repo) => repo.name), ['plus+name']);
      assert.equal(encodedRows[0].private, 0);
      assert.equal(encodedRows[0].description, 'PLUS_PUBLIC_z9');
      assert.equal(JSON.stringify(encodedRows).includes('plus+name secret'), false);
      assert.equal(JSON.stringify(encodedRows).includes('plus name token'), false);
      assert.equal(Object.hasOwn(encodedRows[0], 'password'), false);

      const asSpace = await ctx.session().fetch('/api/search/repos?q=plus+name');
      assert.equal(asSpace.status, 200);
      const spaceRows = await asSpace.json();
      assert.deepEqual(spaceRows.map((repo) => repo.name), ['space-lib']);
      assert.equal(spaceRows[0].description, 'plus name token');
      assert.equal(JSON.stringify(spaceRows).includes('PLUS_PUBLIC_z9'), false);
      assert.equal(JSON.stringify(spaceRows).includes('plus+name secret'), false);
      assert.equal(Object.hasOwn(spaceRows[0], 'password'), false);

      const signedIn = await (await ownerSession.fetch(`/api/search/repos?q=${enc('plus+name secret')}`)).json();
      assert.deepEqual(signedIn, []);

      for (const pathname of ['/', '/login', '/register']) {
        const res = await ctx.session().fetch(pathname);
        assert.equal(res.headers.getSetCookie().some((cookie) => cookie.startsWith('connect.sid=')), false, pathname);
        await res.text();
      }
    });
  });
});
