const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp, login, unique } = require('./helpers');

describe('repository search', () => {
  it('returns only public name and description matches and ignores injected LIKE text', async () => {
    await withApp(async (api) => {
      const ownerName = unique('owner');
      const owner = api.seedUser(ownerName);
      api.seedRepo(owner, 'widget-api', { description: 'public billing api' });
      api.seedRepo(owner, 'widget-secret', { description: 'hidden widget ledger', isPrivate: true });
      api.seedRepo(owner, 'other', { description: 'unrelated notes' });

      const empty = await api.request({ path: '/api/search/repos' });
      assert.equal(empty.status, 200);
      assert.deepEqual(JSON.parse(empty.body), []);

      const blank = await api.request({ path: '/api/search/repos?q=' });
      assert.deepEqual(JSON.parse(blank.body), []);

      const byName = await api.request({ path: '/api/search/repos?q=' + encodeURIComponent('widget') });
      const nameHits = JSON.parse(byName.body);
      assert.deepEqual(nameHits.map((repo) => repo.name), ['widget-api']);
      assert.equal(nameHits[0].owner_name, ownerName);
      assert.equal(nameHits[0].password, undefined);
      assert.equal(nameHits[0].private, 0);

      const byDescription = await api.request({ path: '/api/search/repos?q=' + encodeURIComponent('billing') });
      assert.deepEqual(JSON.parse(byDescription.body).map((repo) => repo.name), ['widget-api']);

      const hidden = await api.request({ path: '/api/search/repos?q=' + encodeURIComponent('ledger') });
      assert.deepEqual(JSON.parse(hidden.body), []);

      const injected = await api.request({
        path: '/api/search/repos?q=' + encodeURIComponent("widget' OR '1'='1")
      });
      assert.deepEqual(JSON.parse(injected.body), []);
    });
  });
});

describe('user repository API', () => {
  it('returns private repositories only for the owning session', async () => {
    await withApp(async (api) => {
      const ownerName = unique('owner');
      const owner = api.seedUser(ownerName);
      const stranger = api.seedUser(unique('stranger'));
      api.seedRepo(owner, 'open-book', { isPrivate: false });
      api.seedRepo(owner, 'closed-book', { isPrivate: true });

      const missing = await api.request({ path: '/api/users/' + unique('ghost') + '/repos' });
      assert.equal(missing.status, 404);
      assert.deepEqual(JSON.parse(missing.body), { error: 'Not found' });

      const anon = JSON.parse((await api.request({ path: '/api/users/' + ownerName + '/repos' })).body);
      assert.deepEqual(anon.map((repo) => repo.name), ['open-book']);

      const other = JSON.parse((await api.request({
        path: '/api/users/' + ownerName + '/repos',
        jar: await login(api, stranger)
      })).body);
      assert.deepEqual(other.map((repo) => repo.name), ['open-book']);
      assert.equal(JSON.stringify(other).includes('password'), false);

      const own = JSON.parse((await api.request({
        path: '/api/users/' + ownerName + '/repos',
        jar: await login(api, owner)
      })).body);
      assert.deepEqual(own.map((repo) => repo.name).sort(), ['closed-book', 'open-book']);
      assert.equal(own.find((repo) => repo.name === 'closed-book').private, 1);
    });
  });
});
