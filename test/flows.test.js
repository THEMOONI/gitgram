const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { createTestContext, registerUser, assertStatus, repoDiskPath, commitToBare, uid } = require('./helpers');

async function withApp(fn) {
  const ctx = await createTestContext();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function gitOptions(cwd, timeout) {
  const options = {
    encoding: 'utf8',
    timeout,
    stdio: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  };
  if (cwd) options.cwd = cwd;
  return options;
}

function runGitSync(args, cwd) {
  return execFileSync('git', args, gitOptions(cwd, 20000));
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, gitOptions(cwd, 15000), (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function prepareWork(files, message) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-push-'));
  runGitSync(['init', '-b', 'main'], work);
  runGitSync(['config', 'user.email', 'grace@example.com'], work);
  runGitSync(['config', 'user.name', 'Grace Hopper'], work);
  runGitSync(['config', 'commit.gpgsign', 'false'], work);
  runGitSync(['config', 'core.fsmonitor', 'false'], work);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(work, name), content);
  }
  runGitSync(['add', '-A'], work);
  runGitSync(['commit', '-m', message], work);
  return work;
}

function remoteUrl(baseUrl, username, password, owner, repo) {
  const withAuth = baseUrl.replace('http://', 'http://' + encodeURIComponent(username) + ':' + encodeURIComponent(password) + '@');
  return withAuth + '/' + owner + '/' + repo + '.git';
}

function basic(username, password) {
  return 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
}

test('anonymous repository creation stores nothing', async () => {
  await withApp(async (ctx) => {
    const anon = ctx.session();
    const blocked = await anon.postForm('/new', { name: 'sneaky', description: 'should not exist' });
    assertStatus(blocked, 302);
    assert.equal(blocked.headers.get('location'), '/login');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);

    const stillOut = await anon.fetch('/new');
    assertStatus(stillOut, 302);
    assert.equal(stillOut.headers.get('location'), '/login');
  });
});

test('anonymous visitors cannot open repository settings', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'public-notes', description: 'visible' });
    assertStatus(created, 302);
    const fullName = owner.username + '/public-notes';

    const anonSettings = await ctx.session().fetch('/' + fullName + '/settings');
    assertStatus(anonSettings, 403);
    assert.match(anonSettings.text, /Access Denied/);
    assert.doesNotMatch(anonSettings.text, /Danger Zone/);
    assert.doesNotMatch(anonSettings.text, /settings\/delete/);

    const ownerSettings = await owner.session.fetch('/' + fullName + '/settings');
    assertStatus(ownerSettings, 200);
    assert.match(ownerSettings.text, /Danger Zone/);
  });
});

test('a second delete is not found and the repository stays gone', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'once', description: 'delete twice' });
    assertStatus(created, 302);
    const fullName = owner.username + '/once';
    const disk = repoDiskPath(owner.username, 'once');

    const removed = await owner.session.postForm('/' + fullName + '/settings/delete', {});
    assertStatus(removed, 302);
    assert.equal(fs.existsSync(disk), false);

    const again = await owner.session.postForm('/' + fullName + '/settings/delete', {});
    assertStatus(again, 404);
    assert.doesNotMatch(again.text, /Danger Zone/);
    assert.equal(ctx.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName), undefined);
    assert.equal(fs.existsSync(disk), false);
  });
});

test('deleting one repository leaves the other owner git access intact', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const other = await registerUser(ctx);
    const first = await owner.session.postForm('/new', { name: 'shared', description: 'goes away' });
    assertStatus(first, 302);
    const second = await other.session.postForm('/new', { name: 'shared', description: 'stays available' });
    assertStatus(second, 302);

    const removed = await owner.session.postForm('/' + owner.username + '/shared/settings/delete', {});
    assertStatus(removed, 302);

    const gone = await ctx.session().fetch('/' + owner.username + '/shared.git/info/refs?service=git-upload-pack');
    assertStatus(gone, 404);
    assert.equal(gone.text, 'Not found');

    const stillThere = await ctx.session().fetch('/' + other.username + '/shared.git/info/refs?service=git-upload-pack');
    assertStatus(stillThere, 200);
    assert.equal(stillThere.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
    assert.ok(stillThere.text.startsWith('001e# service=git-upload-pack\n0000'));
    assert.equal(fs.existsSync(repoDiskPath(other.username, 'shared')), true);
  });
});

