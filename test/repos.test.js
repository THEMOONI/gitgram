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

test('repository creation requires a signed-in user and a unique trimmed name', async () => {
  await withApp(async (ctx) => {
    const anon = ctx.session();
    const blockedGet = await anon.fetch('/new');
    assertStatus(blockedGet, 302);
    assert.equal(blockedGet.headers.get('location'), '/login');

    const blocked = await anon.postForm('/new', { name: 'widgets', description: 'demo' });
    assertStatus(blocked, 302);
    assert.equal(blocked.headers.get('location'), '/login');

    const owner = await registerUser(ctx);
    const form = await owner.session.fetch('/new');
    assertStatus(form, 200);
    assert.match(form.text, /Create a new repository/);

    const blank = await owner.session.postForm('/new', { name: '   ', description: 'demo' });
    assertStatus(blank, 200);
    assert.match(blank.text, /Name required/);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n, 0);
    assert.equal(fs.existsSync(repoDiskPath(owner.username, '   ')), false);

    const created = await owner.session.postForm('/new', { name: '  widgets  ', description: 'A public widget library' });
    assertStatus(created, 302);
    assert.equal(created.headers.get('location'), '/' + owner.username + '/widgets');
    assert.equal(fs.existsSync(repoDiskPath(owner.username, 'widgets')), true);

    const duplicate = await owner.session.postForm('/new', { name: 'widgets', description: 'again' });
    assertStatus(duplicate, 200);
    assert.match(duplicate.text, /Repo already exists/);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n, 1);

    const row = ctx.db.prepare('SELECT private, description, name FROM repositories WHERE full_name = ?').get(owner.username + '/widgets');
    assert.equal(row.private, 0);
    assert.equal(row.description, 'A public widget library');
    assert.equal(row.name, 'widgets');

    const other = await registerUser(ctx);
    const shared = await other.session.postForm('/new', { name: 'widgets', description: '' });
    assertStatus(shared, 302);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories WHERE name = ?').get('widgets').n, 2);
  });
});

test('a new bare repository uses main and enables smart HTTP', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'seed' });
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

test('only the owner can delete, and another owner keeps the same repo name', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const stranger = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'doomed', description: 'keep until owner deletes' });
    assertStatus(created, 302);
    const shared = await stranger.session.postForm('/new', { name: 'doomed', description: 'leave this one' });
    assertStatus(shared, 302);

    const fullName = owner.username + '/doomed';
    const disk = repoDiskPath(owner.username, 'doomed');
    const strangerDisk = repoDiskPath(stranger.username, 'doomed');

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
    assert.match(ownerSettings.text, new RegExp('action="/' + owner.username + '/doomed/settings/delete"'));

    const removed = await owner.session.postForm('/' + fullName + '/settings/delete', {});
    assertStatus(removed, 302);
    assert.equal(removed.headers.get('location'), '/@' + owner.username);
    assert.equal(fs.existsSync(disk), false);
    assert.equal(ctx.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName), undefined);
    assert.equal(fs.existsSync(strangerDisk), true);
    assert.equal(ctx.db.prepare('SELECT description FROM repositories WHERE full_name = ?').get(stranger.username + '/doomed').description, 'leave this one');
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

    const ownerFile = await owner.session.fetch('/' + fullName + '/blob/main/readme.txt');
    assertStatus(ownerFile, 200);
    assert.match(ownerFile.text, new RegExp(secret));
    assert.match(ownerFile.text, /readme\.txt/);

    const removed = await owner.session.postForm('/' + fullName + '/settings/delete', {});
    assertStatus(removed, 302);
    assert.equal(fs.existsSync(disk), false);
    const gone = await owner.session.fetch('/' + fullName);
    assertStatus(gone, 404);
  });
});

