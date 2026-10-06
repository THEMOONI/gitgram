const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext, registerUser, assertStatus, uid, passwordHash } = require('./helpers');

async function withApp(fn) {
  const ctx = await createTestContext();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

test('private repositories stay hidden and API payloads omit credentials', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const stranger = await registerUser(ctx);
    const publicName = 'alpha-widgets';
    const privateName = 'alpha-secret';
    const secretDescription = 'top-secret-' + uid('note');
    const hash = passwordHash(ctx, owner.username);

    const publicRepo = await owner.session.postForm('/new', { name: publicName, description: 'visible widget catalog' });
    assertStatus(publicRepo, 302);
    const privateRepo = await owner.session.postForm('/new', {
      name: privateName,
      description: secretDescription,
      is_private: '1'
    });
    assertStatus(privateRepo, 302);
    assert.equal(ctx.db.prepare('SELECT private FROM repositories WHERE name = ?').get(privateName).private, 1);

    const newerName = 'zeta-public';
    const newer = await owner.session.postForm('/new', { name: newerName, description: 'newer public catalog' });
    assertStatus(newer, 302);
    ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE name = ?').run('2020-01-01 00:00:00', publicName);
    ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE name = ?').run('2024-06-01 00:00:00', newerName);
    ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE name = ?').run('2030-01-01 00:00:00', privateName);

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
    assert.equal(searchPublic.text.includes(hash), false);
    assert.equal(searchPublic.text.includes(owner.email), false);

    const searchSecret = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent(secretDescription));
    assert.deepEqual(JSON.parse(searchSecret.text), []);

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
    const ownerRepos = JSON.parse(ownerApi.text);
    assert.deepEqual(ownerRepos.map((repo) => repo.name), [privateName, newerName, publicName]);
    assert.equal(ownerApi.text.includes(hash), false);
    assert.equal(ownerApi.text.includes(owner.password), false);
    assert.equal(ownerRepos.every((repo) => !Object.hasOwn(repo, 'password')), true);

    const strangerApi = await stranger.session.fetch('/api/users/' + owner.username + '/repos');
    assert.deepEqual(JSON.parse(strangerApi.text).map((repo) => repo.name), [newerName, publicName]);

    const anonApi = await ctx.session().fetch('/api/users/' + owner.username + '/repos');
    assert.deepEqual(JSON.parse(anonApi.text).map((repo) => repo.name), [newerName, publicName]);
    assert.equal(anonApi.text.includes(hash), false);
    assert.equal(anonApi.text.includes(owner.email), false);

    const strangerProfile = await stranger.session.fetch('/@' + owner.username);
    assertStatus(strangerProfile, 200);
    assert.match(strangerProfile.text, new RegExp(publicName));
    assert.match(strangerProfile.text, new RegExp(newerName));
    assert.doesNotMatch(strangerProfile.text, new RegExp(privateName));
    assert.doesNotMatch(strangerProfile.text, new RegExp(owner.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(strangerProfile.text, new RegExp(hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const ownerProfile = await owner.session.fetch('/@' + owner.username);
    assert.match(ownerProfile.text, new RegExp(privateName));
    assert.match(ownerProfile.text, /Private/);
    assert.doesNotMatch(ownerProfile.text, new RegExp(hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

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

test('the homepage lists at most the twenty newest public repositories', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const ownerId = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(owner.username).id;
    const insert = ctx.db.prepare('INSERT INTO repositories (name, full_name, description, owner_id, private, updated_at) VALUES (?, ?, ?, ?, ?, ?)');

    for (let i = 0; i < 21; i++) {
      const name = 'listed-' + String(i).padStart(2, '0');
      const day = String(i + 1).padStart(2, '0');
      insert.run(name, owner.username + '/' + name, 'catalog', ownerId, 0, '2020-03-' + day + ' 12:00:00');
    }
    insert.run('hidden-newest', owner.username + '/hidden-newest', 'do not show', ownerId, 1, '2030-01-01 00:00:00');

    const home = await ctx.session().fetch('/');
    assertStatus(home, 200);
    assert.equal(home.text.includes('listed-00'), false);
    assert.equal(home.text.includes('hidden-newest'), false);
    assert.equal(home.text.includes('listed-01'), true);
    assert.equal(home.text.includes('listed-20'), true);
    const newestAt = home.text.indexOf('listed-20');
    const oldestShownAt = home.text.indexOf('listed-01');
    assert.ok(newestAt >= 0 && oldestShownAt > newestAt);
  });
});
