const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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

test('repository names are trimmed and uniqueness is per owner', async () => {
  await withApp(async (ctx) => {
    const anonForm = await ctx.session().fetch('/new');
    assertStatus(anonForm, 302);
    assert.equal(anonForm.headers.get('location'), '/login');

    const first = await registerUser(ctx);
    const second = await registerUser(ctx);
    const form = await first.session.fetch('/new');
    assertStatus(form, 200);
    assert.match(form.text, /Create a new repository/);

    const trimmed = await first.session.postForm('/new', { name: '  Widget_1  ', description: 'trimmed name' });
    assertStatus(trimmed, 302);
    assert.equal(trimmed.headers.get('location'), '/' + first.username + '/Widget_1');
    assert.equal(fs.existsSync(repoDiskPath(first.username, 'Widget_1')), true);
    assert.equal(fs.existsSync(repoDiskPath(first.username, '  Widget_1  ')), false);

    const sameAfterTrim = await first.session.postForm('/new', { name: 'Widget_1', description: 'again' });
    assertStatus(sameAfterTrim, 200);
    assert.match(sameAfterTrim.text, /Repo already exists/);

    const otherOwner = await second.session.postForm('/new', { name: 'Widget_1', description: 'same short name' });
    assertStatus(otherOwner, 302);
    assert.equal(otherOwner.headers.get('location'), '/' + second.username + '/Widget_1');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories WHERE name = ?').get('Widget_1').n, 2);
  });
});

test('a new bare repository uses main and enables smart HTTP', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'seed', description: '' });
    assertStatus(created, 302);
    const disk = repoDiskPath(owner.username, 'seed');
    const head = execFileSync('git', ['--git-dir', disk, 'symbolic-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    const receive = execFileSync('git', ['--git-dir', disk, 'config', '--get', 'http.receivepack'], { encoding: 'utf8' }).trim();
    const upload = execFileSync('git', ['--git-dir', disk, 'config', '--get', 'http.uploadpack'], { encoding: 'utf8' }).trim();
    assert.equal(head, 'refs/heads/main');
    assert.equal(receive, 'true');
    assert.equal(upload, 'true');

    const row = ctx.db.prepare('SELECT default_branch, description, private FROM repositories WHERE name = ?').get('seed');
    assert.equal(row.default_branch, 'main');
    assert.equal(row.description, '');
    assert.equal(row.private, 0);
  });
});

test('private file, commit, and settings URLs stay hidden from other users', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const stranger = await registerUser(ctx);
    const secret = 'classified-' + uid('blob');
    const created = await owner.session.postForm('/new', {
      name: 'vault',
      description: secret,
      is_private: '1'
    });
    assertStatus(created, 302);
    const fullName = owner.username + '/vault';
    const disk = repoDiskPath(owner.username, 'vault');
    commitToBare(disk, {
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      message: 'Store the secret',
      files: { 'readme.txt': secret + '\nline two' }
    });

    const paths = [
      '/' + fullName + '/blob/main/readme.txt',
      '/' + fullName + '/commits',
      '/' + fullName + '/settings'
    ];
    for (const session of [stranger.session, ctx.session()]) {
      for (const urlPath of paths) {
        const hidden = await session.fetch(urlPath);
        assertStatus(hidden, 404);
        assert.doesNotMatch(hidden.text, new RegExp(secret));
        assert.doesNotMatch(hidden.text, /Danger Zone/);
        assert.doesNotMatch(hidden.text, /Store the secret/);
      }
      const deniedDelete = await session.postForm('/' + fullName + '/settings/delete', {});
      assertStatus(deniedDelete, 404);
    }
    assert.equal(fs.existsSync(disk), true);
    assert.equal(ctx.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName) != null, true);

    const ownerFile = await owner.session.fetch('/' + fullName + '/blob/main/readme.txt');
    assertStatus(ownerFile, 200);
    assert.match(ownerFile.text, new RegExp(secret));
    assert.match(ownerFile.text, /readme\.txt/);

    const ownerPage = await owner.session.fetch('/' + fullName);
    assertStatus(ownerPage, 200);
    assert.match(ownerPage.text, new RegExp(secret));
    assert.match(ownerPage.text, /readme\.txt/);

    const removed = await owner.session.postForm('/' + fullName + '/settings/delete', {});
    assertStatus(removed, 302);
    assert.equal(fs.existsSync(disk), false);
    const gone = await owner.session.fetch('/' + fullName);
    assertStatus(gone, 404);
  });
});

test('missing profiles and repositories return 404, and public text is escaped', async () => {
  await withApp(async (ctx) => {
    const missingProfile = await ctx.session().fetch('/@' + uid('nobody'));
    assertStatus(missingProfile, 404);
    assert.match(missingProfile.text, /Not Found/);

    const owner = await registerUser(ctx);
    const missingRepo = await ctx.session().fetch('/' + owner.username + '/does-not-exist');
    assertStatus(missingRepo, 404);

    const description = '<img src=x onerror=alert(1)>';
    const created = await owner.session.postForm('/new', { name: 'public-notes', description });
    assertStatus(created, 302);

    const home = await ctx.session().fetch('/');
    assert.match(home.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(home.text, /<img src=x onerror=alert\(1\)>/);

    const repoPage = await ctx.session().fetch('/' + owner.username + '/public-notes');
    assertStatus(repoPage, 200);
    assert.match(repoPage.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(repoPage.text, /<img src=x onerror=alert\(1\)>/);
    assert.match(repoPage.text, /This repository is empty/);
    assert.doesNotMatch(repoPage.text, /Settings/);

    const profile = await ctx.session().fetch('/@' + owner.username);
    assert.match(profile.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(profile.text, /<img src=x onerror=alert\(1\)>/);
  });
});
