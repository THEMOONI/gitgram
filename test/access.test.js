const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  barePath,
  commitToBare,
  createRepo,
  insertRepo,
  passwordHash,
  registerUser,
  repoRow,
  reposRoot,
  setUpdatedAt,
  start,
} = require('./helpers');

describe('repository access', { concurrency: 1 }, () => {
  let ctx;

  before(async () => {
    ctx = await start();
  });

  after(async () => {
    if (ctx) await ctx.close();
  });

  test('anonymous visitors cannot open the create form or insert a repository', async () => {
    const session = ctx.session();
    const form = await session.fetch('/new');
    assert.equal(form.status, 302);
    assert.equal(form.headers.get('location'), '/login');
    await form.text();

    const beforeUsers = ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const beforeRepos = ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n;
    const created = await session.postForm('/new', { name: 'should-not-exist', description: 'nope' });
    assert.equal(created.status, 302);
    assert.equal(created.headers.get('location'), '/login');
    await created.text();
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, beforeUsers);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n, beforeRepos);
    assert.equal(repoRow(ctx.db, 'should-not-exist'), undefined);
  });

  test('settings and delete are owner-only, and a second delete is a 404', async () => {
    const owner = ctx.session();
    const user = await registerUser(ctx, owner);
    await createRepo(owner, { name: 'public-repo', description: 'visible' });
    await createRepo(owner, { name: 'hidden-repo', description: 'HIDDEN_SETTINGS', isPrivate: true });
    const stranger = ctx.session();
    await registerUser(ctx, stranger);
    const anon = ctx.session();

    const ownerSettings = await owner.fetch(`/${user.username}/public-repo/settings`);
    const ownerHtml = await ownerSettings.text();
    assert.equal(ownerSettings.status, 200);
    assert.match(ownerHtml, /Delete this repository/);
    assert.match(ownerHtml, new RegExp(`action="/${user.username}/public-repo/settings/delete"`));

    for (const session of [anon, stranger]) {
      const settings = await session.fetch(`/${user.username}/public-repo/settings`);
      const html = await settings.text();
      assert.equal(settings.status, 403);
      assert.match(html, /Access Denied/);
      assert.doesNotMatch(html, /Delete this repository/);
      assert.doesNotMatch(html, /settings\/delete/);
    }

    const privateSettings = await anon.fetch(`/${user.username}/hidden-repo/settings`);
    const privateHtml = await privateSettings.text();
    assert.equal(privateSettings.status, 404);
    assert.equal(privateHtml.includes('HIDDEN_SETTINGS'), false);

    const denied = await stranger.postForm(`/${user.username}/public-repo/settings/delete`, {});
    assert.equal(denied.status, 403);
    await denied.text();
    assert.ok(repoRow(ctx.db, `${user.username}/public-repo`));
    assert.equal(fs.existsSync(barePath(user.username, 'public-repo')), true);

    const hiddenDelete = await anon.postForm(`/${user.username}/hidden-repo/settings/delete`, {});
    assert.equal(hiddenDelete.status, 404);
    await hiddenDelete.text();
    assert.ok(repoRow(ctx.db, `${user.username}/hidden-repo`));

    const removed = await owner.postForm(`/${user.username}/public-repo/settings/delete`, {});
    assert.equal(removed.status, 302);
    assert.equal(removed.headers.get('location'), `/@${user.username}`);
    await removed.text();
    assert.equal(repoRow(ctx.db, `${user.username}/public-repo`), undefined);
    assert.equal(fs.existsSync(barePath(user.username, 'public-repo')), false);

    const again = await owner.postForm(`/${user.username}/public-repo/settings/delete`, {});
    assert.equal(again.status, 404);
    await again.text();
    assert.ok(repoRow(ctx.db, `${user.username}/hidden-repo`));
  });

  test('logout then delete stays forbidden and keeps the repository', async () => {
    const session = ctx.session();
    const user = await registerUser(ctx, session);
    await createRepo(session, { name: 'stay', description: 'keep-me' });
    const goodbye = await session.fetch('/logout');
    await goodbye.text();
    const denied = await session.postForm(`/${user.username}/stay/settings/delete`, {});
    assert.equal(denied.status, 403);
    await denied.text();
    assert.equal(repoRow(ctx.db, `${user.username}/stay`).description, 'keep-me');
    assert.equal(fs.existsSync(barePath(user.username, 'stay')), true);
  });

  test('a private repository is hidden from anonymous users and strangers, including its file text', async () => {
    const username = `Ada${ctx.nextId('P')}`;
    const owner = ctx.session();
    const user = await registerUser(ctx, owner, { username });
    const repo = 'secretvaultz9';
    await createRepo(owner, { name: repo, description: 'SECRET_DESC_z9', isPrivate: true });
    commitToBare(barePath(user.username, repo), {
      files: { 'readme.txt': 'SECRET_FILE_z9\n' },
      message: 'SECRET_COMMIT_z9',
    });
    const stranger = ctx.session();
    await registerUser(ctx, stranger);
    const anon = ctx.session();

    const ownerPage = await owner.fetch(`/${user.username}/${repo}`);
    const ownerHtml = await ownerPage.text();
    assert.equal(ownerPage.status, 200);
    assert.match(ownerHtml, /SECRET_FILE_z9/);
    assert.match(ownerHtml, /badge-private/);
    assert.match(ownerHtml, />1 commit</);
    assert.match(ownerHtml, new RegExp(`/${user.username}/${repo}/settings`));

    const ownerBlob = await owner.fetch(`/${user.username}/${repo}/blob/main/readme.txt`);
    assert.equal(ownerBlob.status, 200);
    assert.match(await ownerBlob.text(), /SECRET_FILE_z9/);

    const secrets = ['SECRET_DESC_z9', 'SECRET_FILE_z9', 'SECRET_COMMIT_z9', repo];
    for (const session of [anon, stranger]) {
      for (const pathname of [
        `/${user.username}/${repo}`,
        `/${user.username}/${repo}/blob/main/readme.txt`,
        `/${user.username}/${repo}/commits`,
        `/${user.username}/${repo}/settings`,
      ]) {
        const res = await session.fetch(pathname);
        const html = await res.text();
        assert.equal(res.status, 404, pathname);
        for (const secret of secrets) assert.equal(html.includes(secret), false, secret);
      }
      const denied = await session.postForm(`/${user.username}/${repo}/settings/delete`, {});
      assert.equal(denied.status, 404);
      assert.equal((await denied.text()).includes('SECRET_FILE_z9'), false);
    }
    assert.ok(repoRow(ctx.db, `${user.username}/${repo}`));

    for (const session of [owner, anon]) {
      const home = await session.fetch('/');
      const html = await home.text();
      assert.equal(home.status, 200);
      for (const secret of secrets) assert.equal(html.includes(secret), false, secret);
    }

    const ownerSearch = await owner.fetch(`/api/search/repos?q=${encodeURIComponent('SECRET_DESC_z9')}`);
    assert.deepEqual(await ownerSearch.json(), []);

    const anonList = await anon.fetch(`/api/users/${encodeURIComponent(user.username)}/repos`);
    assert.equal(anonList.status, 200);
    assert.deepEqual(await anonList.json(), []);

    const ownerList = await owner.fetch(`/api/users/${encodeURIComponent(user.username)}/repos`);
    const listed = await ownerList.json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, repo);
    assert.equal(listed[0].private, 1);
    assert.equal(Object.hasOwn(listed[0], 'password'), false);
    assert.equal(JSON.stringify(listed).includes(passwordHash(ctx.db, user.username)), false);

    const lower = await anon.fetch(`/api/users/${encodeURIComponent(user.username.toLowerCase())}/repos`);
    assert.equal(lower.status, 404);
    assert.deepEqual(await lower.json(), { error: 'Not found' });
    const lowerProfile = await anon.fetch(`/@${encodeURIComponent(user.username.toLowerCase())}`);
    assert.equal(lowerProfile.status, 404);
    assert.equal((await lowerProfile.text()).includes('SECRET_DESC_z9'), false);

    const strangerProfile = await stranger.fetch(`/@${encodeURIComponent(user.username)}`);
    assert.equal((await strangerProfile.text()).includes(repo), false);
    const ownerProfile = await owner.fetch(`/@${encodeURIComponent(user.username)}`);
    assert.match(await ownerProfile.text(), new RegExp(repo));
  });

  test('profile and API order by updated_at and omit private repositories from other viewers', async () => {
    const username = `Ada${ctx.nextId('O')}`;
    const owner = ctx.session();
    const user = await registerUser(ctx, owner, { username });
    insertRepo(ctx.db, {
      ownerId: user.id,
      username: user.username,
      name: 'older-public',
      description: 'older public',
      updatedAt: '2031-01-01 00:00:00',
    });
    insertRepo(ctx.db, {
      ownerId: user.id,
      username: user.username,
      name: 'newer-public',
      description: 'newer public',
      updatedAt: '2031-02-01 00:00:00',
    });
    insertRepo(ctx.db, {
      ownerId: user.id,
      username: user.username,
      name: 'newest-private',
      description: 'ORDER_PRIVATE_SECRET',
      isPrivate: 1,
      updatedAt: '2031-03-01 00:00:00',
    });

    const ownProfile = await (await owner.fetch(`/@${encodeURIComponent(user.username)}`)).text();
    const privateAt = ownProfile.indexOf('newest-private');
    const newerAt = ownProfile.indexOf('newer-public');
    const olderAt = ownProfile.indexOf('older-public');
    assert.ok(privateAt >= 0 && privateAt < newerAt && newerAt < olderAt);
    assert.match(ownProfile, /ORDER_PRIVATE_SECRET/);

    const stranger = await (await ctx.session().fetch(`/@${encodeURIComponent(user.username)}`)).text();
    assert.equal(stranger.includes('newest-private'), false);
    assert.equal(stranger.includes('ORDER_PRIVATE_SECRET'), false);
    assert.ok(stranger.indexOf('newer-public') < stranger.indexOf('older-public'));

    const ownApi = await (await owner.fetch(`/api/users/${encodeURIComponent(user.username)}/repos`)).json();
    assert.deepEqual(ownApi.map((repo) => repo.name), ['newest-private', 'newer-public', 'older-public']);
    assert.equal(JSON.stringify(ownApi).includes(passwordHash(ctx.db, user.username)), false);

    const anonApi = await (await ctx.session().fetch(`/api/users/${encodeURIComponent(user.username)}/repos`)).json();
    assert.deepEqual(anonApi.map((repo) => repo.name), ['newer-public', 'older-public']);
  });

  test('the homepage shows the newest public repositories and never a private one', async () => {
    const owner = ctx.session();
    const user = await registerUser(ctx, owner);
    const other = ctx.session();
    const otherUser = await registerUser(ctx, other);
    insertRepo(ctx.db, {
      ownerId: user.id,
      username: user.username,
      name: 'priv-hidden-z',
      description: 'HOME_PRIVATE_SECRET',
      isPrivate: 1,
      updatedAt: '2032-12-31 00:00:00',
    });
    insertRepo(ctx.db, {
      ownerId: otherUser.id,
      username: otherUser.username,
      name: 'pub-older-z',
      description: 'older home',
      updatedAt: '2032-01-01 00:00:00',
    });
    insertRepo(ctx.db, {
      ownerId: otherUser.id,
      username: otherUser.username,
      name: 'pub-newer-z',
      description: 'newer home',
      updatedAt: '2032-06-01 00:00:00',
    });
    for (let day = 1; day <= 21; day += 1) {
      insertRepo(ctx.db, {
        ownerId: user.id,
        username: user.username,
        name: `home-limit-${String(day).padStart(2, '0')}`,
        description: 'home limit',
        updatedAt: `2030-01-${String(day).padStart(2, '0')} 00:00:00`,
      });
    }

    const home = await (await owner.fetch('/')).text();
    assert.equal(home.includes('priv-hidden-z'), false);
    assert.equal(home.includes('HOME_PRIVATE_SECRET'), false);
    assert.ok(home.indexOf('pub-newer-z') < home.indexOf('pub-older-z'));
    assert.match(home, /home-limit-21/);
    assert.equal(home.includes('home-limit-01'), false);
  });

  test('search returns public name and description matches only, capped at 20', async () => {
    const owner = ctx.session();
    const user = await registerUser(ctx, owner, {
      username: `SearchOwner${ctx.nextId('Q')}`,
      email: `search-${ctx.nextId('E')}@example.test`,
    });
    insertRepo(ctx.db, {
      ownerId: user.id,
      username: user.username,
      name: 'WidgetLib',
      description: 'a public widget',
      updatedAt: '2033-02-01 00:00:00',
    });
    insertRepo(ctx.db, {
      ownerId: user.id,
      username: user.username,
      name: 'SecretLib',
      description: 'widgetlib secret',
      isPrivate: 1,
      updatedAt: '2033-03-01 00:00:00',
    });
    insertRepo(ctx.db, {
      ownerId: user.id,
      username: user.username,
      name: 'notes-repo',
      description: 'mentioned in the docs',
      updatedAt: '2033-01-01 00:00:00',
    });

    for (const query of ['widgetlib', 'WIDGETLIB']) {
      const res = await ctx.session().fetch(`/api/search/repos?q=${encodeURIComponent(query)}`);
      const rows = await res.json();
      assert.equal(res.status, 200);
      assert.deepEqual(rows.map((repo) => repo.name), ['WidgetLib']);
      assert.equal(JSON.stringify(rows).includes('widgetlib secret'), false);
    }

    const byDescription = await (await ctx.session().fetch(`/api/search/repos?q=${encodeURIComponent('mentioned in the docs')}`)).json();
    assert.deepEqual(byDescription.map((repo) => repo.name), ['notes-repo']);

    for (const query of [user.username, user.email]) {
      const rows = await (await ctx.session().fetch(`/api/search/repos?q=${encodeURIComponent(query)}`)).json();
      assert.equal(rows.some((repo) => repo.owner_name === user.username), false);
    }

    const quote = await ctx.session().fetch(`/api/search/repos?q=${encodeURIComponent("' OR private = 1 OR name LIKE '")}`);
    const quoted = await quote.json();
    assert.equal(quote.status, 200);
    assert.ok(quoted.every((repo) => repo.private === 0));
    assert.equal(JSON.stringify(quoted).includes('SecretLib'), false);

    const percent = await (await ctx.session().fetch(`/api/search/repos?q=${encodeURIComponent('%')}`)).json();
    assert.ok(percent.every((repo) => repo.private === 0));
    assert.equal(JSON.stringify(percent).includes('widgetlib secret'), false);
    assert.equal(Object.hasOwn(percent[0], 'password'), false);
    assert.equal(Object.hasOwn(percent[0], 'email'), false);

    const empty = await ctx.session().fetch('/api/search/repos');
    assert.deepEqual(await empty.json(), []);

    for (let n = 1; n <= 21; n += 1) {
      insertRepo(ctx.db, {
        ownerId: user.id,
        username: user.username,
        name: `limit-hit-${String(n).padStart(2, '0')}`,
        description: 'cov-limit-token',
        updatedAt: `2034-01-${String(n).padStart(2, '0')} 00:00:00`,
      });
    }
    insertRepo(ctx.db, {
      ownerId: user.id,
      username: user.username,
      name: 'limit-private',
      description: 'cov-limit-token private',
      isPrivate: 1,
      updatedAt: '2034-12-31 00:00:00',
    });
    const limited = await (await ctx.session().fetch(`/api/search/repos?q=${encodeURIComponent('cov-limit-token')}`)).json();
    assert.equal(limited.length, 20);
    assert.equal(limited.some((repo) => repo.name === 'limit-private'), false);
    assert.equal(limited.some((repo) => repo.name === 'limit-hit-21'), true);
    assert.equal(limited.some((repo) => repo.name === 'limit-hit-01'), false);
    assert.equal(JSON.stringify(limited).includes(passwordHash(ctx.db, user.username)), false);
  });

  test('empty profiles invite only the owner to create a repository', async () => {
    const owner = ctx.session();
    const user = await registerUser(ctx, owner);
    const own = await (await owner.fetch(`/@${encodeURIComponent(user.username)}`)).text();
    assert.match(own, /No repositories yet/);
    assert.match(own, /\+ New Repository/);
    assert.match(own, /Create your first repository/);

    const anon = await (await ctx.session().fetch(`/@${encodeURIComponent(user.username)}`)).text();
    assert.match(anon, /No repositories yet/);
    assert.doesNotMatch(anon, /\+ New Repository/);
    assert.doesNotMatch(anon, /Create your first repository/);
  });

  test('unknown profiles, missing repositories, and unknown user APIs are 404', async () => {
    const profile = await ctx.session().fetch('/@no-such-user-zz');
    assert.equal(profile.status, 404);
    await profile.text();
    const missing = await ctx.session().fetch('/nobody/missing');
    assert.equal(missing.status, 404);
    await missing.text();
    const api = await ctx.session().fetch('/api/users/no-such-user-zz/repos');
    assert.equal(api.status, 404);
    assert.deepEqual(await api.json(), { error: 'Not found' });
  });

  test('repo names are trimmed, blank names create nothing, and two owners may share a short name', async () => {
    const first = ctx.session();
    const userA = await registerUser(ctx, first);
    const blank = await first.postForm('/new', { name: '   ', description: 'blank-desc-z' });
    assert.equal(blank.status, 200);
    assert.match(await blank.text(), /Name required/);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories WHERE description = ?').get('blank-desc-z').n, 0);
    assert.equal(fs.existsSync(path.join(reposRoot, userA.username)), false);

    await createRepo(first, { name: 'widget', description: 'first-widget' });
    const trimmed = await first.postForm('/new', { name: '  widget  ', description: 'second-widget' });
    assert.equal(trimmed.status, 200);
    assert.match(await trimmed.text(), /Repo already exists/);
    assert.equal(repoRow(ctx.db, `${userA.username}/widget`).description, 'first-widget');

    const second = ctx.session();
    const userB = await registerUser(ctx, second);
    const created = await createRepo(second, { name: 'widget', description: 'other-owner' });
    assert.equal(created.location, `/${userB.username}/widget`);
    assert.equal(repoRow(ctx.db, `${userB.username}/widget`).description, 'other-owner');
    assert.equal(fs.existsSync(barePath(userA.username, 'widget')), true);
    assert.equal(fs.existsSync(barePath(userB.username, 'widget')), true);
  });

  test('a repository name containing markup is stored raw and escaped on the page', async () => {
    const session = ctx.session();
    const user = await registerUser(ctx, session);
    const created = await session.postForm('/new', { name: '<img>', description: '' });
    assert.equal(created.status, 302);
    await created.text();
    assert.equal(repoRow(ctx.db, `${user.username}/<img>`).name, '<img>');

    const page = await session.fetch(`/${user.username}/${encodeURIComponent('<img>')}`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /&lt;img&gt;/);
    assert.equal(html.includes('<img'), false);
    assert.match(html, /echo "# &lt;img&gt;"/);
  });

  test('creating the same repository again does not change its description, privacy, or files', async () => {
    const session = ctx.session();
    const user = await registerUser(ctx, session);
    await createRepo(session, { name: 'demo', description: 'original', isPrivate: false });
    commitToBare(barePath(user.username, 'demo'), {
      files: { 'readme.txt': 'original-body\n' },
      message: 'init',
    });
    const head = require('./helpers').gitSync(['--git-dir', barePath(user.username, 'demo'), 'rev-parse', 'HEAD']).trim();

    const again = await session.postForm('/new', { name: 'demo', description: 'changed', is_private: '1' });
    assert.equal(again.status, 200);
    assert.match(await again.text(), /Repo already exists/);
    const row = repoRow(ctx.db, `${user.username}/demo`);
    assert.equal(row.description, 'original');
    assert.equal(row.private, 0);
    assert.equal(require('./helpers').gitSync(['--git-dir', barePath(user.username, 'demo'), 'rev-parse', 'HEAD']).trim(), head);
    const blob = await session.fetch(`/${user.username}/demo/blob/main/readme.txt`);
    assert.match(await blob.text(), /original-body/);
  });

  test('Vault and vault stay distinct, including folded owner URLs', async () => {
    const username = `Ada${ctx.nextId('V')}`;
    const owner = ctx.session();
    const user = await registerUser(ctx, owner, { username });
    await createRepo(owner, { name: 'Vault', description: 'VAULT_SECRET', isPrivate: true });
    await createRepo(owner, { name: 'vault', description: 'vault-public' });
    commitToBare(barePath(user.username, 'Vault'), { files: { 'readme.txt': 'VAULT_FILE\n' }, message: 'private-commit' });
    commitToBare(barePath(user.username, 'vault'), { files: { 'readme.txt': 'vault-file\n' }, message: 'public-commit' });
    const stranger = ctx.session();
    await registerUser(ctx, stranger);

    const hidden = await stranger.fetch(`/${user.username}/Vault`);
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.text()).includes('VAULT_SECRET'), false);

    const foldedOwner = await stranger.fetch(`/${encodeURIComponent(user.username.toLowerCase())}/Vault`);
    assert.equal(foldedOwner.status, 404);
    assert.equal((await foldedOwner.text()).includes('VAULT_FILE'), false);

    const foldedRepo = await stranger.fetch(`/${user.username}/VAULT`);
    assert.equal(foldedRepo.status, 404);
    assert.equal((await foldedRepo.text()).includes('VAULT_SECRET'), false);

    const visible = await stranger.fetch(`/${user.username}/vault`);
    const visibleHtml = await visible.text();
    assert.equal(visible.status, 200);
    assert.match(visibleHtml, /vault-file/);
    assert.equal(visibleHtml.includes('VAULT_SECRET'), false);
    assert.equal(visibleHtml.includes('VAULT_FILE'), false);

    const blob = await stranger.fetch(`/${user.username}/vault/blob/main/readme.txt`);
    assert.match(await blob.text(), /vault-file/);
    const hiddenBlob = await stranger.fetch(`/${user.username}/Vault/blob/main/readme.txt`);
    assert.equal(hiddenBlob.status, 404);
    assert.equal((await hiddenBlob.text()).includes('VAULT_FILE'), false);

    const settings = await stranger.fetch(`/${user.username}/vault/settings`);
    assert.equal(settings.status, 403);
    assert.equal((await settings.text()).includes('VAULT_SECRET'), false);
    const hiddenSettings = await stranger.fetch(`/${user.username}/Vault/settings`);
    assert.equal(hiddenSettings.status, 404);

    const home = await (await stranger.fetch('/')).text();
    assert.equal(home.includes('VAULT_SECRET'), false);
    const search = await (await stranger.fetch(`/api/search/repos?q=${encodeURIComponent('VAULT_SECRET')}`)).json();
    assert.deepEqual(search, []);
  });

  test('deleting one repository leaves a sibling and another owner with the same short name', async () => {
    const owner = ctx.session();
    const user = await registerUser(ctx, owner);
    await createRepo(owner, { name: 'alpha', description: 'ALPHA_DESC' });
    await createRepo(owner, { name: 'beta', description: 'BETA_DESC' });
    commitToBare(barePath(user.username, 'alpha'), { files: { 'readme.txt': 'ALPHA_FILE\n' }, message: 'ALPHA_MSG' });
    commitToBare(barePath(user.username, 'beta'), { files: { 'readme.txt': 'BETA_FILE\n' }, message: 'BETA_MSG' });

    const other = ctx.session();
    const otherUser = await registerUser(ctx, other);
    await createRepo(other, { name: 'alpha', description: 'OTHER_ALPHA' });
    commitToBare(barePath(otherUser.username, 'alpha'), { files: { 'readme.txt': 'OTHER_ALPHA_FILE\n' }, message: 'other-alpha' });

    const removed = await owner.postForm(`/${user.username}/alpha/settings/delete`, {});
    assert.equal(removed.status, 302);
    await removed.text();

    assert.equal(repoRow(ctx.db, `${user.username}/alpha`), undefined);
    assert.equal(fs.existsSync(barePath(user.username, 'alpha')), false);
    assert.equal(repoRow(ctx.db, `${user.username}/beta`).description, 'BETA_DESC');
    assert.equal(fs.existsSync(barePath(user.username, 'beta')), true);
    assert.equal(repoRow(ctx.db, `${otherUser.username}/alpha`).description, 'OTHER_ALPHA');

    const beta = await (await owner.fetch(`/${user.username}/beta`)).text();
    assert.match(beta, /BETA_FILE/);
    assert.equal(beta.includes('ALPHA_FILE'), false);
    const betaBlob = await owner.fetch(`/${user.username}/beta/blob/main/readme.txt`);
    assert.match(await betaBlob.text(), /BETA_FILE/);

    const profile = await (await owner.fetch(`/@${encodeURIComponent(user.username)}`)).text();
    assert.match(profile, /beta/);
    assert.equal(profile.includes('ALPHA_DESC'), false);

    setUpdatedAt(ctx.db, `${user.username}/beta`, '2099-02-01 00:00:00');
    setUpdatedAt(ctx.db, `${otherUser.username}/alpha`, '2099-01-01 00:00:00');
    const home = await (await ctx.session().fetch('/')).text();
    assert.match(home, /BETA_DESC/);
    assert.equal(home.includes('ALPHA_DESC'), false);
    assert.match(home, /OTHER_ALPHA/);

    const found = await (await ctx.session().fetch(`/api/search/repos?q=${encodeURIComponent('BETA_DESC')}`)).json();
    assert.deepEqual(found.map((repo) => repo.full_name), [`${user.username}/beta`]);
    const lost = await (await ctx.session().fetch(`/api/search/repos?q=${encodeURIComponent('ALPHA_DESC')}`)).json();
    assert.deepEqual(lost, []);

    const betaRefs = await ctx.session().fetch(`/${user.username}/beta/info/refs?service=git-upload-pack`);
    assert.equal(betaRefs.status, 200);
    assert.match(await betaRefs.text(), /refs\/heads\/main/);
    const alphaRefs = await ctx.session().fetch(`/${user.username}/alpha/info/refs?service=git-upload-pack`);
    assert.equal(alphaRefs.status, 404);
    const otherRefs = await ctx.session().fetch(`/${otherUser.username}/alpha/info/refs?service=git-upload-pack`);
    assert.equal(otherRefs.status, 200);
    assert.match(await otherRefs.text(), /refs\/heads\/main/);

    const alphaPage = await owner.fetch(`/${user.username}/alpha`);
    assert.equal(alphaPage.status, 404);
    assert.equal((await alphaPage.text()).includes('ALPHA_FILE'), false);
  });

  test('GET delete does not remove the repository', async () => {
    const session = ctx.session();
    const user = await registerUser(ctx, session);
    await createRepo(session, { name: 'kept', description: 'still-here' });
    commitToBare(barePath(user.username, 'kept'), { files: { 'readme.txt': 'kept-body\n' }, message: 'keep' });
    const head = require('./helpers').gitSync(['--git-dir', barePath(user.username, 'kept'), 'rev-parse', 'HEAD']).trim();

    const res = await session.fetch(`/${user.username}/kept/settings/delete`);
    assert.equal(res.status, 404);
    await res.text();
    assert.equal(require('./helpers').gitSync(['--git-dir', barePath(user.username, 'kept'), 'rev-parse', 'HEAD']).trim(), head);
    assert.equal(repoRow(ctx.db, `${user.username}/kept`).description, 'still-here');
    const blob = await session.fetch(`/${user.username}/kept/blob/main/readme.txt`);
    assert.match(await blob.text(), /kept-body/);
  });

  test('usernames that differ only by case are separate accounts with separate private repositories', async () => {
    const leftName = `Ada${ctx.nextId('C')}`;
    const rightName = leftName.toLowerCase();
    assert.notEqual(leftName, rightName);
    const left = ctx.session();
    const leftUser = await registerUser(ctx, left, { username: leftName });
    const hash = passwordHash(ctx.db, leftUser.username);
    const right = ctx.session();
    const rightUser = await registerUser(ctx, right, { username: rightName });
    assert.equal(passwordHash(ctx.db, leftUser.username), hash);
    assert.notEqual(passwordHash(ctx.db, rightUser.username), hash);

    await createRepo(left, { name: 'vault', description: 'LEFT_SECRET', isPrivate: true });
    await createRepo(right, { name: 'vault', description: 'RIGHT_SECRET', isPrivate: true });

    assert.match(await (await left.fetch(`/@${encodeURIComponent(leftName)}`)).text(), /LEFT_SECRET/);
    assert.equal((await (await left.fetch(`/@${encodeURIComponent(rightName)}`)).text()).includes('RIGHT_SECRET'), false);
    assert.match(await (await right.fetch(`/@${encodeURIComponent(rightName)}`)).text(), /RIGHT_SECRET/);
    assert.equal((await (await right.fetch(`/@${encodeURIComponent(leftName)}`)).text()).includes('LEFT_SECRET'), false);

    const anonLeft = await (await ctx.session().fetch(`/api/users/${encodeURIComponent(leftName)}/repos`)).json();
    const anonRight = await (await ctx.session().fetch(`/api/users/${encodeURIComponent(rightName)}/repos`)).json();
    assert.deepEqual(anonLeft, []);
    assert.deepEqual(anonRight, []);

    const home = await (await ctx.session().fetch('/')).text();
    assert.equal(home.includes('LEFT_SECRET'), false);
    assert.equal(home.includes('RIGHT_SECRET'), false);
  });
});
