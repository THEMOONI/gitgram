const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { createTestContext, registerUser, assertStatus, repoDiskPath, commitToBare, uid } = require('./helpers');

async function withApp(fn) {
  const ctx = await createTestContext();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function basic(username, password) {
  return 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
}

test('HEAD omits deleted files while the old commit still serves them', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const stranger = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'notes', description: 'shared notes' });
    assertStatus(created, 302);

    const secret = 'deleted-body-' + uid('blob');
    const disk = repoDiskPath(owner.username, 'notes');
    commitToBare(disk, {
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      revisions: [
        {
          message: 'Add secret plan',
          files: {
            'secret-plan.txt': secret + '\n',
            'README.md': 'visible readme\n'
          }
        },
        {
          message: 'Remove the plan',
          remove: ['secret-plan.txt']
        }
      ]
    });

    const hashes = execFileSync('git', ['--git-dir', disk, 'rev-list', '--reverse', 'HEAD'], { encoding: 'utf8' })
      .trim()
      .split('\n');
    const fullName = owner.username + '/notes';

    const repoPage = await owner.session.fetch('/' + fullName);
    assertStatus(repoPage, 200);
    assert.match(repoPage.text, /badge-public/);
    assert.doesNotMatch(repoPage.text, /badge-private/);
    assert.match(repoPage.text, /2 commits</);
    assert.match(repoPage.text, new RegExp('/' + fullName + '/blob/main/README.md'));
    assert.match(repoPage.text, /visible readme/);
    assert.match(repoPage.text, /Remove the plan/);
    assert.match(repoPage.text, /Settings/);
    assert.doesNotMatch(repoPage.text, /secret-plan\.txt/);
    assert.doesNotMatch(repoPage.text, new RegExp(secret));

    const strangerPage = await stranger.session.fetch('/' + fullName);
    assertStatus(strangerPage, 200);
    assert.doesNotMatch(strangerPage.text, /Settings/);
    assert.doesNotMatch(strangerPage.text, new RegExp(secret));

    const removed = await ctx.session().fetch('/' + fullName + '/blob/main/secret-plan.txt');
    assertStatus(removed, 404);
    assert.doesNotMatch(removed.text, new RegExp(secret));

    const historical = await ctx.session().fetch('/' + fullName + '/blob/' + hashes[0] + '/secret-plan.txt');
    assertStatus(historical, 200);
    assert.match(historical.text, new RegExp(secret));
    assert.match(historical.text, /secret-plan\.txt/);
  });
});

test('commit history keeps the fifty newest commits and the repo page keeps five', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'timeline', description: 'long history' });
    assertStatus(created, 302);

    const revisions = [];
    for (let i = 0; i < 51; i++) {
      const label = String(i).padStart(2, '0');
      revisions.push({
        message: 'cmt-' + label,
        files: { 'note.txt': 'body-' + label + '\n' }
      });
    }
    commitToBare(repoDiskPath(owner.username, 'timeline'), {
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      revisions
    });

    const fullName = owner.username + '/timeline';
    const repoPage = await ctx.session().fetch('/' + fullName);
    assertStatus(repoPage, 200);
    assert.match(repoPage.text, /cmt-50/);
    assert.match(repoPage.text, /cmt-46/);
    assert.doesNotMatch(repoPage.text, /cmt-45/);
    assert.doesNotMatch(repoPage.text, /cmt-00/);
    assert.match(repoPage.text, /View all commits/);

    const history = await ctx.session().fetch('/' + fullName + '/commits');
    assertStatus(history, 200);
    const newestAt = history.text.indexOf('cmt-50');
    const oldestKeptAt = history.text.indexOf('cmt-01');
    assert.ok(newestAt >= 0 && oldestKeptAt > newestAt);
    assert.equal(history.text.includes('cmt-45'), true);
    assert.equal(history.text.includes('cmt-00'), false);
  });
});

