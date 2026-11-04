const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { nid, createTestApp, listen, close, Client, removeOwner } = require('./helpers');

describe('authentication', { concurrency: false }, () => {
  let server;
  let db;

  before(async () => {
    const created = createTestApp();
    db = created.db;
    server = await listen(created.app);
  });

  after(async () => {
    await close(server);
    db.close();
  });

  test('registration rejects incomplete, short, and duplicate accounts', async () => {
    const client = new Client(server);

    const missing = await client.post('/register', { username: '', email: 'a@example.com', password: 'secret1' });
    assert.equal(missing.status, 200);
    assert.match(missing.text, /All fields required/);

    const shortName = await client.post('/register', { username: 'ab', email: 'short-name@example.com', password: 'secret1' });
    assert.equal(shortName.status, 200);
    assert.match(shortName.text, /Username too short/);
    assert.equal(db.prepare('SELECT id FROM users WHERE username = ?').get('ab'), undefined);

    const shortPassword = await client.post('/register', { username: 'longenough', email: 'short-pw@example.com', password: '12345' });
    assert.equal(shortPassword.status, 200);
    assert.match(shortPassword.text, /Password too short/);
    assert.equal(db.prepare('SELECT id FROM users WHERE username = ?').get('longenough'), undefined);

    const username = nid('ada');
    const email = username + '@example.com';
    const created = await client.post('/register', { username, email, password: 'secret1' });
    assert.equal(created.status, 302);
    assert.equal(created.location, '/');

    const stored = db.prepare('SELECT password FROM users WHERE username = ?').get(username);
    assert.notEqual(stored.password, 'secret1');
    assert.match(stored.password, /^\$2[aby]\$/);
    assert.equal(bcrypt.compareSync('secret1', stored.password), true);

    const home = await client.get('/');
    assert.equal(home.status, 200);
    assert.match(home.text, new RegExp('href="/@' + username + '"'));

    const other = new Client(server);
    const duplicateName = await other.post('/register', { username, email: nid('other') + '@example.com', password: 'secret1' });
    assert.equal(duplicateName.status, 200);
    assert.match(duplicateName.text, /User already exists/);
    const otherHome = await other.get('/');
    assert.doesNotMatch(otherHome.text, new RegExp('href="/@' + username + '"'));

    const duplicateEmail = await other.post('/register', { username: nid('bob'), email, password: 'secret1' });
    assert.equal(duplicateEmail.status, 200);
    assert.match(duplicateEmail.text, /User already exists/);
  });

  test('login accepts username or email and rejects bad credentials', async () => {
    const username = nid('lin');
    const email = username + '@example.com';
    const password = 'secret1';
    const signer = new Client(server);
    const registered = await signer.post('/register', { username, email, password });
    assert.equal(registered.status, 302);

    const byName = new Client(server);
    const nameLogin = await byName.post('/login', { username, password });
    assert.equal(nameLogin.status, 302);
    assert.equal(nameLogin.location, '/');
    const nameHome = await byName.get('/');
    assert.match(nameHome.text, new RegExp('href="/@' + username + '"'));

    const byEmail = new Client(server);
    const emailLogin = await byEmail.post('/login', { username: email, password });
    assert.equal(emailLogin.status, 302);
    assert.equal(emailLogin.location, '/');
    const emailHome = await byEmail.get('/');
    assert.match(emailHome.text, new RegExp('href="/@' + username + '"'));

    const wrong = new Client(server);
    const badPassword = await wrong.post('/login', { username, password: 'nope12' });
    assert.equal(badPassword.status, 200);
    assert.match(badPassword.text, /Invalid credentials/);

    const unknown = await wrong.post('/login', { username: nid('missing'), password: 'secret1' });
    assert.equal(unknown.status, 200);
    assert.match(unknown.text, /Invalid credentials/);

    const emptyPassword = await wrong.post('/login', { username, password: '' });
    assert.equal(emptyPassword.status, 200);
    assert.match(emptyPassword.text, /Invalid credentials/);

    const stillOut = await wrong.get('/');
    assert.doesNotMatch(stillOut.text, new RegExp('href="/@' + username + '"'));
    assert.match(stillOut.text, /href="\/login"/);
  });

  test('authenticated visitors are sent home from the auth pages and logout ends the session', async () => {
    const username = nid('out');
    const client = new Client(server);
    const registered = await client.post('/register', { username, email: username + '@example.com', password: 'secret1' });
    assert.equal(registered.status, 302);

    const registerPage = await client.get('/register');
    assert.equal(registerPage.status, 302);
    assert.equal(registerPage.location, '/');

    const loginPage = await client.get('/login');
    assert.equal(loginPage.status, 302);
    assert.equal(loginPage.location, '/');

    const loggedOut = await client.get('/logout');
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.location, '/');

    const home = await client.get('/');
    assert.doesNotMatch(home.text, new RegExp('href="/@' + username + '"'));
    assert.match(home.text, /href="\/login"/);

    const createRepo = await client.post('/new', { name: 'after-logout', description: '' });
    assert.equal(createRepo.status, 302);
    assert.equal(createRepo.location, '/login');
  });

  test('profile hides private repositories from other people', async () => {
    const ownerName = nid('own');
    const strangerName = nid('str');
    const owner = new Client(server);
    const stranger = new Client(server);
    assert.equal((await owner.post('/register', { username: ownerName, email: ownerName + '@example.com', password: 'secret1' })).status, 302);
    assert.equal((await stranger.post('/register', { username: strangerName, email: strangerName + '@example.com', password: 'secret1' })).status, 302);

    const publicName = nid('pub');
    const privateName = nid('sec');
    assert.equal((await owner.post('/new', { name: publicName, description: 'visible work' })).status, 302);
    assert.equal((await owner.post('/new', { name: privateName, description: 'hidden work', is_private: '1' })).status, 302);

    try {
      const ownerProfile = await owner.get('/@' + ownerName);
      assert.equal(ownerProfile.status, 200);
      assert.match(ownerProfile.text, new RegExp(publicName));
      assert.match(ownerProfile.text, new RegExp(privateName));
      assert.match(ownerProfile.text, /badge-private/);

      const strangerProfile = await stranger.get('/@' + ownerName);
      assert.equal(strangerProfile.status, 200);
      assert.match(strangerProfile.text, new RegExp(publicName));
      assert.doesNotMatch(strangerProfile.text, new RegExp(privateName));
      assert.doesNotMatch(strangerProfile.text, /hidden work/);

      const anonymous = await new Client(server).get('/@' + ownerName);
      assert.equal(anonymous.status, 200);
      assert.match(anonymous.text, new RegExp(publicName));
      assert.doesNotMatch(anonymous.text, new RegExp(privateName));

      const missing = await new Client(server).get('/@' + nid('ghost'));
      assert.equal(missing.status, 404);
    } finally {
      removeOwner(ownerName);
    }
  });

  test('each app instance uses the database it was given', async () => {
    const first = createTestApp();
    const second = createTestApp();
    const serverA = await listen(first.app);
    const serverB = await listen(second.app);
    try {
      const username = nid('iso');
      const clientA = new Client(serverA);
      const created = await clientA.post('/register', { username, email: username + '@example.com', password: 'secret1' });
      assert.equal(created.status, 302);

      const clientB = new Client(serverB);
      const login = await clientB.post('/login', { username, password: 'secret1' });
      assert.equal(login.status, 200);
      assert.match(login.text, /Invalid credentials/);
    } finally {
      await close(serverA);
      await close(serverB);
      first.db.close();
      second.db.close();
    }
  });
});
