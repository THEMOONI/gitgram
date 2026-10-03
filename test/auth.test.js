const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { Agent, closeTestContext, createTestContext, registerUser, uniqueId } = require('./helpers');

describe('account authentication', { concurrency: 1 }, () => {
  let ctx;

  before(async () => {
    ctx = await createTestContext();
  });

  after(async () => {
    await closeTestContext(ctx);
  });

  test('rejects incomplete registration and does not create a user', async () => {
    const agent = new Agent(ctx.server);
    const username = `short${uniqueId()}`;
    const response = await agent.request('POST', '/register', {
      form: { username, email: '', password: 'correct-horse' },
    });
    assert.equal(response.status, 200);
    assert.match(response.text, /All fields required/);
    assert.equal(ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username), undefined);
  });

  test('rejects usernames shorter than 3 and passwords shorter than 6', async () => {
    const agent = new Agent(ctx.server);
    const shortName = await agent.request('POST', '/register', {
      form: { username: 'ab', email: `ab${uniqueId()}@example.com`, password: 'correct-horse' },
    });
    assert.match(shortName.text, /Username too short/);
    assert.equal(ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('ab'), undefined);

    const boundaryName = `u${uniqueId()}`;
    const shortPassword = await agent.request('POST', '/register', {
      form: { username: boundaryName, email: `${boundaryName}@example.com`, password: '12345' },
    });
    assert.match(shortPassword.text, /Password too short/);
    assert.equal(ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(boundaryName), undefined);
  });

  test('accepts the minimum username and password lengths and stores a hash', async () => {
    const agent = new Agent(ctx.server);
    const username = `a${uniqueId().slice(0, 2)}`;
    const created = await registerUser(agent, { username, password: '123456' });
    assert.equal(created.response.status, 302);
    assert.equal(created.response.headers.get('location'), '/');

    const row = ctx.db.prepare('SELECT password FROM users WHERE username = ?').get(username);
    assert.ok(row);
    assert.notEqual(row.password, '123456');
    assert.equal(bcrypt.compareSync('123456', row.password), true);

    const home = await agent.request('GET', '/');
    assert.match(home.text, /Create a repository/);
  });

  test('rejects a duplicate username or email', async () => {
    const first = await registerUser(new Agent(ctx.server), {});
    assert.equal(first.response.status, 302);

    const duplicateName = await new Agent(ctx.server).request('POST', '/register', {
      form: { username: first.username, email: `other${uniqueId()}@example.com`, password: 'correct-horse' },
    });
    assert.match(duplicateName.text, /User already exists/);

    const duplicateEmail = await new Agent(ctx.server).request('POST', '/register', {
      form: { username: `other${uniqueId()}`, email: first.email, password: 'correct-horse' },
    });
    assert.match(duplicateEmail.text, /User already exists/);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get(first.email).count, 1);
  });

  test('logs in with username or email and rejects bad credentials without a session', async () => {
    const registered = await registerUser(new Agent(ctx.server), {});

    const byUsername = new Agent(ctx.server);
    const usernameLogin = await byUsername.request('POST', '/login', {
      form: { username: registered.username, password: registered.password },
    });
    assert.equal(usernameLogin.status, 302);
    assert.equal(usernameLogin.headers.get('location'), '/');
    const usernameHome = await byUsername.request('GET', '/');
    assert.match(usernameHome.text, new RegExp(`/@${registered.username}`));

    const byEmail = new Agent(ctx.server);
    const emailLogin = await byEmail.request('POST', '/login', {
      form: { username: registered.email, password: registered.password },
    });
    assert.equal(emailLogin.status, 302);

    const wrong = new Agent(ctx.server);
    const wrongPassword = await wrong.request('POST', '/login', {
      form: { username: registered.username, password: 'not-the-password' },
    });
    assert.equal(wrongPassword.status, 200);
    assert.match(wrongPassword.text, /Invalid credentials/);
    const stillAnonymous = await wrong.request('GET', '/');
    assert.match(stillAnonymous.text, /Start for free/);

    const injection = await new Agent(ctx.server).request('POST', '/login', {
      form: { username: "' OR '1'='1", password: 'correct-horse' },
    });
    assert.match(injection.text, /Invalid credentials/);

    const omittedPassword = await new Agent(ctx.server).request('POST', '/login', {
      form: { username: registered.username },
    });
    assert.notEqual(omittedPassword.status, 302);
    assert.doesNotMatch(omittedPassword.headers.get('location') || '', /^\/$/);
  });

  test('logout ends the session and signed-in users skip the auth forms', async () => {
    const agent = new Agent(ctx.server);
    const registered = await registerUser(agent, {});
    assert.equal(registered.response.status, 302);

    const registerPage = await agent.request('GET', '/register');
    assert.equal(registerPage.status, 302);
    assert.equal(registerPage.headers.get('location'), '/');

    const loggedOut = await agent.request('GET', '/logout');
    assert.equal(loggedOut.status, 302);
    const home = await agent.request('GET', '/');
    assert.match(home.text, /Start for free/);
    assert.doesNotMatch(home.text, /Create a repository/);
  });
});
