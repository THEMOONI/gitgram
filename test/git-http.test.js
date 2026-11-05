const { before, after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  unique,
  createTestContext,
  listen,
  close,
  cleanupUsers,
  Session,
  basic,
} = require('./support');

describe('git smart HTTP', () => {
  let db;
  let server;
  let port;
  let users;

  before(async () => {
    ({ db, server, users } = createTestContext());
    port = await listen(server);
  });

  after(async () => {
    cleanupUsers(users);
    await close(server);
    db.close();
  });

  async function register(username) {
    users.add(username);
    const session = new Session(port);
    const response = await session.form('POST', '/register', {
      username,
      email: `${username}@example.com`,
      password: 'secret1',
    });
    assert.equal(response.status, 302);
    return session;
  }

  test('rejects unknown services and missing repositories before invoking git', async () => {
    const badService = await new Session(port).request('GET', '/nobody/missing/info/refs?service=git-evil');
    assert.equal(badService.status, 400);
    assert.equal(badService.body, 'Invalid service');

    const missingService = await new Session(port).request('GET', '/nobody/missing/info/refs');
    assert.equal(missingService.status, 400);

    const missingRepo = await new Session(port).request('GET', '/nobody/missing.git/info/refs?service=git-upload-pack');
    assert.equal(missingRepo.status, 404);
    assert.equal(missingRepo.body, 'Not found');

    const missingUpload = await new Session(port).request('POST', '/nobody/missing/git-upload-pack');
    assert.equal(missingUpload.status, 404);
  });

  test('advertises a repository with or without the .git suffix', async () => {
    const ownerName = unique('pusher');
    const owner = await register(ownerName);
    const repoName = unique('wire');
    assert.equal((await owner.form('POST', '/new', { name: repoName })).status, 302);

    const advertised = await new Session(port).request('GET', `/${ownerName}/${repoName}.git/info/refs?service=git-upload-pack`);
    assert.equal(advertised.status, 200);
    assert.equal(advertised.headers['content-type'], 'application/x-git-upload-pack-advertisement');
    assert.equal(advertised.headers['cache-control'], 'no-cache');
    assert.match(advertised.body, /# service=git-upload-pack/);

    const receiveAdvertisement = await new Session(port).request('GET', `/${ownerName}/${repoName}/info/refs?service=git-receive-pack`);
    assert.equal(receiveAdvertisement.status, 200);
    assert.equal(receiveAdvertisement.headers['content-type'], 'application/x-git-receive-pack-advertisement');
    assert.match(receiveAdvertisement.body, /# service=git-receive-pack/);
  });

  test('receive-pack requires the repository owner', async () => {
    const ownerName = unique('writer');
    const otherName = unique('reader');
    await register(ownerName);
    await register(otherName);
    const repoName = unique('locked');
    const owner = new Session(port);
    await owner.form('POST', '/login', { username: ownerName, password: 'secret1' });
    assert.equal((await owner.form('POST', '/new', { name: repoName, is_private: '1' })).status, 302);

    const target = `/${ownerName}/${repoName}.git/git-receive-pack`;
    const anonymous = await new Session(port).request('POST', target);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers['www-authenticate'], /Basic realm="GITGRAM"/);
    assert.equal(anonymous.body, 'Authentication required');

    const badPassword = await new Session(port).request('POST', target, {
      headers: { authorization: basic(ownerName, 'wrong-password') },
    });
    assert.equal(badPassword.status, 401);
    assert.equal(badPassword.body, 'Invalid credentials');

    const stranger = await new Session(port).request('POST', target, {
      headers: { authorization: basic(otherName, 'secret1') },
    });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body, 'Permission denied');

    const unknown = await new Session(port).request('POST', `/${ownerName}/does-not-exist.git/git-receive-pack`, {
      headers: { authorization: basic(ownerName, 'secret1') },
    });
    assert.equal(unknown.status, 404);

    const allowed = await new Session(port).request('POST', target, {
      headers: {
        authorization: basic(ownerName, 'secret1'),
        'content-type': 'application/x-git-receive-pack-request',
      },
      body: '',
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers['content-type'], 'application/x-git-receive-pack-result');
    assert.notEqual(allowed.body, 'Permission denied');
  });
});
