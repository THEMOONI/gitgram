const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp, login, unique } = require('./helpers');

describe('public homepage', () => {
  it('lists only public repositories, newest first, including for the owner', async () => {
    await withApp(async (api) => {
      const empty = await api.request({ path: '/' });
      assert.equal(empty.status, 200);
      assert.match(empty.body, /No public repositories yet/);
      assert.match(empty.body, /Start for free/);

      const owner = api.seedUser(unique('owner'));
      const older = api.seedRepo(owner, 'older-public', { description: 'OLDER-PUBLIC' });
      const newer = api.seedRepo(owner, 'newer-public', { description: 'NEWER-PUBLIC' });
      api.seedRepo(owner, 'owner-private', { description: 'OWNER-PRIVATE-HOME', isPrivate: true });
      api.db.prepare('UPDATE repositories SET updated_at = ? WHERE id = ?').run('2020-01-01 00:00:00', older.id);
      api.db.prepare('UPDATE repositories SET updated_at = ? WHERE id = ?').run('2024-06-01 00:00:00', newer.id);
      api.db.prepare("UPDATE repositories SET updated_at = '2025-01-01 00:00:00' WHERE name = 'owner-private'").run();

      const jar = await login(api, owner);
      const home = await api.request({ path: '/', jar });
      assert.match(home.body, /Create a repository/);
      assert.match(home.body, /NEWER-PUBLIC/);
      assert.match(home.body, /OLDER-PUBLIC/);
      assert.ok(home.body.indexOf('NEWER-PUBLIC') < home.body.indexOf('OLDER-PUBLIC'));
      assert.doesNotMatch(home.body, /OWNER-PRIVATE-HOME/);
      assert.doesNotMatch(home.body, /owner-private/);
    });
  });
});
