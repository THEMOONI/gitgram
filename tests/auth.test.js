const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp, login, form, unique } = require('./helpers');

describe('registration and login', () => {
  it('rejects incomplete, short, and duplicate accounts and stores a hash', async () => {
    await withApp(async (api) => {
      const missing = await api.request({
        method: 'POST',
        path: '/register',
        body: form({ username: 'abc', password: '123456' })
      });
      assert.equal(missing.status, 200);
      assert.match(missing.body, /All fields required/);

      const shortName = await api.request({
        method: 'POST',
        path: '/register',
        body: form({ username: 'ab', email: 'ab@example.com', password: '123456' })
      });
      assert.match(shortName.body, /Username too short/);

      const shortPassword = await api.request({
        method: 'POST',
        path: '/register',
        body: form({ username: 'abc', email: 'abc@example.com', password: '12345' })
      });
      assert.match(shortPassword.body, /Password too short/);

      const created = await api.request({
        method: 'POST',
        path: '/register',
        body: form({ username: 'abc', email: 'abc@example.com', password: '123456' })
      });
      assert.equal(created.status, 302);
      assert.equal(created.headers.location, '/');

      const row = api.db.prepare('SELECT password FROM users WHERE username = ?').get('abc');
      assert.notEqual(row.password, '123456');
      assert.match(row.password, /^\$2[aby]\$/);

      const duplicateName = await api.request({
        method: 'POST',
        path: '/register',
        body: form({ username: 'abc', email: 'other@example.com', password: '123456' })
      });
      assert.match(duplicateName.body, /User already exists/);

      const duplicateEmail = await api.request({
        method: 'POST',
        path: '/register',
        body: form({ username: 'xyz', email: 'abc@example.com', password: '123456' })
      });
      assert.match(duplicateEmail.body, /User already exists/);
      assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);

      const home = await api.request({ path: '/', jar: created.jar });
      assert.match(home.body, /Log out/);
      assert.match(home.body, />abc</);

      const registerAgain = await api.request({ path: '/register', jar: created.jar });
      assert.equal(registerAgain.status, 302);
      assert.equal(registerAgain.headers.location, '/');
    });
  });

  it('logs in with username or email and rejects a wrong password', async () => {
    await withApp(async (api) => {
      const username = unique('ada');
      const user = api.seedUser(username, 'correct-horse');

      const wrong = await api.request({
        method: 'POST',
        path: '/login',
        body: form({ username, password: 'nope' })
      });
      assert.equal(wrong.status, 200);
      assert.match(wrong.body, /Invalid credentials/);
      assert.equal(wrong.headers['set-cookie'], undefined);

      const unknown = await api.request({
        method: 'POST',
        path: '/login',
        body: form({ username: 'missing', password: 'correct-horse' })
      });
      assert.match(unknown.body, /Invalid credentials/);

      const byName = await api.request({
        method: 'POST',
        path: '/login',
        body: form({ username: user.username, password: user.password })
      });
      assert.equal(byName.status, 302);
      const namedHome = await api.request({ path: '/', jar: byName.jar });
      assert.match(namedHome.body, /Create a repository/);

      const byEmail = await api.request({
        method: 'POST',
        path: '/login',
        body: form({ username: user.email, password: user.password })
      });
      assert.equal(byEmail.status, 302);
      const emailHome = await api.request({ path: '/', jar: byEmail.jar });
      assert.match(emailHome.body, new RegExp('/@' + username));
    });
  });

  it('hides private repositories after logout', async () => {
    await withApp(async (api) => {
      const username = unique('owner');
      const user = api.seedUser(username);
      api.seedRepo(user, 'secretnotes', { description: 'HIDDEN-AFTER-LOGOUT', isPrivate: true });
      const jar = await login(api, user);

      const before = await api.request({ path: '/api/users/' + username + '/repos', jar });
      assert.equal(before.status, 200);
      assert.match(before.body, /secretnotes/);

      const loggedOut = await api.request({ path: '/logout', jar });
      assert.equal(loggedOut.status, 302);

      const after = await api.request({ path: '/api/users/' + username + '/repos', jar: loggedOut.jar });
      assert.equal(after.status, 200);
      assert.deepEqual(JSON.parse(after.body), []);

      const home = await api.request({ path: '/', jar: loggedOut.jar });
      assert.match(home.body, /Sign in/);
      assert.doesNotMatch(home.body, /HIDDEN-AFTER-LOGOUT/);
    });
  });
});

describe('profile visibility', () => {
  it('shows private repositories only to the owner', async () => {
    await withApp(async (api) => {
      const ownerName = unique('owner');
      const strangerName = unique('stranger');
      const owner = api.seedUser(ownerName);
      const stranger = api.seedUser(strangerName);
      api.seedRepo(owner, 'diary', { description: 'OWNER-ONLY-DIARY', isPrivate: true });
      api.seedRepo(owner, 'handbook', { description: 'PUBLIC-HANDBOOK', isPrivate: false });

      const missing = await api.request({ path: '/@' + unique('nobody') });
      assert.equal(missing.status, 404);
      assert.match(missing.body, /Not Found - GITGRAM/);

      const anon = await api.request({ path: '/@' + ownerName });
      assert.equal(anon.status, 200);
      assert.match(anon.body, /handbook/);
      assert.match(anon.body, /PUBLIC-HANDBOOK/);
      assert.doesNotMatch(anon.body, /diary/);
      assert.doesNotMatch(anon.body, /OWNER-ONLY-DIARY/);
      assert.doesNotMatch(anon.body, /\+ New Repository/);

      const own = await api.request({ path: '/@' + ownerName, jar: await login(api, owner) });
      assert.match(own.body, /diary/);
      assert.match(own.body, /badge-private/);
      assert.match(own.body, /handbook/);
      assert.match(own.body, /\+ New Repository/);

      const other = await api.request({ path: '/@' + ownerName, jar: await login(api, stranger) });
      assert.match(other.body, /handbook/);
      assert.doesNotMatch(other.body, /diary/);
      assert.doesNotMatch(other.body, /\+ New Repository/);
    });
  });
});
