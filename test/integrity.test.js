const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const {
  createTestContext,
  registerUser,
  assertStatus,
  repoDiskPath,
  commitToBare,
  passwordHash,
  headOf,
  uid
} = require('./helpers');

async function withApp(fn) {
  const ctx = await createTestContext();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

test('creating the same repository again does not replace history or visibility', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const created = await owner.session.postForm('/new', {
      name: 'notes',
      description: 'original notes'
    });
    assertStatus(created, 302);

    const disk = repoDiskPath(owner.username, 'notes');
    const marker = 'keep-this-body-' + uid('blob');
    commitToBare(disk, {
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      message: 'Keep this commit',
      files: { 'readme.txt': marker + '\n' }
    });
    const head = headOf(disk);

    const duplicate = await owner.session.postForm('/new', {
      name: 'notes',
      description: 'replaced description',
      is_private: '1'
    });
    assertStatus(duplicate, 200);
    assert.match(duplicate.text, /Repo already exists/);

    const row = ctx.db.prepare('SELECT description, private FROM repositories WHERE full_name = ?').get(owner.username + '/notes');
    assert.equal(row.description, 'original notes');
    assert.equal(row.private, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n, 1);
    assert.equal(headOf(disk), head);

    const blob = await owner.session.fetch('/' + owner.username + '/notes/blob/main/readme.txt');
    assertStatus(blob, 200);
    assert.match(blob.text, new RegExp(marker));
    const repoPage = await owner.session.fetch('/' + owner.username + '/notes');
    assertStatus(repoPage, 200);
    assert.match(repoPage.text, /Keep this commit/);
  });
});

test('case-distinct repository URLs do not reveal the private twin', async () => {
  await withApp(async (ctx) => {
    const username = 'Ada' + uid('U');
    const owner = await registerUser(ctx, { username });
    const foldedOwner = username.toLowerCase();
    assert.notEqual(foldedOwner, username);

    const secret = 'case-secret-' + uid('note');
    const fileSecret = 'case-file-' + uid('blob');
    const privateRepo = await owner.session.postForm('/new', {
      name: 'Vault',
      description: secret,
      is_private: '1'
    });
    assertStatus(privateRepo, 302);
    commitToBare(repoDiskPath(username, 'Vault'), {
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      message: 'Store the vault',
      files: { 'secret.txt': fileSecret + '\n' }
    });

    const publicRepo = await owner.session.postForm('/new', {
      name: 'vault',
      description: 'public lowercase catalog'
    });
    assertStatus(publicRepo, 302);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories WHERE name = ? OR name = ?').get('Vault', 'vault').n, 2);

    const home = await ctx.session().fetch('/');
    assertStatus(home, 200);
    assert.match(home.text, /public lowercase catalog/);
    assert.doesNotMatch(home.text, new RegExp(secret));
    assert.doesNotMatch(home.text, new RegExp(fileSecret));

    const search = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent(secret));
    assert.deepEqual(JSON.parse(search.text), []);
    const publicSearch = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent('lowercase catalog'));
    assert.deepEqual(JSON.parse(publicSearch.text).map((repo) => repo.name), ['vault']);

    const hiddenPaths = [
      '/' + foldedOwner + '/Vault',
      '/' + foldedOwner + '/vault',
      '/' + foldedOwner + '/Vault/blob/main/secret.txt',
      '/' + foldedOwner + '/Vault/commits',
      '/' + foldedOwner + '/Vault/settings',
      '/' + username + '/vault/blob/main/secret.txt'
    ];
    for (const session of [owner.session, ctx.session()]) {
      for (const urlPath of hiddenPaths) {
        const hidden = await session.fetch(urlPath);
        assertStatus(hidden, 404);
        assert.doesNotMatch(hidden.text, new RegExp(secret));
        assert.doesNotMatch(hidden.text, new RegExp(fileSecret));
        assert.doesNotMatch(hidden.text, /Danger Zone/);
      }
      const denied = await session.postForm('/' + foldedOwner + '/Vault/settings/delete', {});
      assertStatus(denied, 404);
      assert.doesNotMatch(denied.text, new RegExp(fileSecret));
    }

    const publicPath = '/' + username + '/vault';
    const publicPage = await ctx.session().fetch(publicPath);
    assertStatus(publicPage, 200);
    assert.match(publicPage.text, /public lowercase catalog/);
    assert.doesNotMatch(publicPage.text, new RegExp(secret));
    assert.doesNotMatch(publicPage.text, new RegExp(fileSecret));

    const ownerPublic = await owner.session.fetch(publicPath);
    assertStatus(ownerPublic, 200);
    assert.doesNotMatch(ownerPublic.text, new RegExp(secret));
    assert.doesNotMatch(ownerPublic.text, new RegExp(fileSecret));

    const ownerPrivate = await owner.session.fetch('/' + username + '/Vault');
    assertStatus(ownerPrivate, 200);
    assert.match(ownerPrivate.text, new RegExp(secret));
    const ownerFile = await owner.session.fetch('/' + username + '/Vault/blob/main/secret.txt');
    assertStatus(ownerFile, 200);
    assert.match(ownerFile.text, new RegExp(fileSecret));
    assert.equal(fs.existsSync(repoDiskPath(username, 'Vault')), true);
    assert.equal(fs.existsSync(repoDiskPath(username, 'vault')), true);
  });
});

