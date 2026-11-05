const { before, after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const {
  unique,
  createTestContext,
  listen,
  close,
  cleanupUsers,
  Session,
} = require('./support');

describe('authentication', () => {
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

  test('rejects incomplete, short, and duplicate accounts', async () => {
    const session = new Session(port);
    const missing = await session.form('POST', '/register', { username: 'abc', email: 'a@example.com' });
    assert.equal(missing.status, 200);
    assert.match(missing.body, /All fields required/);

    const shortName = await session.form('POST', '/register', {
      username: 'ab',
      email: 'short-name@example.com',
      password: 'secret1',
    });
    assert.equal(shortName.status, 200);
    assert.match(shortName.body, /Username too short/);

    const shortPassword = await session.form('POST', '/register', {
      username: 'validname',
      email: 'short-pass@example.com',
      password: '12345',
    });
    assert.equal(shortPassword.status, 200);
    assert.match(shortPassword.body, /Password too short/);
    assert.equal(db.prepare('SELECT id FROM users WHERE email = ?').get('short-name@example.com'), undefined);
    assert.equal(db.prepare('SELECT id FROM users WHERE email = ?').get('short-pass@example.com'), undefined);

    const username = unique('ada');
    const email = `${username}@example.com`;
    users.add(username);
    const created = await session.form('POST', '/register', {
      username,
      email,
      password: 'secret1',
    });
    assert.equal(created.status, 302);
    assert.equal(created.headers.location, '/');

    const row = db.prepare('SELECT username, email, password FROM users WHERE username = ?').get(username);
    assert.equal(row.email, email);
    assert.notEqual(row.password, 'secret1');
    assert.equal(bcrypt.compareSync('secret1', row.password), true);

    const duplicateName = await new Session(port).form('POST', '/register', {
      username,
      email: `${unique('other')}@example.com`,
      password: 'secret1',
    });
    assert.match(duplicateName.body, /User already exists/);

    const duplicateEmail = await new Session(port).form('POST', '/register', {
      username: unique('other'),
      email,
      password: 'secret1',
    });
    assert.match(duplicateEmail.body, /User already exists/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get(email).n, 1);
  });

  test('logs in by username or email and rejects bad credentials the same way', async () => {
    const username = unique('grace');
    const email = `${username}@example.com`;
    const password = 'secret1';
    users.add(username);

    const registered = new Session(port);
    assert.equal((await registered.form('POST', '/register', { username, email, password })).status, 302);

    const loggedOut = new Session(port);
    const unknown = await loggedOut.form('POST', '/login', { username: unique('missing'), password });
    const wrong = await loggedOut.form('POST', '/login', { username, password: '' });
    assert.match(unknown.body, /Invalid credentials/);
    assert.match(wrong.body, /Invalid credentials/);
    assert.equal(unknown.status, wrong.status);

    const byEmail = new Session(port);
    const emailLogin = await byEmail.form('POST', '/login', { username: email, password });
    assert.equal(emailLogin.status, 302);
    assert.equal(emailLogin.headers.location, '/');
    const authed = await byEmail.request('GET', '/new');
    assert.equal(authed.status, 200);
    assert.match(authed.body, /Create a new repository/);

    const byName = new Session(port);
    assert.equal((await byName.form('POST', '/login', { username, password })).status, 302);
    assert.equal((await byName.request('GET', '/register')).status, 302);
    assert.equal((await byName.request('GET', '/login')).headers.location, '/');
  });

  test('logout clears the session', async () => {
    const username = unique('logout');
    users.add(username);
    const session = new Session(port);
    await session.form('POST', '/register', {
      username,
      email: `${username}@example.com`,
      password: 'secret1',
    });
    assert.equal((await session.request('GET', '/new')).status, 200);

    const loggedOut = await session.request('GET', '/logout');
    assert.equal(loggedOut.status, 302);
    const afterLogout = await session.request('GET', '/new');
    assert.equal(afterLogout.status, 302);
    assert.equal(afterLogout.headers.location, '/login');
  });
});
