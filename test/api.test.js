const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { nid, createTestApp, listen, close, Client, removeOwner, json } = require('./helpers');

describe('repository API', { concurrency: false }, () => {
  let server;
  let db;
  let ownerName;
  let publicName;
  let privateName;
  let publicDescription;

  before(async () => {
    const created = createTestApp();
    db = created.db;
    server = await listen(created.app);

    ownerName = nid('api');
    publicName = nid('pub');
    privateName = nid('sec');
    publicDescription = 'blurb-' + nid('d');
    const owner = new Client(server);
    assert.equal((await owner.post('/register', { username: ownerName, email: ownerName + '@example.com', password: 'secret1' })).status, 302);
    assert.equal((await owner.post('/new', { name: publicName, description: publicDescription })).status, 302);
    assert.equal((await owner.post('/new', { name: privateName, description: 'classified-' + privateName, is_private: '1' })).status, 302);
    server.owner = owner;
  });

  after(async () => {
    removeOwner(ownerName);
    await close(server);
    db.close();
  });

  test('search returns public name and description matches and drops private repos', async () => {
    const empty = await new Client(server).get('/api/search/repos');
    assert.equal(empty.status, 200);
    assert.deepEqual(json(empty), []);

    const blank = await new Client(server).get('/api/search/repos?q=');
    assert.deepEqual(json(blank), []);

    const byName = json(await new Client(server).get('/api/search/repos?q=' + encodeURIComponent(publicName)));
    assert.ok(byName.some((repo) => repo.full_name === ownerName + '/' + publicName && repo.owner_name === ownerName));
    assert.equal(byName.some((repo) => repo.name === privateName), false);

    const byDescription = json(await new Client(server).get('/api/search/repos?q=' + encodeURIComponent(publicDescription)));
    assert.ok(byDescription.some((repo) => repo.name === publicName));
    assert.equal(byDescription.some((repo) => repo.name === privateName), false);

    const injected = json(await new Client(server).get('/api/search/repos?q=' + encodeURIComponent("' OR 1=1 --")));
    assert.ok(Array.isArray(injected));
    assert.equal(injected.some((repo) => repo.name === privateName), false);

    const wildcard = json(await new Client(server).get('/api/search/repos?q=' + encodeURIComponent('%')));
    assert.ok(wildcard.some((repo) => repo.name === publicName));
    assert.equal(wildcard.some((repo) => repo.name === privateName), false);
    assert.equal(wildcard.some((repo) => repo.private), false);
  });

  test('user repository list follows ownership', async () => {
    const missing = await new Client(server).get('/api/users/' + nid('ghost') + '/repos');
    assert.equal(missing.status, 404);
    assert.deepEqual(json(missing), { error: 'Not found' });

    const names = (body) => body.map((repo) => repo.name);
    const anonymous = json(await new Client(server).get('/api/users/' + ownerName + '/repos'));
    assert.ok(names(anonymous).includes(publicName));
    assert.equal(names(anonymous).includes(privateName), false);

    const strangerName = nid('str');
    const stranger = new Client(server);
    assert.equal((await stranger.post('/register', { username: strangerName, email: strangerName + '@example.com', password: 'secret1' })).status, 302);
    const strangerList = json(await stranger.get('/api/users/' + ownerName + '/repos'));
    assert.ok(names(strangerList).includes(publicName));
    assert.equal(names(strangerList).includes(privateName), false);

    const ownerList = json(await server.owner.get('/api/users/' + ownerName + '/repos'));
    assert.ok(names(ownerList).includes(publicName));
    assert.ok(names(ownerList).includes(privateName));
    const hidden = ownerList.find((repo) => repo.name === privateName);
    assert.equal(hidden.private, 1);
  });

  test('the homepage lists only public repositories', async () => {
    const home = await new Client(server).get('/');
    assert.equal(home.status, 200);
    assert.match(home.text, new RegExp(publicName));
    assert.match(home.text, new RegExp(publicDescription));
    assert.doesNotMatch(home.text, new RegExp(privateName));
  });
});