test('the homepage hides private repositories from their owner and orders across owners', async () => {
  await withApp(async (ctx) => {
    const first = await registerUser(ctx);
    const second = await registerUser(ctx);
    const secret = 'owner-home-secret-' + uid('note');

    const older = await first.session.postForm('/new', { name: 'old-lib', description: 'older public catalog' });
    assertStatus(older, 302);
    const hidden = await first.session.postForm('/new', {
      name: 'secret-lib',
      description: secret,
      is_private: '1'
    });
    assertStatus(hidden, 302);
    const newer = await second.session.postForm('/new', { name: 'new-lib', description: 'newer public catalog' });
    assertStatus(newer, 302);

    ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE full_name = ?').run('2020-01-01 00:00:00', first.username + '/old-lib');
    ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE full_name = ?').run('2030-01-01 00:00:00', first.username + '/secret-lib');
    ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE full_name = ?').run('2024-06-01 00:00:00', second.username + '/new-lib');

    const home = await first.session.fetch('/');
    assertStatus(home, 200);
    assert.match(home.text, /newer public catalog/);
    assert.match(home.text, /older public catalog/);
    const newerAt = home.text.indexOf('new-lib');
    const olderAt = home.text.indexOf('old-lib');
    assert.ok(newerAt >= 0 && olderAt > newerAt);
    assert.equal(home.text.includes('secret-lib'), false);
    assert.equal(home.text.includes(secret), false);
  });
});

test('search matches repository names and descriptions only', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'catalog', description: 'widget catalog' });
    assertStatus(created, 302);

    const byUser = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent(owner.username));
    assertStatus(byUser, 200);
    assert.deepEqual(JSON.parse(byUser.text), []);

    const byEmail = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent(owner.email));
    assertStatus(byEmail, 200);
    assert.deepEqual(JSON.parse(byEmail.text), []);
    assert.equal(byEmail.text.includes(owner.email), false);

    const byDescription = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent('widget catalog'));
    assert.deepEqual(JSON.parse(byDescription.text).map((repo) => repo.name), ['catalog']);
  });
});

test('logout hides a private repository from the same browser', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const secret = 'logout-secret-' + uid('blob');
    const created = await owner.session.postForm('/new', {
      name: 'vault',
      description: secret,
      is_private: '1'
    });
    assertStatus(created, 302);
    const fullName = owner.username + '/vault';
    commitToBare(repoDiskPath(owner.username, 'vault'), {
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      message: 'Store the note',
      files: { 'readme.txt': secret + '\n' }
    });

    const before = await owner.session.fetch('/' + fullName);
    assertStatus(before, 200);
    assert.match(before.text, new RegExp(secret));

    const loggedOut = await owner.session.fetch('/logout');
    assertStatus(loggedOut, 302);

    for (const urlPath of ['/' + fullName, '/' + fullName + '/blob/main/readme.txt', '/' + fullName + '/commits']) {
      const hidden = await owner.session.fetch(urlPath);
      assertStatus(hidden, 404);
      assert.doesNotMatch(hidden.text, new RegExp(secret));
      assert.doesNotMatch(hidden.text, /Store the note/);
    }
  });
});

test('the clone URL uses PUBLIC_URL when it is configured', async () => {
  await withApp(async (ctx) => {
    const previous = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = 'https://git.example.com';
    try {
      const owner = await registerUser(ctx);
      const created = await owner.session.postForm('/new', { name: 'widgets', description: 'clone target' });
      assertStatus(created, 302);
      const page = await ctx.session().fetch('/' + owner.username + '/widgets');
      assertStatus(page, 200);
      assert.match(page.text, new RegExp('https://git\\.example\\.com/' + owner.username + '/widgets\\.git'));
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = previous;
    }
  });
});

test('a browser session cannot push, and upload-pack does not refresh the repository', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const stranger = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'widgets', description: 'push control' });
    assertStatus(created, 302);
    const fullName = owner.username + '/widgets';
    const pushPath = '/' + owner.username + '/widgets.git/git-receive-pack';
    ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE full_name = ?').run('2000-01-01 00:00:00', fullName);

    const ownerSession = await owner.session.fetch(pushPath, { method: 'POST' });
    assertStatus(ownerSession, 401);
    assert.equal(ownerSession.text, 'Authentication required');
    assert.match(ownerSession.headers.get('www-authenticate') || '', /Basic realm="GITGRAM"/);

    const strangerSession = await stranger.session.fetch(pushPath, { method: 'POST' });
    assertStatus(strangerSession, 401);
    assert.equal(strangerSession.text, 'Authentication required');

    const upload = await ctx.session().fetch('/' + owner.username + '/widgets.git/git-upload-pack', {
      method: 'POST',
      signal: AbortSignal.timeout(8000)
    });
    assertStatus(upload, 200);
    assert.equal(upload.headers.get('content-type'), 'application/x-git-upload-pack-result');
    assert.equal(ctx.db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(fullName).updated_at, '2000-01-01 00:00:00');
  });
});

