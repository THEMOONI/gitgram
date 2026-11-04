const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { nid, createTestApp, listen, close, Client, basicAuth, repoPath, removeOwner } = require('./helpers');

const UPLOAD_HEADER = Buffer.from('001e# service=git-upload-pack\n0000');

describe('git smart HTTP', { concurrency: false }, () => {
  let server;
  let db;
  let ownerName;
  let strangerName;
  let repoName;
  let password;
  let owner;
  let stranger;

  before(async () => {
    const created = createTestApp();
    db = created.db;
    server = await listen(created.app);
    ownerName = nid('own');
    strangerName = nid('str');
    repoName = nid('pkg');
    password = 'secret1';
    owner = new Client(server);
    stranger = new Client(server);
    assert.equal((await owner.post('/register', { username: ownerName, email: ownerName + '@example.com', password })).status, 302);
    assert.equal((await stranger.post('/register', { username: strangerName, email: strangerName + '@example.com', password })).status, 302);
    assert.equal((await owner.post('/new', { name: repoName, description: 'protocol' })).status, 302);
  });

  after(async () => {
    removeOwner(ownerName);
    await close(server);
    db.close();
  });

  function refs(suffix, service) {
    const query = service ? '?service=' + encodeURIComponent(service) : '';
    return '/' + ownerName + '/' + repoName + suffix + '/info/refs' + query;
  }

  test('info refs rejects unknown services and missing repositories', async () => {
    const client = new Client(server);
    const missingService = await client.get(refs('', ''), { headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(missingService.status, 400);
    assert.match(missingService.text, /Invalid service/);

    const badService = await client.get(refs('', 'git-upload-archive'), { headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(badService.status, 400);
    assert.match(badService.text, /Invalid service/);

    const missingRepo = await client.get('/' + ownerName + '/does-not-exist/info/refs?service=git-upload-pack', { headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(missingRepo.status, 404);
    assert.match(missingRepo.text, /Not found/);
  });

  test('info refs advertises upload-pack and accepts a .git suffix', async () => {
    const client = new Client(server);
    const advertised = await client.get(refs('', 'git-upload-pack'), { headers: { 'Accept-Encoding': 'identity' }, raw: true });
    assert.equal(advertised.status, 200);
    assert.equal(advertised.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
    assert.equal(advertised.headers.get('cache-control'), 'no-cache');
    assert.ok(advertised.body.subarray(0, UPLOAD_HEADER.length).equals(UPLOAD_HEADER));

    const suffixed = await client.get(refs('.git', 'git-upload-pack'), { headers: { 'Accept-Encoding': 'identity' }, raw: true });
    assert.equal(suffixed.status, 200);
    assert.equal(suffixed.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
    assert.ok(suffixed.body.subarray(0, UPLOAD_HEADER.length).equals(UPLOAD_HEADER));
  });

  test('info refs reports not found when the bare repo directory is gone', async () => {
    const name = nid('gone');
    assert.equal((await owner.post('/new', { name, description: '' })).status, 302);
    fs.rmSync(repoPath(ownerName, name), { recursive: true, force: true });
    const response = await new Client(server).get('/' + ownerName + '/' + name + '/info/refs?service=git-upload-pack', {
      headers: { 'Accept-Encoding': 'identity' },
    });
    assert.equal(response.status, 404);
    assert.match(response.text, /Not found/);
  });

  test('receive-pack requires the owning account and upload-pack 404s for unknown repos', async () => {
    const fullGit = '/' + ownerName + '/' + repoName + '.git/git-receive-pack';
    const headers = { 'Accept-Encoding': 'identity' };

    const anonymous = await new Client(server).request('POST', fullGit, { headers, body: Buffer.alloc(0), raw: true });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('www-authenticate'), 'Basic realm="GITGRAM"');
    assert.match(anonymous.body.toString(), /Authentication required/);

    const bearer = await new Client(server).request('POST', fullGit, {
      headers: { ...headers, authorization: 'Bearer ' + ownerName },
      body: Buffer.alloc(0),
      raw: true,
    });
    assert.equal(bearer.status, 401);

    const badPassword = await new Client(server).request('POST', fullGit, {
      headers: { ...headers, authorization: basicAuth(ownerName, 'wrong-password') },
      body: Buffer.alloc(0),
      raw: true,
    });
    assert.equal(badPassword.status, 401);
    assert.match(badPassword.body.toString(), /Invalid credentials/);

    const emailInstead = await new Client(server).request('POST', fullGit, {
      headers: { ...headers, authorization: basicAuth(ownerName + '@example.com', password) },
      body: Buffer.alloc(0),
      raw: true,
    });
    assert.equal(emailInstead.status, 401);
    assert.match(emailInstead.body.toString(), /Invalid credentials/);

    const notOwner = await stranger.request('POST', fullGit, {
      headers: { ...headers, authorization: basicAuth(strangerName, password) },
      body: Buffer.alloc(0),
      raw: true,
    });
    assert.equal(notOwner.status, 403);
    assert.match(notOwner.body.toString(), /Permission denied/);

    const missing = await owner.request('POST', '/' + ownerName + '/missing.git/git-receive-pack', {
      headers: { ...headers, authorization: basicAuth(ownerName, password) },
      body: Buffer.alloc(0),
      raw: true,
    });
    assert.equal(missing.status, 404);
    assert.match(missing.body.toString(), /Not found/);

    const uploadMissing = await new Client(server).request('POST', '/' + ownerName + '/missing/git-upload-pack', {
      headers,
      body: Buffer.alloc(0),
      raw: true,
    });
    assert.equal(uploadMissing.status, 404);
    assert.match(uploadMissing.body.toString(), /Not found/);
  });

  test('the owner is allowed to open receive-pack', { timeout: 10000 }, async () => {
    const fullName = ownerName + '/' + repoName;
    db.prepare("UPDATE repositories SET updated_at = '2000-01-01 00:00:00' WHERE full_name = ?").run(fullName);
    const response = await owner.request('POST', '/' + ownerName + '/' + repoName + '/git-receive-pack', {
      headers: {
        'Accept-Encoding': 'identity',
        authorization: basicAuth(ownerName, password),
        'Content-Type': 'application/x-git-receive-pack-request',
      },
      body: Buffer.alloc(0),
      raw: true,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-git-receive-pack-result');

    const started = Date.now();
    let updated = db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(fullName).updated_at;
    while (updated === '2000-01-01 00:00:00') {
      if (Date.now() - started > 5000) {
        throw new Error('receive-pack did not record repository activity');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      updated = db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(fullName).updated_at;
    }
  });
});
