const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
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

const FROZEN = '2016-04-01 00:00:00';
const SIBLING_FROZEN = '2016-05-01 00:00:00';

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

describe('unicode identity, password bytes, and displayed timestamps', { concurrency: 1 }, () => {
  test('usernames that differ by case or accent encoding stay separate, including a unicode repository', async () => {
    await withApp(async (ctx) => {
      const upperName = 'Jos\u00e9';
      const lowerName = 'jos\u00e9';
      const combiningName = 'Jose\u0301';
      const upperSession = ctx.session();
      const upper = await registerUser(ctx, upperSession, {
        username: upperName,
        email: 'jose.upper.z8@example.test',
        password: 'Upper-pass-z8',
      });
      const upperHash = passwordHash(ctx.db, upper.username);

      const folded = await ctx.session().postForm('/login', {
        username: lowerName,
        password: upper.password,
      });
      const foldedText = await folded.text();
      assert.equal(folded.status, 200);
      assert.equal(folded.headers.get('location'), null);
      assert.match(foldedText, /Invalid credentials/);
      assert.equal(foldedText.includes(upper.password), false);
      assert.equal(foldedText.includes(upperHash), false);

      const combining = await ctx.session().postForm('/login', {
        username: combiningName,
        password: upper.password,
      });
      assert.equal(combining.status, 200);
      assert.equal(combining.headers.get('location'), null);
      assert.match(await combining.text(), /Invalid credentials/);

      for (const name of [lowerName, combiningName]) {
        const profile = await ctx.session().fetch(`/@${enc(name)}`);
        assert.equal(profile.status, 404);
        await profile.text();
        const api = await ctx.session().fetch(`/api/users/${enc(name)}/repos`);
        assert.equal(api.status, 404);
        assert.deepEqual(await api.json(), { error: 'Not found' });
      }
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);

      const lowerSession = ctx.session();
      const lower = await registerUser(ctx, lowerSession, {
        username: lowerName,
        email: 'jose.lower.z8@example.test',
        password: 'Lower-pass-z8',
      });
      const lowerHash = passwordHash(ctx.db, lower.username);
      assert.notEqual(lowerHash, upperHash);
      assert.match(lowerHash, /^\$2[aby]\$10\$/);

      const crossed = await ctx.session().postForm('/login', {
        username: upper.username,
        password: lower.password,
      });
      assert.equal(crossed.status, 200);
      assert.match(await crossed.text(), /Invalid credentials/);
      assert.equal(passwordHash(ctx.db, upper.username), upperHash);
      assert.equal(passwordHash(ctx.db, lower.username), lowerHash);

      await createRepo(upperSession, {
        name: 'vault',
        description: 'SECRET_UPPER_z8',
        isPrivate: true,
      });
      await createRepo(lowerSession, {
        name: 'vault',
        description: 'SECRET_LOWER_z8',
        isPrivate: true,
      });
      await createRepo(upperSession, { name: 'caf\u00e9', description: 'PUBLIC_CAFE_z8' });
      await createRepo(lowerSession, {
        name: 'caf\u00e9',
        description: 'PRIVATE_CAFE_z8',
        isPrivate: true,
      });

      const bare = barePath(upper.username, 'caf\u00e9');
      const [hash] = commitToBare(bare, {
        files: { 'notes.txt': 'CAFE_BODY_z8\n' },
        message: 'cafe-ship-z8',
      });
      assert.equal(gitSync(['--git-dir', bare, 'symbolic-ref', 'HEAD']).trim(), 'refs/heads/main');

      const upperPage = `/${enc(upper.username)}/${enc('caf\u00e9')}`;
      const ownerRepo = await (await upperSession.fetch(upperPage)).text();
      assert.match(ownerRepo, /PUBLIC_CAFE_z8/);
      assert.match(ownerRepo, /cafe-ship-z8/);
      assert.match(ownerRepo, /notes\.txt/);
      assert.equal(ownerRepo.includes('CAFE_BODY_z8'), false);
      assert.equal(ownerRepo.includes('PRIVATE_CAFE_z8'), false);
      assert.equal(ownerRepo.includes('SECRET_LOWER_z8'), false);

      const blob = await upperSession.fetch(`${upperPage}/blob/main/notes.txt`);
      assert.equal(blob.status, 200);
      assert.match(await blob.text(), /CAFE_BODY_z8/);

      const lowerBlob = await lowerSession.fetch(`${upperPage}/blob/main/notes.txt`);
      assert.equal(lowerBlob.status, 200);
      const lowerBlobText = await lowerBlob.text();
      assert.match(lowerBlobText, /CAFE_BODY_z8/);
      assert.equal(lowerBlobText.includes('PRIVATE_CAFE_z8'), false);

      const hidden = await lowerSession.fetch(`/${enc(upper.username)}/vault`);
      assert.equal(hidden.status, 404);
      const hiddenText = await hidden.text();
      assert.equal(hiddenText.includes('SECRET_UPPER_z8'), false);
      const hiddenLower = await upperSession.fetch(`/${enc(lower.username)}/${enc('caf\u00e9')}`);
      assert.equal(hiddenLower.status, 404);
      assert.equal((await hiddenLower.text()).includes('PRIVATE_CAFE_z8'), false);

      const ownProfile = await (await upperSession.fetch(`/@${enc(upper.username)}`)).text();
      assert.match(ownProfile, /SECRET_UPPER_z8/);
      assert.match(ownProfile, /PUBLIC_CAFE_z8/);
      assert.equal(ownProfile.includes('SECRET_LOWER_z8'), false);
      assert.equal(ownProfile.includes('PRIVATE_CAFE_z8'), false);

      const otherProfile = await (await lowerSession.fetch(`/@${enc(upper.username)}`)).text();
      assert.match(otherProfile, /PUBLIC_CAFE_z8/);
      assert.equal(otherProfile.includes('SECRET_UPPER_z8'), false);
      assert.equal(otherProfile.includes('SECRET_LOWER_z8'), false);
      assert.equal(otherProfile.includes('+ New Repository'), false);

      const home = await (await ctx.session().fetch('/')).text();
      assert.match(home, new RegExp(`${upper.username}/caf\u00e9`));
      assert.match(home, /PUBLIC_CAFE_z8/);
      assert.equal(home.includes(`${lower.username}/caf\u00e9`), false);
      assert.equal(home.includes('PRIVATE_CAFE_z8'), false);
      assert.equal(home.includes('SECRET_UPPER_z8'), false);
      assert.equal(home.includes('SECRET_LOWER_z8'), false);

      const byName = await (await ctx.session().fetch(`/api/search/repos?q=${enc('caf\u00e9')}`)).json();
      assert.deepEqual(byName.map((repo) => repo.full_name), [`${upper.username}/caf\u00e9`]);
      assert.equal(byName[0].private, 0);
      assert.equal(JSON.stringify(byName).includes('PRIVATE_CAFE_z8'), false);

      for (const query of ['SECRET_UPPER_z8', 'PRIVATE_CAFE_z8', 'SECRET_LOWER_z8']) {
        const rows = await (await upperSession.fetch(`/api/search/repos?q=${enc(query)}`)).json();
        assert.deepEqual(rows, []);
      }

      const probed = await ctx.session().fetch(
        `/api/search/repos?q=${enc('PUBLIC_CAFE_z8')}&q=${enc('PRIVATE_CAFE_z8')}`
      );
      const probedRows = await probed.json();
      assert.equal(probed.status, 200);
      assert.ok(probedRows.every((repo) => repo.private === 0));
      assert.equal(JSON.stringify(probedRows).includes('PRIVATE_CAFE_z8'), false);
      assert.equal(JSON.stringify(probedRows).includes('SECRET_UPPER_z8'), false);

      const anonApi = await (await ctx.session().fetch(`/api/users/${enc(upper.username)}/repos`)).json();
      assert.deepEqual(anonApi.map((repo) => repo.name), ['caf\u00e9']);
      const ownerApi = await (await upperSession.fetch(`/api/users/${enc(upper.username)}/repos`)).json();
      assert.equal(ownerApi.some((repo) => repo.name === 'vault' && repo.private === 1), true);
      assert.equal(JSON.stringify(ownerApi).includes(upperHash), false);

      const refs = await ctx.session().fetch(
        `/${enc(upper.username)}/${enc('caf\u00e9')}.git/info/refs?service=git-upload-pack`
      );
      const refsText = await refs.text();
      assert.equal(refs.status, 200);
      assert.equal(refs.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
      assert.match(refsText, new RegExp(hash));
      assert.equal(refsText.includes('CAFE_BODY_z8'), false);
      assert.equal(refsText.includes('PRIVATE_CAFE_z8'), false);

      const publicName = `${upper.username}/caf\u00e9`;
      const privateName = `${lower.username}/caf\u00e9`;
      setUpdatedAt(ctx.db, publicName, FROZEN);
      setUpdatedAt(ctx.db, privateName, SIBLING_FROZEN);
      const denied = await ctx.session().fetch(
        `/${enc(upper.username)}/${enc('caf\u00e9')}/git-receive-pack`,
        {
          method: 'POST',
          headers: { authorization: basicAuth(lower.username, lower.password) },
          body: '',
        }
      );
      assert.equal(denied.status, 403);
      assert.match(await denied.text(), /Permission denied/);
      await assertUpdatedAtStays(ctx.db, publicName, FROZEN);
      assert.equal(repoRow(ctx.db, privateName).updated_at, SIBLING_FROZEN);

      const allowed = await upperSession.fetch(
        `/${enc(upper.username)}/${enc('caf\u00e9')}/git-receive-pack`,
        {
          method: 'POST',
          headers: { authorization: basicAuth(upper.username, upper.password) },
          body: '',
        }
      );
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('content-type'), 'application/x-git-receive-pack-result');
      await allowed.text();
      const refreshed = await waitForUpdatedAt(ctx.db, publicName, FROZEN);
      assert.notEqual(refreshed, FROZEN);
      assert.equal(repoRow(ctx.db, privateName).updated_at, SIBLING_FROZEN);
      assert.equal(gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim(), hash);
    });
  });

  test('the last bcrypt byte and a combining accent do not authenticate', async () => {
    await withApp(async (ctx) => {
      const exact = `${'a'.repeat(71)}Z`;
      const swapped = `${'a'.repeat(71)}Y`;
      const shorter = 'a'.repeat(71);
      const session = ctx.session();
      const user = await registerUser(ctx, session, {
        username: ctx.nextId('long'),
        password: exact,
      });
      const hash = passwordHash(ctx.db, user.username);
      assert.match(hash, /^\$2[aby]\$10\$/);
      assert.equal(Buffer.byteLength(exact), 72);

      const lookPassword = 'caf\u00e9xx';
      const lookAlike = 'cafe\u0301xx';
      assert.notEqual(lookPassword, lookAlike);
      const lookSession = ctx.session();
      const look = await registerUser(ctx, lookSession, {
        username: ctx.nextId('look'),
        password: lookPassword,
      });
      const lookHash = passwordHash(ctx.db, look.username);

      for (const [username, password, stored] of [
        [user.username, swapped, hash],
        [user.username, shorter, hash],
        [look.username, lookAlike, lookHash],
        [look.username, exact, lookHash],
      ]) {
        const failed = await ctx.session().postForm('/login', { username, password });
        const text = await failed.text();
        assert.equal(failed.status, 200);
        assert.equal(failed.headers.get('location'), null);
        assert.match(text, /Invalid credentials/);
        assert.equal(text.includes(password), false);
        assert.equal(text.includes(stored), false);
        assert.equal(passwordHash(ctx.db, username), stored);
      }

      const again = await ctx.session().postForm('/login', {
        username: user.username,
        password: exact,
      });
      assert.equal(again.status, 302);
      assert.equal(again.headers.get('location'), '/');
      await again.text();
      const lookAgain = await ctx.session().postForm('/login', {
        username: look.username,
        password: lookPassword,
      });
      assert.equal(lookAgain.status, 302);
      await lookAgain.text();
      assert.equal(passwordHash(ctx.db, user.username), hash);
      assert.equal(passwordHash(ctx.db, look.username), lookHash);

      await createRepo(session, { name: 'pack-z8', description: 'PACK_DESC_z8' });
      const fullName = `${user.username}/pack-z8`;
      setUpdatedAt(ctx.db, fullName, FROZEN);
      const pack = `/${enc(user.username)}/pack-z8/git-receive-pack`;
      for (const password of [swapped, shorter, lookPassword]) {
        const denied = await ctx.session().fetch(pack, {
          method: 'POST',
          headers: { authorization: basicAuth(user.username, password) },
          body: '',
        });
        const text = await denied.text();
        assert.equal(denied.status, 401);
        assert.equal(denied.headers.get('www-authenticate'), 'Basic realm="GITGRAM"');
        assert.equal(text.includes(password), false);
        assert.equal(text.includes(hash), false);
      }
      await assertUpdatedAtStays(ctx.db, fullName, FROZEN);

      const allowed = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(user.username, exact) },
        body: '',
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('content-type'), 'application/x-git-receive-pack-result');
      const allowedText = await allowed.text();
      assert.equal(allowedText.includes(exact), false);
      assert.equal(allowedText.includes(hash), false);
      const refreshed = await waitForUpdatedAt(ctx.db, fullName, FROZEN);
      assert.notEqual(refreshed, FROZEN);
      assert.equal(passwordHash(ctx.db, user.username), hash);
    });
  });

  test('profile and homepage times follow updated_at rather than created_at', async () => {
    await withApp(async (ctx) => {
      const ownerSession = ctx.session();
      const owner = await registerUser(ctx, ownerSession);
      const strangerSession = ctx.session();
      await registerUser(ctx, strangerSession);
      ctx.db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run('2024-03-15 08:00:00', owner.id);
      await createRepo(ownerSession, { name: 'clocked', description: 'CLOCK_PUBLIC_z8' });
      await createRepo(ownerSession, {
        name: 'clock-secret',
        description: 'CLOCK_PRIVATE_z8',
        isPrivate: true,
      });
      ctx.db.prepare('UPDATE repositories SET created_at = ?, updated_at = ? WHERE owner_id = ?').run(
        '2099-06-01 00:00:00',
        '2020-01-15 00:00:00',
        owner.id
      );

      const own = await (await ownerSession.fetch(`/@${enc(owner.username)}`)).text();
      assert.match(own, /Joined March 2024/);
      assert.match(own, /clocked/);
      assert.match(own, /CLOCK_PUBLIC_z8/);
      assert.match(own, /clock-secret/);
      assert.match(own, /CLOCK_PRIVATE_z8/);
      assert.match(own, /years ago/);
      assert.equal(own.includes('2099'), false);
      assert.doesNotMatch(own, /in \d+ years/);
      assert.match(own, /\+ New Repository/);

      const hidden = await (await strangerSession.fetch(`/@${enc(owner.username)}`)).text();
      assert.match(hidden, /Joined March 2024/);
      assert.match(hidden, /clocked/);
      assert.match(hidden, /CLOCK_PUBLIC_z8/);
      assert.match(hidden, /years ago/);
      assert.equal(hidden.includes('clock-secret'), false);
      assert.equal(hidden.includes('CLOCK_PRIVATE_z8'), false);
      assert.equal(hidden.includes('2099'), false);
      assert.doesNotMatch(hidden, /in \d+ years/);
      assert.equal(hidden.includes('+ New Repository'), false);

      const home = await (await ctx.session().fetch('/')).text();
      assert.match(home, /clocked/);
      assert.match(home, /CLOCK_PUBLIC_z8/);
      assert.match(home, /years ago/);
      assert.equal(home.includes('clock-secret'), false);
      assert.equal(home.includes('CLOCK_PRIVATE_z8'), false);
      assert.equal(home.includes('2099'), false);
      assert.doesNotMatch(home, /in \d+ years/);
    });
  });
});
