const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createTestContext, registerUser, assertStatus, repoDiskPath, commitToBare, uid } = require('./helpers');

async function withApp(fn) {
  const ctx = await createTestContext();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

async function createRepo(session, fields) {
  return session.postForm('/new', fields);
}

test('repository creation requires a signed-in user and a unique name', async () => {
  await withApp(async (ctx) => {
    const anon = ctx.session();
    const blocked = await anon.postForm('/new', { name: 'widgets', description: 'demo' });
    assertStatus(blocked, 302);
    assert.equal(blocked.headers.get('location'), '/login');

    const owner = await registerUser(ctx);
    const blank = await createRepo(owner.session, { name: '   ', description: 'demo' });
    assertStatus(blank, 200);
    assert.match(blank.text, /Name required/);

    const created = await createRepo(owner.session, { name: 'widgets', description: 'A public widget library' });
    assertStatus(created, 302);
    assert.equal(created.headers.get('location'), '/' + owner.username + '/widgets');
    assert.equal(fs.existsSync(repoDiskPath(owner.username, 'widgets')), true);

    const duplicate = await createRepo(owner.session, { name: 'widgets', description: 'again' });
    assertStatus(duplicate, 200);
    assert.match(duplicate.text, /Repo already exists/);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n, 1);

    const row = ctx.db.prepare('SELECT private, description FROM repositories WHERE full_name = ?').get(owner.username + '/widgets');
    assert.equal(row.private, 0);
    assert.equal(row.description, 'A public widget library');
  });
});

test('private repositories stay hidden from other users, search, and the homepage', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const stranger = await registerUser(ctx);
    const publicName = 'alpha-widgets';
    const privateName = 'alpha-secret';
    const secretDescription = 'top-secret-' + uid('note');

    const publicRepo = await createRepo(owner.session, { name: publicName, description: 'visible widget catalog' });
    assertStatus(publicRepo, 302);
    const privateRepo = await createRepo(owner.session, {
      name: privateName,
      description: secretDescription,
      is_private: '1'
    });
    assertStatus(privateRepo, 302);
    assert.equal(ctx.db.prepare('SELECT private FROM repositories WHERE name = ?').get(privateName).private, 1);

    const newerName = 'zeta-public';
    const newer = await createRepo(owner.session, { name: newerName, description: 'newer public catalog' });
    assertStatus(newer, 302);
    ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE name = ?').run('2020-01-01 00:00:00', publicName);
    ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE name = ?').run('2024-06-01 00:00:00', newerName);

    const home = await ctx.session().fetch('/');
    assertStatus(home, 200);
    assert.match(home.text, new RegExp(owner.username + '/' + publicName));
    assert.doesNotMatch(home.text, new RegExp(privateName));
    assert.doesNotMatch(home.text, new RegExp(secretDescription));
    const newerAt = home.text.indexOf(newerName);
    const olderAt = home.text.indexOf(publicName);
    assert.ok(newerAt >= 0 && olderAt > newerAt);

    const searchPublic = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent('alpha'));
    assertStatus(searchPublic, 200);
    const publicHits = JSON.parse(searchPublic.text);
    assert.deepEqual(publicHits.map((repo) => repo.name), [publicName]);
    assert.equal(JSON.stringify(publicHits).includes(secretDescription), false);
    assert.equal(Object.hasOwn(publicHits[0], 'password'), false);

    const searchDescription = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent('visible widget'));
    assert.deepEqual(JSON.parse(searchDescription.text).map((repo) => repo.name), [publicName]);

    const searchEmpty = await ctx.session().fetch('/api/search/repos');
    assert.deepEqual(JSON.parse(searchEmpty.text), []);

    const searchQuote = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent("' OR private = 1 --"));
    assertStatus(searchQuote, 200);
    assert.deepEqual(JSON.parse(searchQuote.text), []);

    const searchWildcard = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent('%'));
    const wildcardNames = JSON.parse(searchWildcard.text).map((repo) => repo.name);
    assert.equal(wildcardNames.includes(publicName), true);
    assert.equal(wildcardNames.includes(privateName), false);

    const missingUser = await ctx.session().fetch('/api/users/' + uid('ghost') + '/repos');
    assertStatus(missingUser, 404);

    const ownerApi = await owner.session.fetch('/api/users/' + owner.username + '/repos');
    assert.deepEqual(JSON.parse(ownerApi.text).map((repo) => repo.name).sort(), [newerName, privateName, publicName].sort());

    const strangerApi = await stranger.session.fetch('/api/users/' + owner.username + '/repos');
    assert.deepEqual(JSON.parse(strangerApi.text).map((repo) => repo.name).sort(), [newerName, publicName].sort());

    const anonApi = await ctx.session().fetch('/api/users/' + owner.username + '/repos');
    assert.deepEqual(JSON.parse(anonApi.text).map((repo) => repo.name).sort(), [newerName, publicName].sort());
    assert.equal(anonApi.text.includes(owner.password), false);

    const strangerProfile = await stranger.session.fetch('/@' + owner.username);
    assertStatus(strangerProfile, 200);
    assert.match(strangerProfile.text, new RegExp(publicName));
    assert.match(strangerProfile.text, new RegExp(newerName));
    assert.doesNotMatch(strangerProfile.text, new RegExp(privateName));
    assert.doesNotMatch(strangerProfile.text, new RegExp(owner.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const ownerProfile = await owner.session.fetch('/@' + owner.username);
    assert.match(ownerProfile.text, new RegExp(privateName));
    assert.match(ownerProfile.text, /Private/);

    const hiddenPage = await stranger.session.fetch('/' + owner.username + '/' + privateName);
    assertStatus(hiddenPage, 404);
    assert.doesNotMatch(hiddenPage.text, new RegExp(secretDescription));

    const anonHidden = await ctx.session().fetch('/' + owner.username + '/' + privateName);
    assertStatus(anonHidden, 404);

    const ownerPage = await owner.session.fetch('/' + owner.username + '/' + privateName);
    assertStatus(ownerPage, 200);
    assert.match(ownerPage.text, new RegExp(secretDescription));
  });
});

