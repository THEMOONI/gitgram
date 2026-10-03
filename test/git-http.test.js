const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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

function basicAuth(username, password) {
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
}

describe('git smart HTTP', { concurrency: 1 }, () => {
  let ctx;

  before(async () => {
    ctx = await createTestContext();
  });

  after(async () => {
    await closeTestContext(ctx);
  });

  test('rejects unknown services and missing repositories before invoking git', async () => {
    const agent = new Agent(ctx.server);
    const invalid = await agent.request('GET', `/someone/missing${uniqueId()}/info/refs?service=git-daemon`);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.text, 'Invalid service');

    const missing = await agent.request('GET', `/someone/missing${uniqueId()}/info/refs?service=git-upload-pack`);
    assert.equal(missing.status, 404);
    assert.equal(missing.text, 'Not found');

    const upload = await agent.request('POST', `/someone/missing${uniqueId()}/git-upload-pack`);
    assert.equal(upload.status, 404);
    assert.equal(upload.text, 'Not found');

    const missingService = await agent.request('GET', `/someone/missing${uniqueId()}/info/refs`);
    assert.equal(missingService.status, 400);
    assert.equal(missingService.text, 'Invalid service');
  });

  test('advertises upload-pack for a .git clone URL', async () => {
    const owner = new Agent(ctx.server);
    const account = await registerUser(owner, {});
    trackRepo(ctx, account.username);
    const name = `proto${uniqueId()}`;
    const repoPath = repoPathFor(account.username, name);
    seedBareRepo(repoPath, {
      files: [{ name: 'README.md', content: 'protocol\n' }],
      message: 'protocol fixture',
      authorName: 'Proto Author',
      authorEmail: 'proto@example.com',
    });
    ctx.db.prepare('INSERT INTO repositories (name, full_name, description, owner_id, private) VALUES (?, ?, ?, ?, 0)')
      .run(name, `${account.username}/${name}`, '', ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(account.username).id);

    const response = await new Agent(ctx.server).request('GET', `/${account.username}/${name}.git/info/refs?service=git-upload-pack`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    const prefix = Buffer.from('001e# service=git-upload-pack\n0000');
    assert.ok(response.buffer.subarray(0, prefix.length).equals(prefix));
    assert.ok(response.buffer.includes(Buffer.from('refs/heads/main')));

    const receive = await new Agent(ctx.server).request('GET', `/${account.username}/${name}.git/info/refs?service=git-receive-pack`);
    assert.equal(receive.status, 200);
    assert.equal(receive.headers.get('content-type'), 'application/x-git-receive-pack-advertisement');
    const receivePrefix = Buffer.from('001f# service=git-receive-pack\n0000');
    assert.ok(receive.buffer.subarray(0, receivePrefix.length).equals(receivePrefix));

    ctx.db.prepare('INSERT INTO repositories (name, full_name, description, owner_id, private) VALUES (?, ?, ?, ?, 0)')
      .run(`ghost${name}`, `${account.username}/ghost${name}`, '', ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(account.username).id);
    const absentDir = await new Agent(ctx.server).request('GET', `/${account.username}/ghost${name}/info/refs?service=git-upload-pack`);
    assert.equal(absentDir.status, 404);
    assert.equal(absentDir.text, 'Not found');
  });

  test('requires the owner to authenticate before receive-pack', async () => {
    const ownerAgent = new Agent(ctx.server);
    const owner = await registerUser(ownerAgent, {});
    const strangerAgent = new Agent(ctx.server);
    const stranger = await registerUser(strangerAgent, {});
    const name = `push${uniqueId()}`;
    const ownerRow = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(owner.username);
    ctx.db.prepare('INSERT INTO repositories (name, full_name, description, owner_id, private, updated_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(name, `${owner.username}/${name}`, '', ownerRow.id, '2000-01-01 00:00:00');

    const anonymous = await new Agent(ctx.server).request('POST', `/${owner.username}/${name}.git/git-receive-pack`, { body: '' });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate'), /Basic realm="GITGRAM"/);
    assert.equal(anonymous.text, 'Authentication required');

    const badPassword = await new Agent(ctx.server).request('POST', `/${owner.username}/${name}/git-receive-pack`, {
      headers: basicAuth(owner.username, 'wrong-password'),
      body: '',
    });
    assert.equal(badPassword.status, 401);
    assert.equal(badPassword.text, 'Invalid credentials');

    const unknownUser = await new Agent(ctx.server).request('POST', `/${owner.username}/${name}/git-receive-pack`, {
      headers: basicAuth(`nobody${uniqueId()}`, 'correct-horse'),
      body: '',
    });
    assert.equal(unknownUser.status, 401);
    assert.equal(unknownUser.text, 'Invalid credentials');

    const bearer = await new Agent(ctx.server).request('POST', `/${owner.username}/${name}/git-receive-pack`, {
      headers: { authorization: 'Bearer not-a-password' },
      body: '',
    });
    assert.equal(bearer.status, 401);
    assert.equal(bearer.text, 'Authentication required');

    const notOwner = await new Agent(ctx.server).request('POST', `/${owner.username}/${name}/git-receive-pack`, {
      headers: basicAuth(stranger.username, stranger.password),
      body: '',
    });
    assert.equal(notOwner.status, 403);
    assert.equal(notOwner.text, 'Permission denied');

    const missing = await new Agent(ctx.server).request('POST', `/${owner.username}/no-such-${uniqueId()}/git-receive-pack`, {
      headers: basicAuth(owner.username, owner.password),
      body: '',
    });
    assert.equal(missing.status, 404);

    const untouched = ctx.db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(`${owner.username}/${name}`);
    assert.equal(untouched.updated_at, '2000-01-01 00:00:00');
  });

  test('owner receive-pack is accepted and refreshes the repository timestamp', async () => {
    const ownerAgent = new Agent(ctx.server);
    const owner = await registerUser(ownerAgent, {});
    trackRepo(ctx, owner.username);
    const name = `pushok${uniqueId()}`;
    const repoPath = repoPathFor(owner.username, name);
    seedBareRepo(repoPath, {
      files: [{ name: 'README.md', content: 'push\n' }],
      message: 'push fixture',
      authorName: 'Push Author',
      authorEmail: 'push@example.com',
    });
    const ownerId = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(owner.username).id;
    const fullName = `${owner.username}/${name}`;
    ctx.db.prepare('INSERT INTO repositories (name, full_name, description, owner_id, private, updated_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(name, fullName, '', ownerId, '2000-01-01 00:00:00');

    const response = await new Agent(ctx.server).request('POST', `/${fullName}.git/git-receive-pack`, {
      headers: basicAuth(owner.username, owner.password),
      body: '',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-git-receive-pack-result');

    let updated = null;
    // updated_at is written in the git process close handler, after the response ends.
    for (let attempt = 0; attempt < 20; attempt++) {
      updated = ctx.db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(fullName);
      if (updated.updated_at !== '2000-01-01 00:00:00') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.notEqual(updated.updated_at, '2000-01-01 00:00:00');
  });
});
