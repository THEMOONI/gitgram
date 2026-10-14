const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  basicAuth,
  commitToBare,
  counts,
  createRepo,
  getJson,
  getText,
  getUpdatedAt,
  insertRepo,
  locationPath,
  login,
  passwordHash,
  postForm,
  readBody,
  register,
  repoDisk,
  repoRow,
  reposDir,
  runGit,
  Session,
  setUpdatedAt,
  userId,
  waitForUpdatedAt,
  withApp,
} = require('./helpers');

function stamp(day) {
  return `2020-01-${String(day).padStart(2, '0')} 00:00:00`;
}

describe('access', { concurrency: false }, () => {
  test('repo names are trimmed, anonymous callers cannot create or delete, and one owner cannot remove another copy', async () => {
    await withApp(async (ctx) => {
      const previousUrl = process.env.PUBLIC_URL;
      process.env.PUBLIC_URL = 'http://git.example.test';
      try {
        const anon = new Session(ctx);
        const createdAnon = await createRepo(anon, { name: 'nope', description: 'should-not-exist' });
        assert.equal(createdAnon.status, 302);
        assert.equal(createdAnon.location, '/login');
        assert.deepEqual(counts(ctx), { users: 0, repos: 0 });
        const newPage = await getText(anon, '/new');
        assert.equal(newPage.status, 302);
        assert.equal(newPage.location, '/login');

        const nina = new Session(ctx);
        await register(nina, { username: 'Nina', email: 'nina@example.com', password: 'pw-nina-names' });
        const form = await getText(nina, '/new');
        assert.equal(form.status, 200);
        assert.match(form.text, /Create a new repository/);

        const blank = await createRepo(nina, { name: '   ', description: 'blank-desc' });
        assert.equal(blank.status, 200);
        assert.match(blank.text, /Name required/);
        assert.equal(fs.existsSync(reposDir('Nina')), false);
        assert.equal(counts(ctx).repos, 0);

        const spaced = await createRepo(nina, { name: '  spaced  ', description: 'spaced-desc' });
        assert.equal(spaced.status, 302);
        assert.equal(locationPath(spaced.location), '/Nina/spaced');
        assert.equal(repoRow(ctx, 'Nina/spaced').description, 'spaced-desc');
        assert.equal(repoRow(ctx, 'Nina/spaced').private, 0);
        assert.equal(fs.existsSync(repoDisk('Nina', 'spaced')), true);
        assert.equal(fs.existsSync(repoDisk('Nina', '  spaced  ')), false);
        const duplicate = await createRepo(nina, { name: 'spaced', description: 'other-desc', isPrivate: true });
        assert.equal(duplicate.status, 200);
        assert.match(duplicate.text, /Repo already exists/);
        assert.equal(repoRow(ctx, 'Nina/spaced').description, 'spaced-desc');
        assert.equal(repoRow(ctx, 'Nina/spaced').private, 0);

        const page = await getText(nina, '/Nina/spaced');
        assert.equal(page.status, 200);
        assert.match(page.text, /http:\/\/git\.example\.test\/Nina\/spaced\.git/);
        assert.match(page.text, /\/Nina\/spaced\/settings/);

        const omar = new Session(ctx);
        await register(omar, { username: 'Omar', email: 'omar@example.com', password: 'pw-omar-names' });
        const sharedNina = await createRepo(nina, { name: 'shared', description: 'nina-shared' });
        const sharedOmar = await createRepo(omar, { name: 'shared', description: 'omar-shared' });
        assert.equal(sharedNina.status, 302);
        assert.equal(sharedOmar.status, 302);
        commitToBare(repoDisk('Omar', 'shared'), { files: { 'keep.txt': 'omar-keep' }, message: 'omar commit' });

        const anonSettings = await getText(anon, '/Nina/shared/settings');
        assert.equal(anonSettings.status, 403);
        assert.match(anonSettings.text, /GITGRAM/);
        assert.equal(anonSettings.text.includes('/settings/delete'), false);
        const anonDelete = await postForm(anon, '/Nina/shared/settings/delete', {});
        assert.equal(anonDelete.status, 403);
        assert.ok(repoRow(ctx, 'Nina/shared'));

        await getText(nina, '/logout');
        const afterLogout = await postForm(nina, '/Nina/shared/settings/delete', {});
        assert.equal(afterLogout.status, 403);
        assert.ok(repoRow(ctx, 'Nina/shared'));
        assert.equal(fs.existsSync(repoDisk('Nina', 'shared')), true);

        await login(nina, 'Nina', 'pw-nina-names');
        const wrongMethod = await getText(nina, '/Nina/shared/settings/delete');
        assert.equal(wrongMethod.status, 404);
        assert.ok(repoRow(ctx, 'Nina/shared'));

        const removed = await postForm(nina, '/Nina/shared/settings/delete', {});
        assert.equal(removed.status, 302);
        assert.equal(locationPath(removed.location), '/@Nina');
        assert.equal(repoRow(ctx, 'Nina/shared'), undefined);
        assert.equal(fs.existsSync(repoDisk('Nina', 'shared')), false);
        const second = await postForm(nina, '/Nina/shared/settings/delete', {});
        assert.equal(second.status, 404);

        assert.equal(repoRow(ctx, 'Omar/shared').description, 'omar-shared');
        assert.equal(fs.existsSync(repoDisk('Omar', 'shared')), true);
        const refs = await getText(anon, '/Omar/shared.git/info/refs?service=git-upload-pack');
        assert.equal(refs.status, 200);
        assert.match(refs.text, /001e# service=git-upload-pack\n0000/);
        const gone = await getText(anon, '/Nina/shared.git/info/refs?service=git-upload-pack');
        assert.equal(gone.status, 404);
        const omarBlob = await getText(anon, '/Omar/shared/blob/main/keep.txt');
        assert.equal(omarBlob.status, 200);
        assert.match(omarBlob.text, /omar-keep/);
      } finally {
        if (previousUrl === undefined) delete process.env.PUBLIC_URL;
        else process.env.PUBLIC_URL = previousUrl;
      }
    });
  });

  test('private repositories stay off public pages, search, and other users APIs', async () => {
    await withApp(async (ctx) => {
      const nina = new Session(ctx);
      const omar = new Session(ctx);
      const cam = new Session(ctx);
      const anon = new Session(ctx);
      await register(nina, { username: 'Nina', email: 'nina-priv@example.com', password: 'pw-nina-privacy' });
      await register(omar, { username: 'Omar', email: 'omar-priv@example.com', password: 'pw-omar-privacy' });
      await register(cam, { username: 'Cam', email: 'cam-priv@example.com', password: 'pw-cam-privacy' });

      assert.equal((await createRepo(nina, { name: 'PublicNotes', description: 'public-notes-desc' })).status, 302);
      assert.equal((await createRepo(nina, { name: 'SecretNotes', description: 'secret-notes-desc', isPrivate: true })).status, 302);
      assert.equal((await createRepo(omar, { name: 'NewerPublic', description: 'newer-public-desc' })).status, 302);
      setUpdatedAt(ctx, 'Nina/PublicNotes', stamp(2));
      setUpdatedAt(ctx, 'Nina/SecretNotes', stamp(10));
      setUpdatedAt(ctx, 'Omar/NewerPublic', stamp(20));
      const hash = passwordHash(ctx, 'Nina');

      const home = await getText(nina, '/');
      assert.equal(home.status, 200);
      assert.equal(home.text.includes('SecretNotes'), false);
      assert.equal(home.text.includes('secret-notes-desc'), false);
      assert.equal(home.text.includes('badge-private'), false);
      assert.equal(home.text.includes(hash), false);
      assert.equal(home.text.includes('pw-nina-privacy'), false);
      assert.equal(home.text.includes('nina-priv@example.com'), false);
      const newerHome = home.text.indexOf('NewerPublic');
      const olderHome = home.text.indexOf('PublicNotes');
      assert.ok(newerHome !== -1 && olderHome !== -1 && newerHome < olderHome);

      const ownerProfile = await getText(nina, '/@Nina');
      assert.equal(ownerProfile.status, 200);
      const secretAt = ownerProfile.text.indexOf('SecretNotes');
      const publicAt = ownerProfile.text.indexOf('PublicNotes');
      assert.ok(secretAt !== -1 && publicAt !== -1 && secretAt < publicAt);
      assert.match(ownerProfile.text, /secret-notes-desc/);
      assert.match(ownerProfile.text, /badge-private/);
      assert.match(ownerProfile.text, /\+ New Repository/);
      assert.equal(ownerProfile.text.includes(hash), false);

      const strangerProfile = await getText(omar, '/@Nina');
      assert.equal(strangerProfile.status, 200);
      assert.match(strangerProfile.text, /PublicNotes/);
      assert.equal(strangerProfile.text.includes('SecretNotes'), false);
      assert.equal(strangerProfile.text.includes('secret-notes-desc'), false);
      assert.equal(strangerProfile.text.includes('+ New Repository'), false);
      assert.equal(strangerProfile.text.includes('nina-priv@example.com'), false);

      const anonProfile = await getText(anon, '/@Nina');
      assert.equal(anonProfile.text.includes('SecretNotes'), false);
      assert.match(anonProfile.text, /PublicNotes/);

      const emptyOwner = await getText(cam, '/@Cam');
      assert.match(emptyOwner.text, /No repositories yet/);
      assert.match(emptyOwner.text, /Create your first repository/);
      assert.match(emptyOwner.text, /\+ New Repository/);
      const emptyStranger = await getText(nina, '/@Cam');
      assert.match(emptyStranger.text, /No repositories yet/);
      assert.equal(emptyStranger.text.includes('Create your first repository'), false);
      assert.equal(emptyStranger.text.includes('+ New Repository'), false);

      const missingUser = await getText(anon, '/@no-such-user');
      assert.equal(missingUser.status, 404);
      assert.match(missingUser.text, /Not Found - GITGRAM/);

      const secretSearch = await getJson(anon, '/api/search/repos?q=' + encodeURIComponent('secret-notes-desc'));
      assert.equal(secretSearch.status, 200);
      assert.deepEqual(secretSearch.json, []);
      const folded = await getJson(anon, '/api/search/repos?q=' + encodeURIComponent('PUBLIC-NOTES'));
      assert.equal(folded.json.length, 1);
      assert.equal(folded.json[0].name, 'PublicNotes');
      assert.equal(JSON.stringify(folded.json).includes(hash), false);
      assert.equal('password' in folded.json[0], false);
      assert.equal('email' in folded.json[0], false);

      const byUser = await getJson(anon, '/api/search/repos?q=' + encodeURIComponent('Nina'));
      assert.deepEqual(byUser.json, []);
      const byEmail = await getJson(anon, '/api/search/repos?q=' + encodeURIComponent('nina-priv@example.com'));
      assert.deepEqual(byEmail.json, []);
      const wildcard = await getJson(anon, '/api/search/repos?q=' + encodeURIComponent('%'));
      assert.ok(wildcard.json.some((repo) => repo.name === 'PublicNotes'));
      assert.ok(wildcard.json.some((repo) => repo.name === 'NewerPublic'));
      assert.equal(wildcard.json.some((repo) => repo.name === 'SecretNotes'), false);
      const quoted = await getJson(anon, '/api/search/repos?q=' + encodeURIComponent('"'));
      assert.deepEqual(quoted.json, []);
      const dropped = await getJson(anon, '/api/search/repos?q=' + encodeURIComponent("'; DROP TABLE users; --"));
      assert.equal(dropped.status, 200);
      assert.ok(Array.isArray(dropped.json));
      assert.equal(counts(ctx).users, 3);
      const emptyQuery = await getJson(anon, '/api/search/repos?q=');
      assert.deepEqual(emptyQuery.json, []);
      const missingQuery = await getJson(anon, '/api/search/repos');
      assert.deepEqual(missingQuery.json, []);

      const unknown = await getJson(anon, '/api/users/nobody/repos');
      assert.equal(unknown.status, 404);
      assert.deepEqual(unknown.json, { error: 'Not found' });
      const wrongCase = await getJson(nina, '/api/users/nina/repos');
      assert.equal(wrongCase.status, 404);
      assert.deepEqual(wrongCase.json, { error: 'Not found' });

      const ownerApi = await getJson(nina, '/api/users/Nina/repos');
      assert.deepEqual(ownerApi.json.map((repo) => repo.name), ['SecretNotes', 'PublicNotes']);
      assert.equal(JSON.stringify(ownerApi.json).includes(hash), false);
      assert.equal(ownerApi.json.some((repo) => 'password' in repo), false);
      const strangerApi = await getJson(omar, '/api/users/Nina/repos');
      assert.deepEqual(strangerApi.json.map((repo) => repo.name), ['PublicNotes']);
      const anonApi = await getJson(anon, '/api/users/Nina/repos');
      assert.deepEqual(anonApi.json.map((repo) => repo.name), ['PublicNotes']);

      const wrongProfile = await getText(anon, '/@nina');
      assert.equal(wrongProfile.status, 404);
      assert.equal(wrongProfile.text.includes('secret-notes-desc'), false);
    });
  });

  test('private files, history, and settings are hidden; the owner can read and delete them', async () => {
    await withApp(async (ctx) => {
      const nina = new Session(ctx);
      const omar = new Session(ctx);
      const anon = new Session(ctx);
      await register(nina, { username: 'Nina', email: 'nina-file@example.com', password: 'pw-nina-files' });
      await register(omar, { username: 'Omar', email: 'omar-file@example.com', password: 'pw-omar-files' });
      await createRepo(nina, { name: 'vault', description: 'vault-desc', isPrivate: true });
      await createRepo(nina, { name: 'open', description: 'open-desc' });
      commitToBare(repoDisk('Nina', 'vault'), { files: { 'readme.txt': 'TOP-SECRET-FILE' }, message: 'secret commit' });
      commitToBare(repoDisk('Nina', 'open'), { files: { 'readme.txt': 'PUBLIC-FILE' }, message: 'public commit' });

      for (const session of [omar, anon]) {
        for (const path of ['/Nina/vault', '/Nina/vault/blob/main/readme.txt', '/Nina/vault/commits', '/Nina/vault/settings']) {
          const response = await getText(session, path);
          assert.equal(response.status, 404, path);
          assert.equal(response.text.includes('TOP-SECRET-FILE'), false, path);
          assert.equal(response.text.includes('vault-desc'), false, path);
        }
        const deniedDelete = await postForm(session, '/Nina/vault/settings/delete', {});
        assert.equal(deniedDelete.status, 404);
        assert.equal(deniedDelete.text.includes('TOP-SECRET-FILE'), false);
      }
      assert.ok(repoRow(ctx, 'Nina/vault'));

      const ownerFile = await getText(nina, '/Nina/vault/blob/main/readme.txt');
      assert.equal(ownerFile.status, 200);
      assert.match(ownerFile.text, /TOP-SECRET-FILE/);
      const ownerRepo = await getText(nina, '/Nina/vault');
      assert.match(ownerRepo.text, /badge-private/);
      assert.match(ownerRepo.text, /1 commit</);
      assert.match(ownerRepo.text, /\/Nina\/vault\/settings/);
      const ownerCommits = await getText(nina, '/Nina/vault/commits');
      assert.equal(ownerCommits.status, 200);
      assert.match(ownerCommits.text, /secret commit/);

      const publicFile = await getText(anon, '/Nina/open/blob/main/readme.txt');
      assert.equal(publicFile.status, 200);
      assert.match(publicFile.text, /PUBLIC-FILE/);
      const publicRepo = await getText(omar, '/Nina/open');
      assert.equal(publicRepo.status, 200);
      assert.match(publicRepo.text, /PUBLIC-FILE/);
      assert.equal(publicRepo.text.includes('/Nina/open/settings'), false);
      assert.match(publicRepo.text, /badge-public/);
      const strangerSettings = await getText(omar, '/Nina/open/settings');
      assert.equal(strangerSettings.status, 403);
      assert.equal(strangerSettings.text.includes('/settings/delete'), false);

      const settings = await getText(nina, '/Nina/vault/settings');
      assert.equal(settings.status, 200);
      assert.match(settings.text, /action="\/Nina\/vault\/settings\/delete"/);

      const removed = await postForm(nina, '/Nina/vault/settings/delete', {});
      assert.equal(removed.status, 302);
      assert.equal(repoRow(ctx, 'Nina/vault'), undefined);
      assert.equal(fs.existsSync(repoDisk('Nina', 'vault')), false);
      assert.ok(repoRow(ctx, 'Nina/open'));
      assert.equal(fs.existsSync(repoDisk('Nina', 'open')), true);
      const again = await postForm(nina, '/Nina/vault/settings/delete', {});
      assert.equal(again.status, 404);
    });
  });

  test('creating an existing name does not change it, and Vault stays distinct from vault', async () => {
    await withApp(async (ctx) => {
      const nina = new Session(ctx);
      const omar = new Session(ctx);
      const anon = new Session(ctx);
      await register(nina, { username: 'Nina', email: 'nina-case@example.com', password: 'pw-nina-case' });
      await register(omar, { username: 'Omar', email: 'omar-case@example.com', password: 'pw-omar-case' });
      await createRepo(nina, { name: 'widget', description: 'first-desc' });
      commitToBare(repoDisk('Nina', 'widget'), { files: { 'readme.txt': 'body-v1' }, message: 'first' });
      const before = repoRow(ctx, 'Nina/widget');
      const again = await createRepo(nina, { name: 'widget', description: 'second-desc', isPrivate: true });
      assert.equal(again.status, 200);
      assert.match(again.text, /Repo already exists/);
      const after = repoRow(ctx, 'Nina/widget');
      assert.equal(after.description, 'first-desc');
      assert.equal(after.private, 0);
      assert.equal(after.updated_at, before.updated_at);
      const blob = await getText(anon, '/Nina/widget/blob/main/readme.txt');
      assert.match(blob.text, /body-v1/);
      assert.equal(blob.text.includes('second-desc'), false);

      await createRepo(nina, { name: 'Vault', description: 'vault-secret', isPrivate: true });
      await createRepo(nina, { name: 'vault', description: 'vault-public' });
      commitToBare(repoDisk('Nina', 'Vault'), { files: { 'readme.txt': 'vault-secret-file' }, message: 'secret' });
      commitToBare(repoDisk('Nina', 'vault'), { files: { 'readme.txt': 'vault-public-file' }, message: 'public' });

      const home = await getText(anon, '/');
      assert.match(home.text, /vault-public/);
      assert.equal(home.text.includes('vault-secret'), false);
      const search = await getJson(anon, '/api/search/repos?q=' + encodeURIComponent('vault-secret'));
      assert.deepEqual(search.json, []);
      const publicSearch = await getJson(anon, '/api/search/repos?q=' + encodeURIComponent('VAULT-PUBLIC'));
      assert.equal(publicSearch.json.length, 1);
      assert.equal(publicSearch.json[0].name, 'vault');

      for (const session of [omar, anon]) {
        const hidden = await getText(session, '/Nina/Vault/blob/main/readme.txt');
        assert.equal(hidden.status, 404);
        assert.equal(hidden.text.includes('vault-secret-file'), false);
        const hiddenSettings = await getText(session, '/Nina/Vault/settings');
        assert.equal(hiddenSettings.status, 404);
        const hiddenDelete = await postForm(session, '/Nina/Vault/settings/delete', {});
        assert.equal(hiddenDelete.status, 404);
      }
      const visible = await getText(omar, '/Nina/vault/blob/main/readme.txt');
      assert.equal(visible.status, 200);
      assert.match(visible.text, /vault-public-file/);
      assert.equal(visible.text.includes('vault-secret-file'), false);
      assert.ok(repoRow(ctx, 'Nina/Vault'));
      assert.equal(repoRow(ctx, 'Nina/Vault').private, 1);
    });
  });

  test('logging in as someone else replaces only that cookie', async () => {
    await withApp(async (ctx) => {
      const first = new Session(ctx);
      const second = new Session(ctx);
      const bea = new Session(ctx);
      await register(first, { username: 'Amy', email: 'amy@example.com', password: 'pw-amy-session' });
      await createRepo(first, { name: 'diary', description: 'amy-secret', isPrivate: true });
      commitToBare(repoDisk('Amy', 'diary'), { files: { 'readme.txt': 'amy-secret-file' }, message: 'amy' });
      await login(second, 'Amy', 'pw-amy-session');
      await register(bea, { username: 'Bea', email: 'bea@example.com', password: 'pw-bea-session' });

      const switched = await login(first, 'Bea', 'pw-bea-session');
      assert.equal(switched.status, 302);
      const hidden = await getText(first, '/Amy/diary/blob/main/readme.txt');
      assert.equal(hidden.status, 404);
      assert.equal(hidden.text.includes('amy-secret-file'), false);
      const stillAmy = await getText(second, '/Amy/diary/blob/main/readme.txt');
      assert.equal(stillAmy.status, 200);
      assert.match(stillAmy.text, /amy-secret-file/);

      const hash = passwordHash(ctx, 'Amy');
      const dup = await register(second, { username: 'Amy', email: 'amy@example.com', password: 'pw-amy-other' });
      assert.equal(dup.status, 200);
      assert.match(dup.text, /User already exists/);
      assert.equal(passwordHash(ctx, 'Amy'), hash);
      assert.match((await getText(second, '/')).text, />Amy</);
      const blank = await postForm(second, '/register', { username: '', email: '', password: '' });
      assert.match(blank.text, /All fields required/);
      assert.equal(passwordHash(ctx, 'Amy'), hash);
      assert.match((await getText(second, '/Amy/diary')).text, /amy-secret/);

      await getText(second, '/logout');
      const after = await getText(second, '/Amy/diary/blob/main/readme.txt');
      assert.equal(after.status, 404);
      assert.equal(after.text.includes('amy-secret-file'), false);
      assert.ok(repoRow(ctx, 'Amy/diary'));
    });
  });

  test('usernames that differ only by case are different accounts', async () => {
    await withApp(async (ctx) => {
      const upper = new Session(ctx);
      const lower = new Session(ctx);
      const anon = new Session(ctx);
      const upperCreated = await register(upper, { username: 'Ada', email: 'Ada@Example.com', password: 'pw-ada-upper' });
      assert.equal(upperCreated.status, 302);
      const upperHash = passwordHash(ctx, 'Ada');
      await createRepo(upper, { name: 'vault', description: 'ada-only-secret', isPrivate: true });
      commitToBare(repoDisk('Ada', 'vault'), { files: { 'readme.txt': 'ada-only-file' }, message: 'upper' });

      const lowerCreated = await register(lower, { username: 'ada', email: 'ada@example.com', password: 'pw-ada-lower' });
      assert.equal(lowerCreated.status, 302);
      assert.equal(passwordHash(ctx, 'Ada'), upperHash);
      assert.notEqual(passwordHash(ctx, 'ada'), upperHash);
      await createRepo(lower, { name: 'vault', description: 'ada-lower-secret', isPrivate: true });
      commitToBare(repoDisk('ada', 'vault'), { files: { 'readme.txt': 'ada-lower-file' }, message: 'lower' });

      const upperFile = await getText(upper, '/Ada/vault/blob/main/readme.txt');
      assert.equal(upperFile.status, 200);
      assert.match(upperFile.text, /ada-only-file/);
      const upperSeesLower = await getText(upper, '/ada/vault/blob/main/readme.txt');
      assert.equal(upperSeesLower.status, 404);
      assert.equal(upperSeesLower.text.includes('ada-lower-file'), false);

      const lowerFile = await getText(lower, '/ada/vault/blob/main/readme.txt');
      assert.match(lowerFile.text, /ada-lower-file/);
      const lowerSeesUpper = await getText(lower, '/Ada/vault');
      assert.equal(lowerSeesUpper.status, 404);
      assert.equal(lowerSeesUpper.text.includes('ada-only-secret'), false);

      const home = await getText(anon, '/');
      assert.equal(home.text.includes('ada-only-secret'), false);
      assert.equal(home.text.includes('ada-lower-secret'), false);
      const upperApi = await getJson(anon, '/api/users/Ada/repos');
      assert.deepEqual(upperApi.json, []);
      const lowerApi = await getJson(anon, '/api/users/ada/repos');
      assert.deepEqual(lowerApi.json, []);
      const ownerUpper = await getJson(upper, '/api/users/Ada/repos');
      assert.deepEqual(ownerUpper.json.map((repo) => repo.name), ['vault']);
      assert.equal(ownerUpper.json[0].description, 'ada-only-secret');
      const ownerLower = await getJson(lower, '/api/users/ada/repos');
      assert.equal(ownerLower.json[0].description, 'ada-lower-secret');
    });
  });

  test('homepage and search return at most 20 public repositories and skip private matches', async () => {
    await withApp(async (ctx) => {
      const session = new Session(ctx);
      await register(session, { username: 'Quinn', email: 'quinn@example.com', password: 'pw-quinn-limit' });
      for (let i = 0; i <= 20; i += 1) {
        insertRepo(ctx, {
          username: 'Quinn',
          name: `pub${String(i).padStart(2, '0')}`,
          description: 'needle',
          isPrivate: 0,
          updatedAt: stamp(i + 1),
        });
      }
      insertRepo(ctx, {
        username: 'Quinn',
        name: 'secret-newest',
        description: 'needle',
        isPrivate: 1,
        updatedAt: stamp(28),
      });

      const home = await getText(session, '/');
      const cards = home.text.match(/class="repo-card"/g) || [];
      assert.equal(cards.length, 20);
      const newest = home.text.indexOf('pub20');
      const oldestShown = home.text.indexOf('pub01');
      assert.ok(newest !== -1 && oldestShown !== -1 && newest < oldestShown);
      assert.equal(home.text.includes('pub00'), false);
      assert.equal(home.text.includes('secret-newest'), false);

      const search = await getJson(session, '/api/search/repos?q=needle');
      assert.equal(search.json.length, 20);
      assert.equal(search.json.some((repo) => repo.name === 'secret-newest'), false);
      assert.equal(search.json.some((repo) => repo.name === 'pub00'), false);
      assert.equal(search.json[0].name, 'pub20');
      assert.equal(search.json.some((repo) => 'password' in repo), false);
      const hash = passwordHash(ctx, 'Quinn');
      assert.equal(JSON.stringify(search.json).includes(hash), false);
    });
  });

  test('deleting one repository leaves its sibling, and receive-pack updates only the target', { timeout: 30000 }, async () => {
    await withApp(async (ctx) => {
      const sid = new Session(ctx);
      const anon = new Session(ctx);
      await register(sid, { username: 'Sid', email: 'sid@example.com', password: 'pw-sid-sibling' });
      await createRepo(sid, { name: 'alpha', description: 'alpha-findable' });
      await createRepo(sid, { name: 'beta', description: 'beta-findable' });
      commitToBare(repoDisk('Sid', 'alpha'), { files: { 'readme.txt': 'alpha-body' }, message: 'alpha commit' });
      commitToBare(repoDisk('Sid', 'beta'), { files: { 'readme.txt': 'beta-body' }, message: 'beta commit' });
      const betaBefore = runGit(['--git-dir', repoDisk('Sid', 'beta'), 'rev-parse', 'HEAD']);
      setUpdatedAt(ctx, 'Sid/alpha', '2000-01-01 00:00:00');
      setUpdatedAt(ctx, 'Sid/beta', '2001-01-01 00:00:00');

      const pushed = await readBody(await sid.fetch('/Sid/alpha/git-receive-pack', {
        method: 'POST',
        headers: {
          authorization: basicAuth('Sid', 'pw-sid-sibling'),
          'content-type': 'application/x-git-receive-pack-request',
        },
        body: '0000',
        signal: AbortSignal.timeout(15000),
      }));
      assert.equal(pushed.status, 200);
      assert.notEqual(await waitForUpdatedAt(ctx, 'Sid/alpha', '2000-01-01 00:00:00'), '2000-01-01 00:00:00');
      assert.equal(getUpdatedAt(ctx, 'Sid/beta'), '2001-01-01 00:00:00');

      const removed = await postForm(sid, '/Sid/alpha/settings/delete', {});
      assert.equal(removed.status, 302);
      assert.equal(repoRow(ctx, 'Sid/alpha'), undefined);
      assert.equal(fs.existsSync(repoDisk('Sid', 'alpha')), false);
      assert.equal(runGit(['--git-dir', repoDisk('Sid', 'beta'), 'rev-parse', 'HEAD']), betaBefore);
      assert.equal(getUpdatedAt(ctx, 'Sid/beta'), '2001-01-01 00:00:00');

      const profile = await getText(sid, '/@Sid');
      assert.match(profile.text, /\/Sid\/beta/);
      assert.equal(profile.text.includes('/Sid/alpha'), false);
      const home = await getText(anon, '/');
      assert.match(home.text, /beta-findable/);
      assert.equal(home.text.includes('alpha-findable'), false);
      const search = await getJson(anon, '/api/search/repos?q=findable');
      assert.deepEqual(search.json.map((repo) => repo.name), ['beta']);
      const blob = await getText(anon, '/Sid/beta/blob/main/readme.txt');
      assert.equal(blob.status, 200);
      assert.match(blob.text, /beta-body/);
      assert.equal(blob.text.includes('alpha-body'), false);
      const refs = await getText(anon, '/Sid/beta/info/refs?service=git-upload-pack');
      assert.equal(refs.status, 200);
      assert.match(refs.text, /# service=git-upload-pack/);
      const gone = await getText(anon, '/Sid/alpha/info/refs?service=git-upload-pack');
      assert.equal(gone.status, 404);
      const goneBlob = await getText(anon, '/Sid/alpha/blob/main/readme.txt');
      assert.equal(goneBlob.status, 404);
      assert.equal(goneBlob.text.includes('alpha-body'), false);
    });
  });
});
