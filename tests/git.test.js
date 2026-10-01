const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp, login, form, basic, unique } = require('./helpers');

const UPLOAD_ADVERTISEMENT = '001e# service=git-upload-pack\n0000';

describe('git smart HTTP', () => {
  it('rejects unknown services before looking up a repository', async () => {
    await withApp(async (api) => {
      const missing = await api.request({ path: '/owner/demo/info/refs' });
      assert.equal(missing.status, 400);
      assert.equal(missing.body, 'Invalid service');

      const injected = await api.request({
        path: '/owner/demo/info/refs?service=' + encodeURIComponent('git-upload-pack;id')
      });
      assert.equal(injected.status, 400);
      assert.equal(injected.body, 'Invalid service');

      const wrongCase = await api.request({ path: '/owner/demo/info/refs?service=Git-Upload-Pack' });
      assert.equal(wrongCase.status, 400);
    });
  });

  it('advertises refs for an existing bare repo, including the .git suffix', async () => {
    await withApp(async (api) => {
      const owner = api.seedUser(unique('owner'));
      const jar = await login(api, owner);
      const created = await api.request({
        method: 'POST',
        path: '/new',
        body: form({ name: 'notes' }),
        jar
      });
      assert.equal(created.status, 302);

      api.seedRepo(owner, 'ghost');
      const absent = await api.request({ path: '/' + owner.username + '/ghost/info/refs?service=git-upload-pack' });
      assert.equal(absent.status, 404);
      assert.equal(absent.body, 'Not found');

      const upload = await api.request({ path: '/' + owner.username + '/notes/info/refs?service=git-upload-pack' });
      assert.equal(upload.status, 200);
      assert.equal(upload.headers['content-type'], 'application/x-git-upload-pack-advertisement');
      assert.equal(upload.headers['cache-control'], 'no-cache');
      assert.ok(upload.body.startsWith(UPLOAD_ADVERTISEMENT));

      const suffixed = await api.request({ path: '/' + owner.username + '/notes.git/info/refs?service=git-upload-pack' });
      assert.equal(suffixed.status, 200);
      assert.ok(suffixed.body.startsWith(UPLOAD_ADVERTISEMENT));

      const receive = await api.request({ path: '/' + owner.username + '/notes.git/info/refs?service=git-receive-pack' });
      assert.equal(receive.status, 200);
      assert.equal(receive.headers['content-type'], 'application/x-git-receive-pack-advertisement');
      assert.ok(receive.body.startsWith('001f# service=git-receive-pack\n0000'));

      const noUpload = await api.request({
        method: 'POST',
        path: '/' + owner.username + '/missing/git-upload-pack',
        body: ''
      });
      assert.equal(noUpload.status, 404);
    });
  });

  it('allows only the owner to push', async () => {
    await withApp(async (api) => {
      const owner = api.seedUser(unique('owner'), 'owner-pass');
      const stranger = api.seedUser(unique('stranger'), 'stranger-pass');
      const jar = await login(api, owner);
      const created = await api.request({
        method: 'POST',
        path: '/new',
        body: form({ name: 'pushbox', is_private: '1' }),
        jar
      });
      assert.equal(created.status, 302);

      const anonymous = await api.request({
        method: 'POST',
        path: '/' + owner.username + '/pushbox/git-receive-pack',
        body: ''
      });
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.body, 'Authentication required');
      assert.match(anonymous.headers['www-authenticate'], /Basic realm="GITGRAM"/);

      const bearer = await api.request({
        method: 'POST',
        path: '/' + owner.username + '/pushbox/git-receive-pack',
        headers: { Authorization: 'Bearer token' },
        body: ''
      });
      assert.equal(bearer.status, 401);

      const badPassword = await api.request({
        method: 'POST',
        path: '/' + owner.username + '/pushbox.git/git-receive-pack',
        headers: { Authorization: basic(owner.username, 'wrong-pass') },
        body: ''
      });
      assert.equal(badPassword.status, 401);
      assert.equal(badPassword.body, 'Invalid credentials');

      const forbidden = await api.request({
        method: 'POST',
        path: '/' + owner.username + '/pushbox/git-receive-pack',
        headers: { Authorization: basic(stranger.username, stranger.password) },
        body: ''
      });
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.body, 'Permission denied');

      const missing = await api.request({
        method: 'POST',
        path: '/' + owner.username + '/nope/git-receive-pack',
        headers: { Authorization: basic(owner.username, owner.password) },
        body: ''
      });
      assert.equal(missing.status, 404);

      api.db.prepare("UPDATE repositories SET updated_at = '2000-01-01 00:00:00' WHERE full_name = ?").run(owner.username + '/pushbox');
      const pushed = await api.request({
        method: 'POST',
        path: '/' + owner.username + '/pushbox.git/git-receive-pack',
        headers: {
          Authorization: basic(owner.username, owner.password),
          'Content-Type': 'application/x-git-receive-pack-request'
        },
        body: '0000'
      });
      assert.equal(pushed.status, 200);
      assert.equal(pushed.headers['content-type'], 'application/x-git-receive-pack-result');
      let updatedAt = '2000-01-01 00:00:00';
      for (let attempt = 0; attempt < 20 && updatedAt === '2000-01-01 00:00:00'; attempt++) {
        updatedAt = api.db.prepare('SELECT updated_at FROM repositories WHERE full_name = ?').get(owner.username + '/pushbox').updated_at;
        if (updatedAt === '2000-01-01 00:00:00') {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      assert.notEqual(updatedAt, '2000-01-01 00:00:00');
    });
  });
});