test('only the owner can open settings or delete a repository', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const stranger = await registerUser(ctx);
    const created = await createRepo(owner.session, { name: 'doomed', description: 'keep until owner deletes' });
    assertStatus(created, 302);
    const fullName = owner.username + '/doomed';
    const disk = repoDiskPath(owner.username, 'doomed');

    const strangerSettings = await stranger.session.fetch('/' + fullName + '/settings');
    assertStatus(strangerSettings, 403);
    assert.doesNotMatch(strangerSettings.text, /Danger Zone/);

    const anonDelete = await ctx.session().postForm('/' + fullName + '/settings/delete', {});
    assertStatus(anonDelete, 403);

    const strangerDelete = await stranger.session.postForm('/' + fullName + '/settings/delete', {});
    assertStatus(strangerDelete, 403);
    assert.equal(fs.existsSync(disk), true);
    assert.equal(ctx.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName) != null, true);

    const ownerSettings = await owner.session.fetch('/' + fullName + '/settings');
    assertStatus(ownerSettings, 200);
    assert.match(ownerSettings.text, /Danger Zone/);

    const removed = await owner.session.postForm('/' + fullName + '/settings/delete', {});
    assertStatus(removed, 302);
    assert.equal(removed.headers.get('location'), '/@' + owner.username);
    assert.equal(fs.existsSync(disk), false);
    assert.equal(ctx.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName), undefined);
  });
});

test('repo pages parse commits, readme content, and missing files', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const created = await createRepo(owner.session, { name: 'notes', description: 'commit history' });
    assertStatus(created, 302);

    const emptyCommits = await owner.session.fetch('/' + owner.username + '/notes/commits');
    assertStatus(emptyCommits, 200);
    assert.match(emptyCommits.text, /No commits yet/);

    const emptyRepo = await owner.session.fetch('/' + owner.username + '/notes');
    assert.match(emptyRepo.text, /This repository is empty/);

    const head = commitToBare(repoDiskPath(owner.username, 'notes'), {
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      revisions: [
        {
          message: 'Add README',
          files: {
            'README.md': '<script>alert(1)</script>\nsecond line',
            'docs/guide.txt': 'nested\n'
          }
        },
        {
          message: 'Update README',
          files: {
            'README.md': '<script>alert(1)</script>\nsecond line updated'
          }
        }
      ]
    });
    const shortHash = head.slice(0, 7);

    const repoPage = await owner.session.fetch('/' + owner.username + '/notes');
    assertStatus(repoPage, 200);
    const newerAt = repoPage.text.indexOf('Update README');
    const olderAt = repoPage.text.indexOf('Add README');
    assert.ok(newerAt >= 0 && olderAt > newerAt);
    assert.match(repoPage.text, new RegExp(shortHash));
    assert.doesNotMatch(repoPage.text, new RegExp(head));
    assert.match(repoPage.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(repoPage.text, /<script>alert\(1\)<\/script>/);
    assert.match(repoPage.text, /<span>📄<\/span><a href="[^"]+\/README\.md" class="file-name">README\.md<\/a>/);
    assert.match(repoPage.text, /<span><\/span><a href="[^"]+\/docs" class="file-name">docs<\/a>/);

    const filePage = await owner.session.fetch('/' + owner.username + '/notes/blob/main/README.md');
    assertStatus(filePage, 200);
    assert.match(filePage.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(filePage.text, /second line updated/);
    assert.match(filePage.text, /2 lines/);
    assert.doesNotMatch(filePage.text, /<script>alert\(1\)<\/script>/);

    const missing = await owner.session.fetch('/' + owner.username + '/notes/blob/main/missing.txt');
    assertStatus(missing, 404);

    const commitsPage = await owner.session.fetch('/' + owner.username + '/notes/commits');
    assert.match(commitsPage.text, /Update README/);
    assert.match(commitsPage.text, /Ada Lovelace/);
    assert.match(commitsPage.text, new RegExp(shortHash));
    assert.doesNotMatch(commitsPage.text, /Invalid date/);
    const commitsNewer = commitsPage.text.indexOf('Update README');
    const commitsOlder = commitsPage.text.indexOf('Add README');
    assert.ok(commitsNewer >= 0 && commitsOlder > commitsNewer);
  });
});