test('login replaces only that browser session', async () => {
  await withApp(async (ctx) => {
    const alice = await registerUser(ctx);
    const bob = await registerUser(ctx);
    const aliceSecret = 'alice-secret-' + uid('note');
    const bobSecret = 'bob-secret-' + uid('note');
    const aliceRepo = await alice.session.postForm('/new', {
      name: 'diary',
      description: aliceSecret,
      is_private: '1'
    });
    assertStatus(aliceRepo, 302);
    const bobRepo = await bob.session.postForm('/new', {
      name: 'diary',
      description: bobSecret,
      is_private: '1'
    });
    assertStatus(bobRepo, 302);

    const secondBrowser = ctx.session();
    const aliceLogin = await secondBrowser.postForm('/login', {
      username: alice.username,
      password: alice.password
    });
    assertStatus(aliceLogin, 302);

    const switched = await alice.session.postForm('/login', {
      username: bob.username,
      password: bob.password
    });
    assertStatus(switched, 302);
    assert.equal(switched.headers.get('location'), '/');

    const home = await alice.session.fetch('/');
    assertStatus(home, 200);
    assert.match(home.text, new RegExp('/@' + bob.username));
    assert.doesNotMatch(home.text, new RegExp('/@' + alice.username));
    assert.doesNotMatch(home.text, new RegExp(aliceSecret));

    const aliceHidden = await alice.session.fetch('/' + alice.username + '/diary');
    assertStatus(aliceHidden, 404);
    assert.doesNotMatch(aliceHidden.text, new RegExp(aliceSecret));

    const bobVisible = await alice.session.fetch('/' + bob.username + '/diary');
    assertStatus(bobVisible, 200);
    assert.match(bobVisible.text, new RegExp(bobSecret));
    assert.doesNotMatch(bobVisible.text, new RegExp(aliceSecret));

    const deniedDelete = await alice.session.postForm('/' + alice.username + '/diary/settings/delete', {});
    assertStatus(deniedDelete, 404);
    assert.equal(fs.existsSync(repoDiskPath(alice.username, 'diary')), true);
    assert.equal(ctx.db.prepare('SELECT description FROM repositories WHERE full_name = ?').get(alice.username + '/diary').description, aliceSecret);

    const stillAlice = await secondBrowser.fetch('/' + alice.username + '/diary');
    assertStatus(stillAlice, 200);
    assert.match(stillAlice.text, new RegExp(aliceSecret));

    const loggedOut = await secondBrowser.fetch('/logout');
    assertStatus(loggedOut, 302);
    const afterLogout = await secondBrowser.fetch('/' + alice.username + '/diary');
    assertStatus(afterLogout, 404);
    assert.doesNotMatch(afterLogout.text, new RegExp(aliceSecret));

    const bobStill = await alice.session.fetch('/' + bob.username + '/diary');
    assertStatus(bobStill, 200);
    assert.match(bobStill.text, new RegExp(bobSecret));
    const bobHome = await bob.session.fetch('/');
    assert.match(bobHome.text, new RegExp('/@' + bob.username));
  });
});

