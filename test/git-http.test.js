const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext, registerUser, assertStatus } = require('./helpers');

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

test('info/refs rejects unknown services and missing repositories', async () => {
  await withApp(async (ctx) => {
    const invalid = await ctx.session().fetch('/someone/widgets/info/refs?service=git-evil-pack');
    assertStatus(invalid, 400);
    assert.equal(invalid.text, 'Invalid service');

    const missingService = await ctx.session().fetch('/someone/widgets/info/refs');
    assertStatus(missingService, 400);
    assert.equal(missingService.text, 'Invalid service');

    const wrongCase = await ctx.session().fetch('/someone/widgets/info/refs?service=Git-Upload-Pack');
    assertStatus(wrongCase, 400);
    assert.equal(wrongCase.text, 'Invalid service');

    const missingRepo = await ctx.session().fetch('/someone/widgets/info/refs?service=git-upload-pack');
    assertStatus(missingRepo, 404);
    assert.equal(missingRepo.text, 'Not found');
  });
});

test('info/refs advertises an existing repository, including the .git suffix', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'widgets', description: 'fetch me' });
    assertStatus(created, 302);

    const advertised = await ctx.session().fetch('/' + owner.username + '/widgets.git/info/refs?service=git-upload-pack');
    assertStatus(advertised, 200);
    assert.equal(advertised.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
    assert.equal(advertised.headers.get('cache-control'), 'no-cache');
    assert.ok(advertised.text.startsWith('001e# service=git-upload-pack\n0000'));

    const receive = await ctx.session().fetch('/' + owner.username + '/widgets.git/info/refs?service=git-receive-pack');
    assertStatus(receive, 200);
    assert.equal(receive.headers.get('content-type'), 'application/x-git-receive-pack-advertisement');
    assert.ok(receive.text.startsWith('001f# service=git-receive-pack\n0000'));

    const ownerId = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(owner.username).id;
    ctx.db.prepare('INSERT INTO repositories (name, full_name, description, owner_id, private) VALUES (?, ?, ?, ?, 0)')
      .run('ghost', owner.username + '/ghost', '', ownerId);
    const absentDir = await ctx.session().fetch('/' + owner.username + '/ghost/info/refs?service=git-upload-pack');
    assertStatus(absentDir, 404);
    assert.equal(absentDir.text, 'Not found');
  });
});

test('receive-pack requires the repository owner', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const stranger = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'widgets', description: 'push control' });
    assertStatus(created, 302);
    const fullName = owner.username + '/widgets';
    ctx.db.prepare('UPDATE repositories SET updated_at = ? WHERE full_name = ?').run('2000-01-01 00:00:00', fullName);

    const missingUpload = await ctx.session().fetch('/' + owner.username + '/missing.git/git-upload-pack', { method: 'POST' });
    assertStatus(missingUpload, 404);

    const pushPath = '/' + owner.username + '/widgets.git/git-receive-pack';
    const anonymous = await ctx.session().fetch(pushPath, { method: 'POST' });
    assertStatus(anonymous, 401);
    assert.equal(anonymous.text, 'Authentication required');
    assert.match(anonymous.headers.get('www-authenticate') || '', /Basic realm="GITGRAM"/);

    const bearer = await ctx.session().fetch(pushPath, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-password' }
    });
    assertStatus(bearer, 401);
    assert.equal(bearer.text, 'Authentication required');

    const malformed = await ctx.session().fetch(pushPath, {
      method: 'POST',
      headers: { authorization: 'Basic !!!' }
    });
    assertStatus(malformed, 401);
    assert.equal(malformed.text, 'Invalid credentials');

    const emptyPassword = await ctx.session().fetch(pushPath, {
      method: 'POST',
      headers: { authorization: basic(owner.username, '') }
    });
    assertStatus(emptyPassword, 401);
    assert.equal(emptyPassword.text, 'Invalid credentials');

    const badPassword = await ctx.session().fetch(pushPath, {
      method: 'POST',
      headers: { authorization: basic(owner.username, 'wrong-password') }
    });
    assertStatus(badPassword, 401);
    assert.equal(badPassword.text, 'Invalid credentials');

    const differentCase = owner.username.toUpperCase();
    assert.notEqual(differentCase, owner.username);
    const wrongCase = await ctx.session().fetch(pushPath, {
      method: 'POST',
      headers: { authorization: basic(differentCase, owner.password) }
    });
    assertStatus(wrongCase, 401);
    assert.equal(wrongCase.text, 'Invalid credentials');

    const unknownUser = await ctx.session().fetch(pushPath, {
      method: 'POST',
      headers: { authorization: basic('nobody' + owner.username, 'correct-horse') }
    });
    assertStatus(unknownUser, 401);
    assert.equal(unknownUser.text, 'Invalid credentials');

    const nonOwner = await ctx.session().fetch(pushPath, {
      method: 'POST',
      headers: { authorization: basic(stranger.username, stranger.password) }
    });
    assertStatus(nonOwner, 403);
    assert.equal(nonOwner.text, 'Permission denied');

    const missingPush = await ctx.session().fetch('/' + owner.username + '/missing.git/git-receive-pack', {
      method: 'POST',
      headers: { authorization: basic(owner.username, owner.password) }
    });
    assertStatus(missingPush, 404);
    assert.equal(missingPush.text, 'Not found');

    const after = ctx.db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(fullName).updated_at;
    assert.equal(after, '2000-01-01 00:00:00');

    const ownerPush = await ctx.session().fetch(pushPath, {
      method: 'POST',
      headers: { authorization: basic(owner.username, owner.password) }
    });
    assertStatus(ownerPush, 200);
    assert.equal(ownerPush.headers.get('content-type'), 'application/x-git-receive-pack-result');

    let refreshed = after;
    for (let attempt = 0; attempt < 20 && refreshed === '2000-01-01 00:00:00'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      refreshed = ctx.db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(fullName).updated_at;
    }
    assert.notEqual(refreshed, '2000-01-01 00:00:00');
  });
});

test('public git-upload-pack responds without authentication', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'widgets', description: 'clone me' });
    assertStatus(created, 302);

    const upload = await ctx.session().fetch('/' + owner.username + '/widgets.git/git-upload-pack', {
      method: 'POST',
      signal: AbortSignal.timeout(8000)
    });
    assertStatus(upload, 200);
    assert.equal(upload.headers.get('content-type'), 'application/x-git-upload-pack-result');
  });
});