test('a username containing & is escaped on the profile, nav, and repository page', async () => {
  await withApp(async (ctx) => {
    const username = 'a&b' + uid('u');
    const owner = await registerUser(ctx, { username, email: uid('amp') + '@example.com' });
    assertStatus(owner.res, 302);
    const encoded = encodeURIComponent(username);

    const profile = await ctx.session().fetch('/@' + encoded);
    assertStatus(profile, 200);
    assert.match(profile.text, /a&amp;b/);
    assert.doesNotMatch(profile.text, /a&b/);

    const home = await owner.session.fetch('/');
    assertStatus(home, 200);
    assert.match(home.text, /a&amp;b/);
    assert.doesNotMatch(home.text, /a&b/);
    assert.match(home.text, /Create a repository/);
    assert.doesNotMatch(home.text, /Start for free/);

    const created = await owner.session.postForm('/new', { name: 'widgets', description: 'escaped owner' });
    assertStatus(created, 302);
    const repoPage = await ctx.session().fetch('/' + encoded + '/widgets');
    assertStatus(repoPage, 200);
    assert.match(repoPage.text, /repo-title-owner">a&amp;b/);
    assert.match(repoPage.text, /href="\/@a&amp;b/);
    assert.doesNotMatch(repoPage.text, /a&b/);
  });
});

test('only the owner can push to a private repository, and the owner can read its single commit', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const stranger = await registerUser(ctx);
    const created = await owner.session.postForm('/new', {
      name: 'vault',
      description: 'owner only',
      is_private: '1'
    });
    assertStatus(created, 302);
    const fullName = owner.username + '/vault';
    commitToBare(repoDiskPath(owner.username, 'vault'), {
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      message: 'Initial private note',
      files: { 'README.md': 'private body\n' }
    });
    ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE full_name = ?').run('2000-01-01 00:00:00', fullName);

    const ownerPage = await owner.session.fetch('/' + fullName);
    assertStatus(ownerPage, 200);
    assert.match(ownerPage.text, /badge-private/);
    assert.doesNotMatch(ownerPage.text, /badge-public/);
    assert.match(ownerPage.text, /1 commit</);
    assert.match(ownerPage.text, /Initial private note/);
    assert.match(ownerPage.text, new RegExp('/' + fullName + '/blob/main/README.md'));
    assert.match(ownerPage.text, /Settings/);

    const hiddenHistory = await stranger.session.fetch('/' + fullName + '/commits');
    assertStatus(hiddenHistory, 404);
    assert.doesNotMatch(hiddenHistory.text, /Initial private note/);

    const pushPath = '/' + owner.username + '/vault.git/git-receive-pack';
    const nonOwner = await ctx.session().fetch(pushPath, {
      method: 'POST',
      headers: { authorization: basic(stranger.username, stranger.password) }
    });
    assertStatus(nonOwner, 403);
    assert.equal(nonOwner.text, 'Permission denied');
    assert.equal(ctx.db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(fullName).updated_at, '2000-01-01 00:00:00');

    const ownerPush = await ctx.session().fetch(pushPath, {
      method: 'POST',
      headers: { authorization: basic(owner.username, owner.password) }
    });
    assertStatus(ownerPush, 200);
    assert.equal(ownerPush.headers.get('content-type'), 'application/x-git-receive-pack-result');

    let refreshed = '2000-01-01 00:00:00';
    for (let attempt = 0; attempt < 20 && refreshed === '2000-01-01 00:00:00'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      refreshed = ctx.db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(fullName).updated_at;
    }
    assert.notEqual(refreshed, '2000-01-01 00:00:00');
  });
});

test('search matches public names regardless of case and unknown users return JSON', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const publicRepo = await owner.session.postForm('/new', { name: 'WidgetLib', description: 'unrelated catalog' });
    assertStatus(publicRepo, 302);
    const privateRepo = await owner.session.postForm('/new', {
      name: 'SecretLib',
      description: 'unrelated catalog',
      is_private: '1'
    });
    assertStatus(privateRepo, 302);

    for (const query of ['widgetlib', 'WIDGETLIB']) {
      const search = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent(query));
      assertStatus(search, 200);
      assert.match(search.headers.get('content-type') || '', /application\/json/);
      const hits = JSON.parse(search.text);
      assert.deepEqual(hits.map((repo) => repo.name), ['WidgetLib']);
      assert.equal(hits.every((repo) => !Object.hasOwn(repo, 'password')), true);
      assert.equal(search.text.includes(owner.email), false);
    }

    const hidden = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent('secretlib'));
    assert.deepEqual(JSON.parse(hidden.text), []);

    const missing = await ctx.session().fetch('/api/users/' + uid('ghost') + '/repos');
    assertStatus(missing, 404);
    assert.match(missing.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(JSON.parse(missing.text), { error: 'Not found' });
  });
});