test('a signed-in duplicate registration does not replace the password or the session', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx, { password: 'correct-horse' });
    const secret = 'session-secret-' + uid('note');
    const created = await owner.session.postForm('/new', {
      name: 'kept',
      description: secret,
      is_private: '1'
    });
    assertStatus(created, 302);
    const hash = passwordHash(ctx, owner.username);
    const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

    const incomplete = await owner.session.postForm('/register', {
      username: owner.username,
      email: '',
      password: ''
    });
    assertStatus(incomplete, 200);
    assert.match(incomplete.text, /All fields required/);

    const duplicate = await owner.session.postForm('/register', {
      username: owner.username,
      email: uid('other') + '@example.com',
      password: 'attacker-password'
    });
    assertStatus(duplicate, 200);
    assert.match(duplicate.text, /User already exists/);
    assert.equal(passwordHash(ctx, owner.username), hash);
    assert.equal(bcrypt.compareSync('correct-horse', hash), true);
    assert.equal(bcrypt.compareSync('attacker-password', passwordHash(ctx, owner.username)), false);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before);

    const stillOwner = await owner.session.fetch('/' + owner.username + '/kept');
    assertStatus(stillOwner, 200);
    assert.match(stillOwner.text, new RegExp(secret));
    const nav = await owner.session.fetch('/');
    assert.match(nav.text, new RegExp('/@' + owner.username));
  });
});

test('GET does not delete a repository', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'kept', description: 'survive a GET' });
    assertStatus(created, 302);
    const disk = repoDiskPath(owner.username, 'kept');
    const marker = 'survive-body-' + uid('blob');
    commitToBare(disk, {
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      message: 'Do not drop this',
      files: { 'readme.txt': marker + '\n' }
    });
    const head = headOf(disk);
    const fullName = owner.username + '/kept';

    const getDelete = await owner.session.fetch('/' + fullName + '/settings/delete');
    assertStatus(getDelete, 404);
    assert.equal(headOf(disk), head);
    assert.equal(ctx.db.prepare('SELECT description FROM repositories WHERE full_name = ?').get(fullName).description, 'survive a GET');

    const blob = await owner.session.fetch('/' + fullName + '/blob/main/readme.txt');
    assertStatus(blob, 200);
    assert.match(blob.text, new RegExp(marker));

    const stranger = await registerUser(ctx);
    const strangerGet = await stranger.session.fetch('/' + fullName + '/settings/delete');
    assertStatus(strangerGet, 404);
    assert.equal(fs.existsSync(disk), true);
    assert.equal(headOf(disk), head);
  });
});

test('a dotted repository name keeps its stem and clone suffix distinct', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const created = await owner.session.postForm('/new', {
      name: 'web.app',
      description: 'dotted catalog'
    });
    assertStatus(created, 302);
    assert.equal(created.headers.get('location'), '/' + owner.username + '/web.app');
    assert.equal(fs.existsSync(repoDiskPath(owner.username, 'web.app')), true);

    const page = await ctx.session().fetch('/' + owner.username + '/web.app');
    assertStatus(page, 200);
    assert.match(page.text, /dotted catalog/);
    assert.match(page.text, new RegExp(owner.username + '/web\\.app\\.git'));

    const missingStem = await ctx.session().fetch('/' + owner.username + '/web');
    assertStatus(missingStem, 404);
    assert.doesNotMatch(missingStem.text, /dotted catalog/);

    const advertised = await ctx.session().fetch('/' + owner.username + '/web.app.git/info/refs?service=git-upload-pack');
    assertStatus(advertised, 200);
    assert.equal(advertised.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
    assert.ok(advertised.text.startsWith('001e# service=git-upload-pack\n0000'));

    const truncated = await ctx.session().fetch('/' + owner.username + '/web.git/info/refs?service=git-upload-pack');
    assertStatus(truncated, 404);
    assert.equal(truncated.text, 'Not found');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories WHERE name = ?').get('web.app').n, 1);
    assert.equal(ctx.db.prepare('SELECT id FROM repositories WHERE name = ?').get('web'), undefined);
  });
});
