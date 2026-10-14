const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getText,
  login,
  passwordHash,
  passwordMatches,
  postForm,
  register,
  Session,
  counts,
  withApp,
} = require('./helpers');

describe('auth', { concurrency: false }, () => {
  test('registration enforces length, stores a bcrypt hash, and rejects duplicates', async () => {
    await withApp(async (ctx) => {
      const session = new Session(ctx);

      const missing = await postForm(session, '/register', { username: '', email: '', password: '' });
      assert.equal(missing.status, 200);
      assert.match(missing.text, /All fields required/);
      assert.equal(counts(ctx).users, 0);

      const shortName = await register(session, { username: 'ab', email: 'ab@example.com', password: 'secret6' });
      assert.equal(shortName.status, 200);
      assert.match(shortName.text, /Username too short/);
      assert.equal(counts(ctx).users, 0);
      const stillOut = await getText(session, '/');
      assert.match(stillOut.text, />Sign in</);
      assert.doesNotMatch(stillOut.text, />Log out</);

      const shortPassword = await register(session, { username: 'abc', email: 'abc@example.com', password: '12345' });
      assert.equal(shortPassword.status, 200);
      assert.match(shortPassword.text, /Password too short/);
      assert.equal(counts(ctx).users, 0);

      const created = await register(session, { username: 'abc', email: 'abc@example.com', password: '123456' });
      assert.equal(created.status, 302);
      assert.equal(created.location, '/');
      const hash = passwordHash(ctx, 'abc');
      assert.match(hash, /^\$2[ab]\$10\$/);
      assert.notEqual(hash, '123456');
      assert.equal(passwordMatches('123456', hash), true);
      const cookies = created.res.headers.getSetCookie();
      assert.ok(cookies.some((cookie) => cookie.startsWith('connect.sid=') && /httponly/i.test(cookie)));

      const home = await getText(session, '/');
      assert.equal(home.status, 200);
      assert.match(home.text, />Log out</);
      assert.doesNotMatch(home.text, />Sign in</);

      const other = new Session(ctx);
      const dupUser = await register(other, { username: 'abc', email: 'other@example.com', password: 'abcdef' });
      assert.equal(dupUser.status, 200);
      assert.match(dupUser.text, /User already exists/);
      assert.equal(passwordHash(ctx, 'abc'), hash);
      const dupHome = await getText(other, '/');
      assert.match(dupHome.text, />Sign in</);
      assert.doesNotMatch(dupHome.text, />Log out</);

      const dupEmail = await register(other, { username: 'abd', email: 'abc@example.com', password: 'abcdef' });
      assert.equal(dupEmail.status, 200);
      assert.match(dupEmail.text, /User already exists/);
      assert.equal(counts(ctx).users, 1);
      assert.equal(passwordHash(ctx, 'abc'), hash);
      assert.equal(passwordMatches('abcdef', hash), false);
    });
  });

  test('login accepts username or email, rejects mismatches, and logout ends that session', async () => {
    await withApp(async (ctx) => {
      const session = new Session(ctx);
      const anonLogin = await getText(session, '/login');
      assert.equal(anonLogin.status, 200);
      assert.match(anonLogin.text, /Welcome back/);
      const anonRegister = await getText(session, '/register');
      assert.equal(anonRegister.status, 200);
      assert.match(anonRegister.text, /Create your account/);

      await register(session, { username: 'Ann', email: 'Ann@Example.com', password: 'pw-ann-login' });
      const signedLogin = await getText(session, '/login');
      assert.equal(signedLogin.status, 302);
      assert.equal(signedLogin.location, '/');
      const signedRegister = await getText(session, '/register');
      assert.equal(signedRegister.status, 302);
      assert.equal(signedRegister.location, '/');

      const loggedOut = await getText(session, '/logout');
      assert.equal(loggedOut.status, 302);
      assert.equal(loggedOut.location, '/');
      const afterLogout = await getText(session, '/');
      assert.match(afterLogout.text, />Sign in</);
      assert.doesNotMatch(afterLogout.text, />Log out</);

      const wrong = await login(session, 'Ann', 'not-the-password');
      assert.equal(wrong.status, 200);
      assert.match(wrong.text, /Invalid credentials/);
      assert.match((await getText(session, '/')).text, />Sign in</);

      const emptyPassword = await login(session, 'Ann', '');
      assert.equal(emptyPassword.status, 200);
      assert.match(emptyPassword.text, /Invalid credentials/);

      const blank = await login(session, '', '');
      assert.equal(blank.status, 200);
      assert.match(blank.text, /Invalid credentials/);

      const wrongCaseUser = await login(session, 'ann', 'pw-ann-login');
      assert.equal(wrongCaseUser.status, 200);
      assert.match(wrongCaseUser.text, /Invalid credentials/);

      const wrongCaseEmail = await login(session, 'ann@example.com', 'pw-ann-login');
      assert.equal(wrongCaseEmail.status, 200);
      assert.match(wrongCaseEmail.text, /Invalid credentials/);
      assert.match((await getText(session, '/')).text, />Sign in</);
      assert.doesNotMatch((await getText(session, '/')).text, />Log out</);

      const byEmail = await login(session, 'Ann@Example.com', 'pw-ann-login');
      assert.equal(byEmail.status, 302);
      assert.match((await getText(session, '/')).text, />Log out</);
      await getText(session, '/logout');

      const byUsername = await login(session, 'Ann', 'pw-ann-login');
      assert.equal(byUsername.status, 302);
      assert.match((await getText(session, '/')).text, />Ann</);
      assert.match((await getText(session, '/')).text, />Log out</);

      const anonymous = new Session(ctx);
      const anonLogout = await getText(anonymous, '/logout');
      assert.equal(anonLogout.status, 302);
      assert.equal(anonLogout.location, '/');
      assert.match((await getText(anonymous, '/')).text, />Sign in</);
    });
  });

  test('a quote-shaped username is stored literally and does not authenticate another login', async () => {
    await withApp(async (ctx) => {
      const name = "bob' OR '1'='1";
      const session = new Session(ctx);
      const created = await register(session, { username: name, email: 'bob@example.com', password: 'pw-bob-sql' });
      assert.equal(created.status, 302);
      assert.equal(passwordMatches('pw-bob-sql', passwordHash(ctx, name)), true);
      assert.equal(counts(ctx).users, 1);

      const home = await getText(session, '/');
      assert.match(home.text, /bob&#39; OR &#39;1&#39;=&#39;1/);
      assert.equal(home.text.includes(name), false);

      const attacker = new Session(ctx);
      const injected = await login(attacker, "' OR 1=1 --", 'pw-bob-sql');
      assert.equal(injected.status, 200);
      assert.match(injected.text, /Invalid credentials/);
      assert.match((await getText(attacker, '/')).text, />Sign in</);
      assert.equal(counts(ctx).users, 1);
      assert.equal(passwordMatches('pw-bob-sql', passwordHash(ctx, name)), true);

      const again = await login(attacker, name, 'pw-bob-sql');
      assert.equal(again.status, 302);
      assert.match((await getText(attacker, '/')).text, />Log out</);
    });
  });
});
