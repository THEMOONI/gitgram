const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes } = require('crypto');
const { execFileSync } = require('child_process');
const {
  createTestContext,
  registerUser,
  assertStatus,
  repoDiskPath,
  commitToBare,
  passwordHash,
  headOf
} = require('./helpers');

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

function pushBranch(repoPath, branch, files, message) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-branch-'));
  try {
    execFileSync('git', ['clone', repoPath, work], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: work, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Dev Branch'], { cwd: work, stdio: 'pipe' });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: work, stdio: 'pipe' });
    execFileSync('git', ['config', 'core.fsmonitor', 'false'], { cwd: work, stdio: 'pipe' });
    execFileSync('git', ['checkout', '-b', branch], { cwd: work, stdio: 'pipe' });
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(work, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    execFileSync('git', ['add', '-A'], { cwd: work, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', message], { cwd: work, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', branch], { cwd: work, stdio: 'pipe' });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

test('deleting one repository leaves the same owner\'s other repository intact', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const keepToken = 'keep-' + randomBytes(4).toString('hex');
    const dropToken = 'drop-' + randomBytes(4).toString('hex');
    const kept = await owner.session.postForm('/new', { name: 'kept', description: keepToken });
    const dropped = await owner.session.postForm('/new', { name: 'drop', description: dropToken });
    assertStatus(kept, 302);
    assertStatus(dropped, 302);

    const keptPath = repoDiskPath(owner.username, 'kept');
    const dropPath = repoDiskPath(owner.username, 'drop');
    commitToBare(keptPath, {
      authorName: 'Owner',
      authorEmail: 'owner@example.com',
      message: 'Keep this history',
      files: { 'kept.txt': keepToken + '\n' }
    });
    commitToBare(dropPath, {
      authorName: 'Owner',
      authorEmail: 'owner@example.com',
      message: 'Drop this history',
      files: { 'drop.txt': dropToken + '\n' }
    });
    const keptHead = headOf(keptPath);

    const removed = await owner.session.postForm('/' + owner.username + '/drop/settings/delete', {});
    assertStatus(removed, 302);
    assert.equal(removed.headers.get('location'), '/@' + owner.username);

    assert.equal(fs.existsSync(dropPath), false);
    assert.equal(fs.existsSync(keptPath), true);
    assert.equal(headOf(keptPath), keptHead);
    const rows = ctx.db.prepare('SELECT full_name, description FROM repositories WHERE owner_id = (SELECT id FROM users WHERE username = ?) ORDER BY name').all(owner.username);
    assert.deepEqual(rows, [{ full_name: owner.username + '/kept', description: keepToken }]);

    const profile = await owner.session.fetch('/@' + owner.username);
    assertStatus(profile, 200);
    assert.match(profile.text, new RegExp(keepToken));
    assert.match(profile.text, /kept/);
    assert.doesNotMatch(profile.text, new RegExp(dropToken));
    assert.doesNotMatch(profile.text, /href="\/[^"]+\/drop"/);

    const home = await ctx.session().fetch('/');
    assertStatus(home, 200);
    assert.match(home.text, new RegExp(keepToken));
    assert.doesNotMatch(home.text, new RegExp(dropToken));

    const found = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent(keepToken));
    assertStatus(found, 200);
    const foundRows = JSON.parse(found.text);
    assert.equal(foundRows.length, 1);
    assert.equal(foundRows[0].full_name, owner.username + '/kept');
    const missing = await ctx.session().fetch('/api/search/repos?q=' + encodeURIComponent(dropToken));
    assert.deepEqual(JSON.parse(missing.text), []);

    const blob = await ctx.session().fetch('/' + owner.username + '/kept/blob/main/kept.txt');
    assertStatus(blob, 200);
    assert.match(blob.text, new RegExp(keepToken));
    const gone = await ctx.session().fetch('/' + owner.username + '/drop/blob/main/drop.txt');
    assertStatus(gone, 404);
    assert.doesNotMatch(gone.text, new RegExp(dropToken));
    assert.doesNotMatch(gone.text, new RegExp(keepToken));

    const advertised = await ctx.session().fetch('/' + owner.username + '/kept.git/info/refs?service=git-upload-pack');
    assertStatus(advertised, 200);
    assert.equal(advertised.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
    assert.ok(advertised.text.startsWith('001e# service=git-upload-pack\n0000'));
    const droppedRefs = await ctx.session().fetch('/' + owner.username + '/drop.git/info/refs?service=git-upload-pack');
    assertStatus(droppedRefs, 404);
    assert.equal(droppedRefs.text, 'Not found');
  });
});

test('receive-pack refreshes only the repository that was pushed', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const pushed = await owner.session.postForm('/new', { name: 'pushed', description: 'timestamp target' });
    const sibling = await owner.session.postForm('/new', { name: 'sibling', description: 'timestamp neighbor' });
    assertStatus(pushed, 302);
    assertStatus(sibling, 302);

    const frozen = '2000-01-01 00:00:00';
    ctx.db.prepare('UPDATE repositories SET updated_at = ?').run(frozen);

    const push = await ctx.session().fetch('/' + owner.username + '/pushed.git/git-receive-pack', {
      method: 'POST',
      headers: { authorization: basic(owner.username, owner.password) }
    });
    assertStatus(push, 200);
    assert.equal(push.headers.get('content-type'), 'application/x-git-receive-pack-result');

    let pushedAt = frozen;
    for (let attempt = 0; attempt < 20 && pushedAt === frozen; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      pushedAt = ctx.db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(owner.username + '/pushed').updated_at;
    }
    const siblingAt = ctx.db.prepare('SELECT updated_at, description FROM repositories WHERE full_name = ?').get(owner.username + '/sibling');
    assert.notEqual(pushedAt, frozen);
    assert.equal(siblingAt.updated_at, frozen);
    assert.equal(siblingAt.description, 'timestamp neighbor');
  });
});

