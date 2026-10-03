const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { execFileSync } = require('child_process');
const {
  Agent,
  closeTestContext,
  createTestContext,
  registerUser,
  repoPathFor,
  seedBareRepo,
  trackRepo,
  uniqueId,
} = require('./helpers');

describe('repository privacy and ownership', { concurrency: 1 }, () => {
  let ctx;

  before(async () => {
    ctx = await createTestContext();
  });

  after(async () => {
    await closeTestContext(ctx);
  });

  test('requires a name, blocks anonymous creation, and rejects duplicates', async () => {
    const owner = new Agent(ctx.server);
    const registered = await registerUser(owner, {});
    trackRepo(ctx, registered.username);

    const anonymous = await new Agent(ctx.server).request('POST', '/new', {
      form: { name: `ghost${uniqueId()}`, description: 'should not exist' },
    });
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get('location'), '/login');
    assert.equal(ctx.db.prepare('SELECT id FROM repositories WHERE description = ?').get('should not exist'), undefined);

    const blank = await owner.request('POST', '/new', {
      form: { name: '   ', description: 'blank name' },
    });
    assert.equal(blank.status, 200);
    assert.match(blank.text, /Name required/);
    assert.equal(ctx.db.prepare('SELECT id FROM repositories WHERE description = ?').get('blank name'), undefined);

    const name = `app${uniqueId()}`;
    const created = await owner.request('POST', '/new', {
      form: { name: `  ${name}  `, description: 'first copy', is_private: '1' },
    });
    assert.equal(created.status, 302);
    assert.equal(created.headers.get('location'), `/${registered.username}/${name}`);
    const row = ctx.db.prepare('SELECT * FROM repositories WHERE full_name = ?').get(`${registered.username}/${name}`);
    assert.equal(row.private, 1);
    assert.equal(row.description, 'first copy');
    assert.equal(fs.existsSync(repoPathFor(registered.username, name)), true);

    const duplicate = await owner.request('POST', '/new', {
      form: { name, description: 'second copy' },
    });
    assert.match(duplicate.text, /Repo already exists/);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM repositories WHERE full_name = ?').get(`${registered.username}/${name}`).count, 1);

    const publicName = `open${uniqueId()}`;
    const createdPublic = await owner.request('POST', '/new', {
      form: { name: publicName, description: 'listed publicly' },
    });
    assert.equal(createdPublic.status, 302);
    const publicRow = ctx.db.prepare('SELECT private FROM repositories WHERE full_name = ?').get(`${registered.username}/${publicName}`);
    assert.equal(publicRow.private, 0);

    const newRepoPage = await owner.request('GET', '/new');
    assert.equal(newRepoPage.status, 200);
    assert.match(newRepoPage.text, /Create a new repository/);

    const anonymousNew = await new Agent(ctx.server).request('GET', '/new');
    assert.equal(anonymousNew.status, 302);
    assert.equal(anonymousNew.headers.get('location'), '/login');

    const emptyCommits = await owner.request('GET', `/${registered.username}/${publicName}/commits`);
    assert.equal(emptyCommits.status, 200);
    assert.match(emptyCommits.text, /No commits yet/);
  });

  test('hides private repositories from anonymous visitors and other users', async () => {
    const owner = new Agent(ctx.server);
    const ownerAccount = await registerUser(owner, {});
    const stranger = new Agent(ctx.server);
    await registerUser(stranger, {});
    trackRepo(ctx, ownerAccount.username);

    const publicName = `pub${uniqueId()}`;
    const privateName = `priv${uniqueId()}`;
    const publicDescription = `visible-${uniqueId()}`;
    const privateDescription = `hidden-${uniqueId()}`;

    assert.equal((await owner.request('POST', '/new', {
      form: { name: publicName, description: publicDescription },
    })).status, 302);
    assert.equal((await owner.request('POST', '/new', {
      form: { name: privateName, description: privateDescription, is_private: '1' },
    })).status, 302);

    const home = await new Agent(ctx.server).request('GET', '/');
    assert.match(home.text, new RegExp(publicName));
    assert.doesNotMatch(home.text, new RegExp(privateName));

    const ownerProfile = await owner.request('GET', `/@${ownerAccount.username}`);
    assert.equal(ownerProfile.status, 200);
    assert.match(ownerProfile.text, new RegExp(privateName));
    assert.match(ownerProfile.text, /badge-private/);

    const publicProfile = await new Agent(ctx.server).request('GET', `/@${ownerAccount.username}`);
    assert.match(publicProfile.text, new RegExp(publicName));
    assert.doesNotMatch(publicProfile.text, new RegExp(privateName));
    assert.doesNotMatch(publicProfile.text, new RegExp(privateDescription));

    const privatePage = await stranger.request('GET', `/${ownerAccount.username}/${privateName}`);
    assert.notEqual(privatePage.status, 200);
    assert.doesNotMatch(privatePage.text, new RegExp(privateDescription));

    const ownerPage = await owner.request('GET', `/${ownerAccount.username}/${privateName}`);
    assert.equal(ownerPage.status, 200);
    assert.match(ownerPage.text, new RegExp(privateDescription));
    assert.match(ownerPage.text, /Quick setup/);
  });

  test('search and user repository APIs omit private data and account secrets', async () => {
    const owner = new Agent(ctx.server);
    const ownerAccount = await registerUser(owner, {});
    trackRepo(ctx, ownerAccount.username);
    const token = uniqueId();
    const publicName = `searchpub${token}`;
    const privateName = `searchpriv${token}`;

    await owner.request('POST', '/new', { form: { name: publicName, description: `notes ${token}` } });
    await owner.request('POST', '/new', { form: { name: privateName, description: `secret ${token}`, is_private: '1' } });

    const empty = await new Agent(ctx.server).request('GET', '/api/search/repos');
    assert.equal(empty.status, 200);
    assert.deepEqual(JSON.parse(empty.text), []);

    const search = await new Agent(ctx.server).request('GET', `/api/search/repos?q=${encodeURIComponent(token)}`);
    const found = JSON.parse(search.text);
    assert.deepEqual(found.map((repo) => repo.name), [publicName]);
    assert.equal(found[0].owner_name, ownerAccount.username);
    assert.equal(Object.hasOwn(found[0], 'password'), false);
    assert.equal(Object.hasOwn(found[0], 'email'), false);

    const quoted = await new Agent(ctx.server).request('GET', `/api/search/repos?q=${encodeURIComponent(`' OR 1=1 -- ${token}`)}`);
    assert.deepEqual(JSON.parse(quoted.text), []);

    const missingUser = await new Agent(ctx.server).request('GET', `/api/users/missing${token}/repos`);
    assert.equal(missingUser.status, 404);
    assert.deepEqual(JSON.parse(missingUser.text), { error: 'Not found' });

    const anonymousRepos = JSON.parse((await new Agent(ctx.server).request('GET', `/api/users/${ownerAccount.username}/repos`)).text);
    assert.deepEqual(anonymousRepos.map((repo) => repo.name), [publicName]);

    const ownerRepos = JSON.parse((await owner.request('GET', `/api/users/${ownerAccount.username}/repos`)).text);
    assert.deepEqual(ownerRepos.map((repo) => repo.name).sort(), [privateName, publicName].sort());
    assert.equal(ownerRepos.some((repo) => Object.hasOwn(repo, 'password')), false);

    const stranger = new Agent(ctx.server);
    await registerUser(stranger, {});
    const strangerRepos = JSON.parse((await stranger.request('GET', `/api/users/${ownerAccount.username}/repos`)).text);
    assert.deepEqual(strangerRepos.map((repo) => repo.name), [publicName]);

    const strangerProfile = await stranger.request('GET', `/@${ownerAccount.username}`);
    assert.equal(strangerProfile.status, 200);
    assert.match(strangerProfile.text, new RegExp(publicName));
    assert.doesNotMatch(strangerProfile.text, new RegExp(privateName));
    assert.doesNotMatch(strangerProfile.text, new RegExp(`secret ${token}`));

    const describedName = `described${uniqueId()}`;
    const describedToken = `desc${uniqueId()}`;
    await owner.request('POST', '/new', {
      form: { name: describedName, description: `overview ${describedToken}` },
    });
    await owner.request('POST', '/new', {
      form: { name: `hidden${uniqueId()}`, description: `classified ${describedToken}`, is_private: '1' },
    });
    const byDescription = JSON.parse((await stranger.request('GET', `/api/search/repos?q=${encodeURIComponent(describedToken)}`)).text);
    assert.deepEqual(byDescription.map((repo) => repo.name), [describedName]);

    const wildcard = JSON.parse((await owner.request('GET', `/api/search/repos?q=${encodeURIComponent('%')}`)).text);
    assert.equal(wildcard.some((repo) => repo.name === privateName), false);
    assert.equal(wildcard.some((repo) => String(repo.description).includes(`secret ${token}`)), false);
  });

  test('only the owner can open settings or delete a repository', async () => {
    const owner = new Agent(ctx.server);
    const ownerAccount = await registerUser(owner, {});
    const stranger = new Agent(ctx.server);
    const strangerAccount = await registerUser(stranger, {});
    trackRepo(ctx, ownerAccount.username);
    trackRepo(ctx, strangerAccount.username);

    const name = `owned${uniqueId()}`;
    const description = `delete-me-${uniqueId()}`;
    assert.equal((await owner.request('POST', '/new', { form: { name, description } })).status, 302);
    const fullName = `${ownerAccount.username}/${name}`;

    const strangerSettings = await stranger.request('GET', `/${fullName}/settings`);
    assert.notEqual(strangerSettings.status, 200);
    assert.doesNotMatch(strangerSettings.text, /Danger Zone/);

    const strangerDelete = await stranger.request('POST', `/${fullName}/settings/delete`);
    assert.notEqual(strangerDelete.status, 302);
    assert.ok(ctx.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName));
    assert.equal(fs.existsSync(repoPathFor(ownerAccount.username, name)), true);

    const ownerSettings = await owner.request('GET', `/${fullName}/settings`);
    assert.equal(ownerSettings.status, 200);
    assert.match(ownerSettings.text, /Danger Zone/);
    assert.match(ownerSettings.text, new RegExp(`/${fullName}/settings/delete`));

    const deleted = await owner.request('POST', `/${fullName}/settings/delete`);
    assert.equal(deleted.status, 302);
    assert.equal(deleted.headers.get('location'), `/@${ownerAccount.username}`);
    assert.equal(ctx.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName), undefined);
    assert.equal(fs.existsSync(repoPathFor(ownerAccount.username, name)), false);

    const profile = await owner.request('GET', `/@${ownerAccount.username}`);
    assert.doesNotMatch(profile.text, new RegExp(description));
  });

  test('anonymous visitors cannot administer a public repository', async () => {
    const owner = new Agent(ctx.server);
    const ownerAccount = await registerUser(owner, {});
    trackRepo(ctx, ownerAccount.username);
    const name = `pubadmin${uniqueId()}`;
    assert.equal((await owner.request('POST', '/new', { form: { name, description: 'public admin target' } })).status, 302);
    const fullName = `${ownerAccount.username}/${name}`;

    const anonymous = new Agent(ctx.server);
    const settings = await anonymous.request('GET', `/${fullName}/settings`);
    assert.notEqual(settings.status, 200);
    assert.doesNotMatch(settings.text, /Danger Zone/);

    const deleted = await anonymous.request('POST', `/${fullName}/settings/delete`);
    assert.notEqual(deleted.status, 302);
    assert.ok(ctx.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName));
    assert.equal(fs.existsSync(repoPathFor(ownerAccount.username, name)), true);

    const page = await anonymous.request('GET', `/${fullName}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /public admin target/);
    assert.match(page.text, /badge-public/);
  });

  test('home lists newer public repositories first and omits private ones', async () => {
    const owner = new Agent(ctx.server);
    const ownerAccount = await registerUser(owner, {});
    const ownerId = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(ownerAccount.username).id;
    const older = `older${uniqueId()}`;
    const newer = `newer${uniqueId()}`;
    const concealed = `concealed${uniqueId()}`;
    const insert = ctx.db.prepare('INSERT INTO repositories (name, full_name, description, owner_id, private, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(older, `${ownerAccount.username}/${older}`, 'old public', ownerId, 0, '2020-01-01 00:00:00');
    insert.run(newer, `${ownerAccount.username}/${newer}`, 'new public', ownerId, 0, '2099-01-01 00:00:00');
    insert.run(concealed, `${ownerAccount.username}/${concealed}`, 'new private', ownerId, 1, '2099-06-01 00:00:00');

    const home = await new Agent(ctx.server).request('GET', '/');
    assert.equal(home.status, 200);
    const newerAt = home.text.indexOf(newer);
    const olderAt = home.text.indexOf(older);
    assert.ok(newerAt >= 0 && olderAt > newerAt);
    assert.doesNotMatch(home.text, new RegExp(concealed));
    assert.doesNotMatch(home.text, /new private/);
  });

  test('private repository contents stay hidden from other signed-in users', async () => {
    const owner = new Agent(ctx.server);
    const ownerAccount = await registerUser(owner, {});
    const stranger = new Agent(ctx.server);
    await registerUser(stranger, {});
    trackRepo(ctx, ownerAccount.username);

    const name = `sealed${uniqueId()}`;
    const secret = `sealed-body-${uniqueId()}`;
    const message = `sealed-commit-${uniqueId()}`;
    seedBareRepo(repoPathFor(ownerAccount.username, name), {
      files: [
        { name: 'README.md', content: `${secret}\n` },
        { name: 'src/hidden.txt', content: 'nested secret\n' },
      ],
      message,
      authorName: 'Secret Author',
      authorEmail: 'secret@example.com',
    });
    const ownerId = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(ownerAccount.username).id;
    ctx.db.prepare('INSERT INTO repositories (name, full_name, description, owner_id, private) VALUES (?, ?, ?, ?, 1)')
      .run(name, `${ownerAccount.username}/${name}`, secret, ownerId);

    const fullName = `${ownerAccount.username}/${name}`;
    for (const path of [`/${fullName}`, `/${fullName}/commits`, `/${fullName}/blob/main/README.md`, `/${fullName}/settings`]) {
      const response = await stranger.request('GET', path);
      assert.notEqual(response.status, 200);
      assert.doesNotMatch(response.text, new RegExp(secret));
      assert.doesNotMatch(response.text, new RegExp(message));
    }

    const ownerBlob = await owner.request('GET', `/${fullName}/blob/main/README.md`);
    assert.equal(ownerBlob.status, 200);
    assert.match(ownerBlob.text, new RegExp(secret));

    const head = execFileSync('git', ['--git-dir', repoPathFor(ownerAccount.username, name), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const ownerCommits = await owner.request('GET', `/${fullName}/commits`);
    assert.match(ownerCommits.text, new RegExp(message));
    assert.match(ownerCommits.text, new RegExp(head.slice(0, 7)));
  });
});