test('the owner can push over smart HTTP and a stranger force-push is rejected', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const stranger = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'notes', description: 'pushed notes' });
    assertStatus(created, 302);

    const disk = repoDiskPath(owner.username, 'notes');
    runGitSync(['--git-dir', disk, 'config', 'core.fsmonitor', 'false']);
    const fullName = owner.username + '/notes';
    const marker = 'owner-file-' + uid('blob');
    const takeover = 'taken-over-' + uid('blob');
    const ownerWork = prepareWork({ 'README.md': marker + '\n' }, 'Publish the note');
    const strangerWork = prepareWork({ 'README.md': takeover + '\n' }, 'Replace the note');

    try {
      ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE full_name = ?').run('2000-01-01 00:00:00', fullName);
      await runGit([
        '-c', 'credential.helper=',
        '-c', 'core.fsmonitor=false',
        'push', remoteUrl(ctx.baseUrl, owner.username, owner.password, owner.username, 'notes'), 'HEAD:main'
      ], ownerWork);

      const head = runGitSync(['--git-dir', disk, 'rev-parse', 'HEAD']).trim();
      const listed = await runGit(['-c', 'credential.helper=', 'ls-remote', ctx.baseUrl + '/' + fullName + '.git']);
      assert.match(listed, new RegExp(head + '\\s+HEAD'));
      assert.match(listed, new RegExp(head + '\\s+refs/heads/main'));

      let refreshed = '2000-01-01 00:00:00';
      for (let attempt = 0; attempt < 20 && refreshed === '2000-01-01 00:00:00'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        refreshed = ctx.db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(fullName).updated_at;
      }
      assert.notEqual(refreshed, '2000-01-01 00:00:00');

      const page = await ctx.session().fetch('/' + fullName);
      assertStatus(page, 200);
      assert.match(page.text, new RegExp(marker));
      assert.match(page.text, /Publish the note/);
      const blob = await ctx.session().fetch('/' + fullName + '/blob/main/README.md');
      assertStatus(blob, 200);
      assert.match(blob.text, new RegExp(marker));

      ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE full_name = ?').run('2000-01-01 00:00:00', fullName);
      await assert.rejects(() => runGit([
        '-c', 'credential.helper=',
        '-c', 'core.fsmonitor=false',
        'push', '--force', remoteUrl(ctx.baseUrl, stranger.username, stranger.password, owner.username, 'notes'), 'HEAD:main'
      ], strangerWork));
      assert.equal(ctx.db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(fullName).updated_at, '2000-01-01 00:00:00');

      const after = await ctx.session().fetch('/' + fullName + '/blob/main/README.md');
      assertStatus(after, 200);
      assert.match(after.text, new RegExp(marker));
      assert.doesNotMatch(after.text, new RegExp(takeover));
      assert.equal(runGitSync(['--git-dir', disk, 'rev-parse', 'HEAD']).trim(), head);

      await assert.rejects(() => runGit(['ls-remote', ctx.baseUrl + '/' + owner.username + '/missing.git']));
    } finally {
      fs.rmSync(ownerWork, { recursive: true, force: true });
      fs.rmSync(strangerWork, { recursive: true, force: true });
    }
  });
});

test('basic auth still rejects a signed-in stranger before any timestamp change', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const stranger = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'widgets', description: 'owned' });
    assertStatus(created, 302);
    const fullName = owner.username + '/widgets';
    ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE full_name = ?').run('2000-01-01 00:00:00', fullName);

    const denied = await stranger.session.fetch('/' + owner.username + '/widgets.git/git-receive-pack', {
      method: 'POST',
      headers: { authorization: basic(stranger.username, stranger.password) }
    });
    assertStatus(denied, 403);
    assert.equal(denied.text, 'Permission denied');
    assert.equal(ctx.db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(fullName).updated_at, '2000-01-01 00:00:00');
  });
});