test('the default branch stays published when another branch differs', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'notes', description: 'branch view' });
    assertStatus(created, 302);
    const disk = repoDiskPath(owner.username, 'notes');
    const mainLine = 'main-line-' + randomBytes(4).toString('hex');
    const devLine = 'dev-line-' + randomBytes(4).toString('hex');
    commitToBare(disk, {
      authorName: 'Owner',
      authorEmail: 'owner@example.com',
      message: 'On main',
      files: {
        'README.md': mainLine + '\n',
        'empty.txt': ''
      }
    });
    pushBranch(disk, 'dev', { 'README.md': devLine + '\n' }, 'On dev');

    const head = execFileSync('git', ['--git-dir', disk, 'symbolic-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(head, 'refs/heads/main');

    const repoPage = await ctx.session().fetch('/' + owner.username + '/notes');
    assertStatus(repoPage, 200);
    assert.match(repoPage.text, new RegExp(mainLine));
    assert.match(repoPage.text, /On main/);
    assert.match(repoPage.text, /blob\/main\/README\.md/);
    assert.doesNotMatch(repoPage.text, new RegExp(devLine));
    assert.doesNotMatch(repoPage.text, /On dev/);
    assert.doesNotMatch(repoPage.text, /blob\/dev\//);

    const mainBlob = await ctx.session().fetch('/' + owner.username + '/notes/blob/main/README.md');
    assertStatus(mainBlob, 200);
    assert.match(mainBlob.text, new RegExp(mainLine));
    assert.doesNotMatch(mainBlob.text, new RegExp(devLine));

    const devBlob = await ctx.session().fetch('/' + owner.username + '/notes/blob/dev/README.md');
    assertStatus(devBlob, 200);
    assert.match(devBlob.text, new RegExp(devLine));
    assert.doesNotMatch(devBlob.text, new RegExp(mainLine));

    const empty = await ctx.session().fetch('/' + owner.username + '/notes/blob/main/empty.txt');
    assertStatus(empty, 200);
    assert.match(empty.text, /empty\.txt/);
    assert.match(empty.text, /1 lines/);
    assert.doesNotMatch(empty.text, /not available/);

    const missing = await ctx.session().fetch('/' + owner.username + '/notes/blob/main/missing.txt');
    assertStatus(missing, 404);
    assert.match(missing.text, /not available/);
    assert.doesNotMatch(missing.text, new RegExp(mainLine));
    assert.doesNotMatch(missing.text, new RegExp(devLine));

    const commits = await ctx.session().fetch('/' + owner.username + '/notes/commits');
    assertStatus(commits, 200);
    assert.match(commits.text, /On main/);
    assert.doesNotMatch(commits.text, /On dev/);
  });
});

test('usernames that differ only by case stay separate accounts', async () => {
  await withApp(async (ctx) => {
    const suffix = randomBytes(3).toString('hex');
    const ada = await registerUser(ctx, {
      username: 'Ada' + suffix,
      email: 'Ada.' + suffix + '@example.com',
      password: 'ada-secret-pass'
    });
    const adaHash = passwordHash(ctx, ada.username);
    const lower = await registerUser(ctx, {
      username: 'ada' + suffix,
      email: 'ada.' + suffix + '@example.com',
      password: 'lower-secret-pass'
    });
    assertStatus(ada.res, 302);
    assertStatus(lower.res, 302);
    assert.equal(passwordHash(ctx, ada.username), adaHash);
    assert.notEqual(passwordHash(ctx, lower.username), adaHash);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);

    const adaSecret = 'ada-only-' + suffix;
    const lowerSecret = 'lower-only-' + suffix;
    const adaRepo = await ada.session.postForm('/new', { name: 'vault', description: adaSecret, is_private: '1' });
    const lowerRepo = await lower.session.postForm('/new', { name: 'vault', description: lowerSecret, is_private: '1' });
    assertStatus(adaRepo, 302);
    assertStatus(lowerRepo, 302);

    const adaProfile = await ada.session.fetch('/@' + ada.username);
    assertStatus(adaProfile, 200);
    assert.match(adaProfile.text, new RegExp(adaSecret));
    assert.doesNotMatch(adaProfile.text, new RegExp(lowerSecret));

    const lowerOnAda = await lower.session.fetch('/@' + ada.username);
    assertStatus(lowerOnAda, 200);
    assert.doesNotMatch(lowerOnAda.text, new RegExp(adaSecret));
    assert.doesNotMatch(lowerOnAda.text, /badge-private/);

    const ownApi = await ada.session.fetch('/api/users/' + ada.username + '/repos');
    assertStatus(ownApi, 200);
    const ownRows = JSON.parse(ownApi.text);
    assert.equal(ownRows.length, 1);
    assert.equal(ownRows[0].description, adaSecret);
    assert.equal(Object.hasOwn(ownRows[0], 'password'), false);
    assert.equal(JSON.stringify(ownRows).includes(lowerSecret), false);

    const strangerApi = await lower.session.fetch('/api/users/' + ada.username + '/repos');
    assert.deepEqual(JSON.parse(strangerApi.text), []);
    const anonApi = await ctx.session().fetch('/api/users/' + ada.username + '/repos');
    assert.deepEqual(JSON.parse(anonApi.text), []);

    const anonLower = await ctx.session().fetch('/api/users/' + lower.username + '/repos');
    assert.deepEqual(JSON.parse(anonLower.text), []);

    const home = await ctx.session().fetch('/');
    assert.doesNotMatch(home.text, new RegExp(adaSecret));
    assert.doesNotMatch(home.text, new RegExp(lowerSecret));
  });
});
