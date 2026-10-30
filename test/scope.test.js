const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
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
  start,
  waitForUpdatedAt,
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

describe('listing limits, identity padding, and tag refs', { concurrency: 1 }, () => {
  test('the profile and user API list every repository while the homepage stays at twenty', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      for (let day = 1; day <= 21; day += 1) {
        insertRepo(ctx.db, {
          ownerId: user.id,
          username: user.username,
          name: `listed-${String(day).padStart(2, '0')}`,
          description: day === 21 ? 'LISTED_NEWEST' : 'listed public',
          updatedAt: `2035-01-${String(day).padStart(2, '0')} 00:00:00`,
        });
      }
      insertRepo(ctx.db, {
        ownerId: user.id,
        username: user.username,
        name: 'listed-private',
        description: 'LISTED_PRIVATE_SECRET',
        isPrivate: 1,
        updatedAt: '2035-02-01 00:00:00',
      });

      const ownProfile = await (await owner.fetch(`/@${encodeURIComponent(user.username)}`)).text();
      assert.match(ownProfile, /listed-01/);
      assert.match(ownProfile, /listed-21/);
      assert.match(ownProfile, /LISTED_NEWEST/);
      assert.match(ownProfile, /listed-private/);
      assert.match(ownProfile, /LISTED_PRIVATE_SECRET/);
      assert.ok(ownProfile.indexOf('listed-private') < ownProfile.indexOf('listed-21'));
      assert.ok(ownProfile.indexOf('listed-21') < ownProfile.indexOf('listed-01'));

      const ownApi = await (await owner.fetch(`/api/users/${encodeURIComponent(user.username)}/repos`)).json();
      assert.equal(ownApi.length, 22);
      assert.equal(ownApi[0].name, 'listed-private');
      assert.equal(ownApi[0].private, 1);
      assert.equal(ownApi[1].name, 'listed-21');
      assert.equal(ownApi[1].private, 0);
      assert.equal(ownApi[1].default_branch, 'main');
      assert.equal(ownApi[21].name, 'listed-01');
      assert.equal(JSON.stringify(ownApi).includes(passwordHash(ctx.db, user.username)), false);

      const strangerProfile = await (await ctx.session().fetch(`/@${encodeURIComponent(user.username)}`)).text();
      assert.match(strangerProfile, /listed-01/);
      assert.match(strangerProfile, /listed-21/);
      assert.ok(strangerProfile.indexOf('listed-21') < strangerProfile.indexOf('listed-01'));
      assert.equal(strangerProfile.includes('listed-private'), false);
      assert.equal(strangerProfile.includes('LISTED_PRIVATE_SECRET'), false);

      const strangerApi = await (await ctx.session().fetch(`/api/users/${encodeURIComponent(user.username)}/repos`)).json();
      assert.equal(strangerApi.length, 21);
      assert.equal(strangerApi[0].name, 'listed-21');
      assert.equal(strangerApi[20].name, 'listed-01');
      assert.equal(strangerApi.some((repo) => repo.name === 'listed-private'), false);

      const home = await (await ctx.session().fetch('/')).text();
      assert.match(home, /listed-21/);
      assert.match(home, /listed-02/);
      assert.match(home, /LISTED_NEWEST/);
      assert.equal(home.includes('listed-01'), false);
      assert.equal(home.includes('listed-private'), false);
      assert.equal(home.includes('LISTED_PRIVATE_SECRET'), false);
    });
  });

  test('a trailing space is a different account for the web and for git', async () => {
    await withApp(async (ctx) => {
      const plainName = `Ada${ctx.nextId('S')}`;
      const spacedName = `${plainName} `;
      const plain = ctx.session();
      const plainUser = await registerUser(ctx, plain, {
        username: plainName,
        email: `${plainName}@example.test`,
        password: 'plain-pass-1',
      });
      const spaced = ctx.session();
      const spacedUser = await registerUser(ctx, spaced, {
        username: spacedName,
        email: `${plainName}-spaced@example.test`,
        password: 'spaced-pass-1',
      });
      assert.notEqual(plainUser.id, spacedUser.id);
      assert.notEqual(passwordHash(ctx.db, plainName), passwordHash(ctx.db, spacedName));

      await createRepo(plain, { name: 'vault', description: 'PLAIN_SECRET', isPrivate: true });
      await createRepo(spaced, { name: 'vault', description: 'SPACED_SECRET', isPrivate: true });
      const plainFull = `${plainName}/vault`;
      const spacedFull = `${spacedName}/vault`;
      setUpdated(ctx, plainFull);
      setUpdated(ctx, spacedFull);

      const plainPage = await (await plain.fetch(`/${encodeURIComponent(plainName)}/vault`)).text();
      assert.match(plainPage, /PLAIN_SECRET/);
      assert.equal(plainPage.includes('SPACED_SECRET'), false);

      const spacedPage = await (await spaced.fetch(`/${encodeURIComponent(spacedName)}/vault`)).text();
      assert.match(spacedPage, /SPACED_SECRET/);
      assert.equal(spacedPage.includes('PLAIN_SECRET'), false);

      const crossed = await spaced.fetch(`/${encodeURIComponent(plainName)}/vault`);
      assert.equal(crossed.status, 404);
      assert.equal((await crossed.text()).includes('PLAIN_SECRET'), false);

      const login = ctx.session();
      const rejected = await login.postForm('/login', { username: plainName, password: 'spaced-pass-1' });
      assert.equal(rejected.status, 200);
      assert.match(await rejected.text(), /Invalid credentials/);
      const accepted = await login.postForm('/login', { username: spacedName, password: 'spaced-pass-1' });
      assert.equal(accepted.status, 302);
      assert.equal(accepted.headers.get('location'), '/');
      const home = await (await login.fetch('/')).text();
      assert.match(home, new RegExp(`/@${plainName} `));
      const opened = await (await login.fetch(`/${encodeURIComponent(spacedName)}/vault`)).text();
      assert.match(opened, /SPACED_SECRET/);
      const stillHidden = await login.fetch(`/${encodeURIComponent(plainName)}/vault`);
      assert.equal(stillHidden.status, 404);
      assert.equal((await stillHidden.text()).includes('PLAIN_SECRET'), false);

      const pack = `/${encodeURIComponent(spacedName)}/vault/git-receive-pack`;
      const notOwner = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(plainName, 'plain-pass-1') },
        body: '',
      });
      assert.equal(notOwner.status, 403);
      assert.match(await notOwner.text(), /Permission denied/);
      await assertUpdatedAtStays(ctx.db, spacedFull, FROZEN, 300);
      assert.equal(repoRow(ctx.db, plainFull).updated_at, FROZEN);

      const allowed = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(spacedName, 'spaced-pass-1') },
        body: '',
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('content-type'), 'application/x-git-receive-pack-result');
      await allowed.text();
      const refreshed = await waitForUpdatedAt(ctx.db, spacedFull, FROZEN);
      assert.notEqual(refreshed, FROZEN);
      assert.equal(repoRow(ctx.db, plainFull).updated_at, FROZEN);
    });
  });

  test('a blank search query matches nothing and a space does not reveal private repos', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      insertRepo(ctx.db, {
        ownerId: user.id,
        username: user.username,
        name: 'space-public',
        description: 'keeps a space',
        updatedAt: '2036-01-02 00:00:00',
      });
      insertRepo(ctx.db, {
        ownerId: user.id,
        username: user.username,
        name: 'space-private',
        description: 'hides a space SECRET_SPACE',
        isPrivate: 1,
        updatedAt: '2036-02-01 00:00:00',
      });

      const missing = await ctx.session().fetch('/api/search/repos');
      assert.equal(missing.status, 200);
      assert.deepEqual(await missing.json(), []);

      const empty = await ctx.session().fetch('/api/search/repos?q=');
      assert.equal(empty.status, 200);
      assert.deepEqual(await empty.json(), []);

      const space = await ctx.session().fetch(`/api/search/repos?q=${encodeURIComponent(' ')}`);
      const rows = await space.json();
      assert.equal(space.status, 200);
      assert.equal(rows.some((repo) => repo.name === 'space-public'), true);
      assert.equal(rows.some((repo) => repo.name === 'space-private'), false);
      assert.equal(JSON.stringify(rows).includes('SECRET_SPACE'), false);
      assert.ok(rows.every((repo) => repo.private === 0));
    });
  });

  test('a tag keeps the tagged blob after main moves ahead', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'tagged', description: 'tags' });
      const bare = barePath(user.username, 'tagged');
      const hashes = commitToBare(bare, {
        revisions: [
          { files: { 'readme.txt': 'TAGGED_BODY\n' }, message: 'tagged-ship' },
          { files: { 'readme.txt': 'MAIN_BODY\n' }, message: 'later-ship' },
        ],
      });
      gitSync(['--git-dir', bare, 'tag', 'v1', hashes[0]]);

      const anon = ctx.session();
      const tagged = await anon.fetch(`/${user.username}/tagged/blob/v1/readme.txt`);
      const taggedHtml = await tagged.text();
      assert.equal(tagged.status, 200);
      assert.match(taggedHtml, /TAGGED_BODY/);
      assert.equal(taggedHtml.includes('MAIN_BODY'), false);

      const short = await anon.fetch(`/${user.username}/tagged/blob/${hashes[0].slice(0, 7)}/readme.txt`);
      const shortHtml = await short.text();
      assert.equal(short.status, 200);
      assert.match(shortHtml, /TAGGED_BODY/);
      assert.equal(shortHtml.includes('MAIN_BODY'), false);

      const main = await anon.fetch(`/${user.username}/tagged/blob/main/readme.txt`);
      const mainHtml = await main.text();
      assert.equal(main.status, 200);
      assert.match(mainHtml, /MAIN_BODY/);
      assert.equal(mainHtml.includes('TAGGED_BODY'), false);

      const page = await (await anon.fetch(`/${user.username}/tagged`)).text();
      assert.match(page, /MAIN_BODY/);
      assert.match(page, /later-ship/);
      assert.equal(page.includes('TAGGED_BODY'), false);

      const refs = await anon.fetch(`/${user.username}/tagged.git/info/refs?service=git-upload-pack`);
      const refsText = await refs.text();
      assert.equal(refs.status, 200);
      assert.match(refsText, /refs\/tags\/v1/);
      assert.match(refsText, /refs\/heads\/main/);
    });
  });
});

function setUpdated(ctx, fullName) {
  ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE full_name = ?').run(FROZEN, fullName);
}