test('repo pages escape untrusted text and reject missing objects', async () => {
  await withApp(async (ctx) => {
    const missingProfile = await ctx.session().fetch('/@' + uid('nobody'));
    assertStatus(missingProfile, 404);
    assert.match(missingProfile.text, /Not Found/);

    const owner = await registerUser(ctx);
    const missingRepo = await ctx.session().fetch('/' + owner.username + '/does-not-exist');
    assertStatus(missingRepo, 404);

    const description = '<img src=x onerror=alert(1)>';
    const created = await owner.session.postForm('/new', { name: 'notes', description });
    assertStatus(created, 302);

    const home = await ctx.session().fetch('/');
    assert.match(home.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(home.text, /<img src=x onerror=alert\(1\)>/);

    const emptyCommits = await owner.session.fetch('/' + owner.username + '/notes/commits');
    assertStatus(emptyCommits, 200);
    assert.match(emptyCommits.text, /No commits yet/);

    const emptyRepo = await ctx.session().fetch('/' + owner.username + '/notes');
    assert.match(emptyRepo.text, /This repository is empty/);
    assert.match(emptyRepo.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(emptyRepo.text, /<img src=x onerror=alert\(1\)>/);
    assert.doesNotMatch(emptyRepo.text, /Settings/);

    const profile = await ctx.session().fetch('/@' + owner.username);
    assert.match(profile.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(profile.text, /<img src=x onerror=alert\(1\)>/);

    const hiddenEmail = 'ada-hidden-' + uid('mail') + '@example.com';
    const head = commitToBare(repoDiskPath(owner.username, 'notes'), {
      authorName: 'Ada & Lovelace',
      authorEmail: hiddenEmail,
      revisions: [
        {
          message: 'Add README',
          files: {
            'README.md': 'first\n',
            'docs/guide.txt': 'nested\n'
          }
        },
        {
          message: 'Ship <script>alert(1)</script>',
          files: {
            'README.md': '<script>alert(1)</script>\nsecond line updated',
            'hello<script>.txt': 'safe text'
          }
        }
      ]
    });
    const shortHash = head.slice(0, 7);

    const repoPage = await owner.session.fetch('/' + owner.username + '/notes');
    assertStatus(repoPage, 200);
    const newerAt = repoPage.text.indexOf('Ship &lt;script&gt;alert(1)&lt;/script&gt;');
    const olderAt = repoPage.text.indexOf('Add README');
    assert.ok(newerAt >= 0 && olderAt > newerAt);
    assert.match(repoPage.text, new RegExp(shortHash));
    assert.doesNotMatch(repoPage.text, new RegExp(head));
    assert.match(repoPage.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(repoPage.text, /<script>alert\(1\)<\/script>/);
    assert.match(repoPage.text, /file-name">hello&lt;script&gt;\.txt<\/a>/);
    assert.match(repoPage.text, /<span><\/span><a href="[^"]+\/docs" class="file-name">docs<\/a>/);

    const filePage = await owner.session.fetch('/' + owner.username + '/notes/blob/main/README.md');
    assertStatus(filePage, 200);
    assert.match(filePage.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(filePage.text, /second line updated/);
    assert.match(filePage.text, /2 lines/);
    assert.doesNotMatch(filePage.text, /<script>alert\(1\)<\/script>/);

    const namedFile = await owner.session.fetch('/' + owner.username + '/notes/blob/main/' + encodeURIComponent('hello<script>.txt'));
    assertStatus(namedFile, 200);
    assert.match(namedFile.text, /hello&lt;script&gt;\.txt/);
    assert.match(namedFile.text, /safe text/);
    assert.doesNotMatch(namedFile.text, /hello<script>\.txt/);

    const missing = await owner.session.fetch('/' + owner.username + '/notes/blob/main/missing.txt');
    assertStatus(missing, 404);

    const directory = await owner.session.fetch('/' + owner.username + '/notes/blob/main/docs');
    assertStatus(directory, 200);
    assert.match(directory.text, /guide\.txt/);
    assert.doesNotMatch(directory.text, /nested/);

    const commitsPage = await owner.session.fetch('/' + owner.username + '/notes/commits');
    assert.match(commitsPage.text, /Ship &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(commitsPage.text, /Ada &amp; Lovelace/);
    assert.match(commitsPage.text, new RegExp(shortHash));
    assert.doesNotMatch(commitsPage.text, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(commitsPage.text, /Ada & Lovelace/);
    assert.doesNotMatch(commitsPage.text, new RegExp(hiddenEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(commitsPage.text, /Invalid date/);
    const commitsNewer = commitsPage.text.indexOf('Ship &lt;script&gt;');
    const commitsOlder = commitsPage.text.indexOf('Add README');
    assert.ok(commitsNewer >= 0 && commitsOlder > commitsNewer);
  });
});

test('repository names are escaped on the empty repository page', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const name = 'lib<img>';
    const created = await owner.session.postForm('/new', { name, description: 'markup' });
    assertStatus(created, 302);
    assert.equal(created.headers.get('location'), '/' + owner.username + '/' + encodeURIComponent(name));
    assert.equal(ctx.db.prepare('SELECT name FROM repositories WHERE full_name = ?').get(owner.username + '/' + name).name, name);
    assert.equal(fs.existsSync(repoDiskPath(owner.username, name)), true);

    const page = await ctx.session().fetch('/' + owner.username + '/' + encodeURIComponent(name));
    assertStatus(page, 200);
    assert.match(page.text, /lib&lt;img&gt;/);
    assert.match(page.text, /echo "# lib&lt;img&gt;"/);
    assert.doesNotMatch(page.text, /<img>/);
    assert.doesNotMatch(page.text, /lib<img>/);
  });
});

test('profile creation controls are shown only to the owner', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const stranger = await registerUser(ctx);

    const ownerProfile = await owner.session.fetch('/@' + owner.username);
    assertStatus(ownerProfile, 200);
    assert.match(ownerProfile.text, /No repositories yet/);
    assert.match(ownerProfile.text, /\+ New Repository/);
    assert.match(ownerProfile.text, /Create your first repository/);

    const strangerView = await stranger.session.fetch('/@' + owner.username);
    assertStatus(strangerView, 200);
    assert.match(strangerView.text, /No repositories yet/);
    assert.doesNotMatch(strangerView.text, /\+ New Repository/);
    assert.doesNotMatch(strangerView.text, /Create your first repository/);

    const anonView = await ctx.session().fetch('/@' + owner.username);
    assertStatus(anonView, 200);
    assert.doesNotMatch(anonView.text, /\+ New Repository/);
    assert.doesNotMatch(anonView.text, /Create your first repository/);
    assert.doesNotMatch(anonView.text, /href="\/new"/);
  });
});
