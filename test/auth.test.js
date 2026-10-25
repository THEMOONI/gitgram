const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  passwordHash,
  registerUser,
  start,
} = require('./helpers');

describe('authentication', { concurrency: 1 }, () => {
  let ctx;

  before(async () => {
    ctx = await start();
  });

  after(async () => {
    if (ctx) await ctx.close();
  });

  test('registration rejects short values, accepts 3 and 6, and stores a bcrypt hash behind an HttpOnly cookie', async () => {
    const session = ctx.session();

    const missing = await session.postForm('/register', { username: '', email: '', password: '' });
    assert.match((await missing.text()), /All fields required/);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get('').n, 0);

    const shortUser = await session.postForm('/register', {
      username: 'ab',
      email: 'ab@example.test',
      password: 'abcdef',
    });
    assert.equal(shortUser.status, 200);
    assert.match(await shortUser.text(), /Username too short/);
    assert.equal(ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('ab'), undefined);
    assert.equal(shortUser.headers.getSetCookie().some((cookie) => cookie.startsWith('connect.sid=')), false);

    const shortPassword = await session.postForm('/register', {
      username: 'abcd',
      email: 'abcd@example.test',
      password: 'abcde',
    });
    assert.equal(shortPassword.status, 200);
    assert.match(await shortPassword.text(), /Password too short/);
    assert.equal(ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('abcd'), undefined);

    const username = ctx.usernameOfLength(3);
    const password = 'abcdef';
    ctx.users.add(username);
    const created = await session.postForm('/register', {
      username,
      email: `${username}@example.test`,
      password,
    });
    assert.equal(created.status, 302);
    assert.equal(created.headers.get('location'), '/');
    const cookies = created.headers.getSetCookie();
    assert.ok(cookies.some((cookie) => cookie.startsWith('connect.sid=') && cookie.includes('HttpOnly')));
    assert.equal(cookies.join('\n').includes(password), false);
    await created.text();

    const hash = passwordHash(ctx.db, username);
    assert.match(hash, /^\$2[aby]\$/);
    assert.notEqual(hash, password);

    const home = await session.fetch('/');
    const homeText = await home.text();
    assert.equal(home.status, 200);
    assert.match(homeText, /Log out/);
    assert.match(homeText, new RegExp(`/@${username}`));
  });

  test('duplicate username or email does not replace the stored hash or authenticate the new cookie', async () => {
    const owner = ctx.session();
    const user = await registerUser(ctx, owner);
    const hash = passwordHash(ctx.db, user.username);

    const dupNameSession = ctx.session();
    const dupName = await dupNameSession.postForm('/register', {
      username: user.username,
      email: `other-${user.username}@example.test`,
      password: 'another-pass',
    });
    assert.equal(dupName.status, 200);
    assert.match(await dupName.text(), /User already exists/);
    assert.equal(passwordHash(ctx.db, user.username), hash);
    const dupNameHome = await dupNameSession.fetch('/');
    assert.doesNotMatch(await dupNameHome.text(), /Log out/);

    const dupEmailSession = ctx.session();
    const dupEmail = await dupEmailSession.postForm('/register', {
      username: ctx.nextId('other'),
      email: user.email,
      password: 'another-pass',
    });
    assert.equal(dupEmail.status, 200);
    assert.match(await dupEmail.text(), /User already exists/);
    assert.equal(passwordHash(ctx.db, user.username), hash);
    assert.equal(ctx.db.prepare('SELECT id FROM users WHERE email = ?').all(user.email).length, 1);

    const stillOwner = await owner.fetch('/');
    assert.match(await stillOwner.text(), /Log out/);
  });

  test('a signed-in duplicate or blank registration keeps the session and the hash', async () => {
    const session = ctx.session();
    const user = await registerUser(ctx, session);
    const hash = passwordHash(ctx.db, user.username);

    const duplicate = await session.postForm('/register', {
      username: user.username,
      email: user.email,
      password: 'another-pass',
    });
    assert.equal(duplicate.status, 200);
    assert.match(await duplicate.text(), /User already exists/);

    const blank = await session.postForm('/register', { username: '', email: '', password: '' });
    assert.equal(blank.status, 200);
    assert.match(await blank.text(), /All fields required/);

    assert.equal(passwordHash(ctx.db, user.username), hash);
    const home = await session.fetch('/');
    const homeText = await home.text();
    assert.match(homeText, /Log out/);
    assert.match(homeText, new RegExp(`/@${user.username}`));
  });

  test('login accepts the username or email and rejects blank, empty, and case-mismatched credentials', async () => {
    const username = `Ada${ctx.nextId('L')}`;
    const created = ctx.session();
    const user = await registerUser(ctx, created, {
      username,
      email: `${username}@example.test`,
    });

    const byName = ctx.session();
    const nameLogin = await byName.postForm('/login', { username: user.username, password: user.password });
    assert.equal(nameLogin.status, 302);
    assert.equal(nameLogin.headers.get('location'), '/');
    await nameLogin.text();
    assert.match(await (await byName.fetch('/')).text(), /Log out/);

    const byEmail = ctx.session();
    const emailLogin = await byEmail.postForm('/login', { username: user.email, password: user.password });
    assert.equal(emailLogin.status, 302);
    await emailLogin.text();
    assert.match(await (await byEmail.fetch('/')).text(), new RegExp(`/@${user.username}`));

    const blankSession = ctx.session();
    const blank = await blankSession.postForm('/login', { username: '', password: '' });
    assert.equal(blank.status, 200);
    assert.match(await blank.text(), /Invalid credentials/);
    assert.doesNotMatch(await (await blankSession.fetch('/')).text(), /Log out/);

    const emptyPassword = ctx.session();
    const empty = await emptyPassword.postForm('/login', { username: user.username, password: '' });
    assert.equal(empty.status, 200);
    assert.match(await empty.text(), /Invalid credentials/);
    assert.doesNotMatch(await (await emptyPassword.fetch('/')).text(), /Log out/);

    const wrongPassword = ctx.session();
    const wrong = await wrongPassword.postForm('/login', { username: user.username, password: 'not-the-password' });
    assert.equal(wrong.status, 200);
    assert.match(await wrong.text(), /Invalid credentials/);
    assert.doesNotMatch(await (await wrongPassword.fetch('/')).text(), /Log out/);
    assert.equal(passwordHash(ctx.db, user.username), passwordHash(ctx.db, user.username));

    const wrongUserCase = ctx.session();
    const userCase = await wrongUserCase.postForm('/login', {
      username: user.username.toLowerCase(),
      password: user.password,
    });
    assert.equal(userCase.status, 200);
    assert.match(await userCase.text(), /Invalid credentials/);
    assert.equal(user.username.toLowerCase() === user.username, false);
    assert.doesNotMatch(await (await wrongUserCase.fetch('/')).text(), /Log out/);

    const wrongEmailCase = ctx.session();
    const emailCase = await wrongEmailCase.postForm('/login', {
      username: user.email.toLowerCase(),
      password: user.password,
    });
    assert.equal(emailCase.status, 200);
    assert.match(await emailCase.text(), /Invalid credentials/);
    assert.doesNotMatch(await (await wrongEmailCase.fetch('/')).text(), /Log out/);
  });

  test('a SQL-shaped username is stored literally and does not match another account', async () => {
    const normal = await registerUser(ctx, ctx.session());
    const username = `zz' OR '1'='1`;
    const password = 'correct-horse';
    const email = `${ctx.nextId('sql')}@example.test`;
    ctx.users.add(username);
    const created = await ctx.session().postForm('/register', { username, email, password });
    assert.equal(created.status, 302);
    await created.text();
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get(username).n, 1);

    const wrong = ctx.session();
    const wrongLogin = await wrong.postForm('/login', { username, password: 'other-password' });
    assert.match(await wrongLogin.text(), /Invalid credentials/);
    assert.doesNotMatch(await (await wrong.fetch('/')).text(), /Log out/);

    const right = ctx.session();
    const rightLogin = await right.postForm('/login', { username, password });
    assert.equal(rightLogin.status, 302);
    await rightLogin.text();

    const normalLogin = await ctx.session().postForm('/login', {
      username: normal.username,
      password: 'not-the-password',
    });
    assert.match(await normalLogin.text(), /Invalid credentials/);
  });

  test('logout ends only that session, and anonymous logout returns home', async () => {
    const first = ctx.session();
    const user = await registerUser(ctx, first);
    const second = ctx.session();
    const secondLogin = await second.postForm('/login', { username: user.username, password: user.password });
    assert.equal(secondLogin.status, 302);
    await secondLogin.text();

    const loggedOut = await first.fetch('/logout');
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.headers.get('location'), '/');
    await loggedOut.text();
    assert.doesNotMatch(await (await first.fetch('/')).text(), /Log out/);
    assert.match(await (await second.fetch('/')).text(), /Log out/);

    const anon = await ctx.session().fetch('/logout');
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get('location'), '/');
    await anon.text();
  });

  test('a signed-in user is redirected away from login and register', async () => {
    const session = ctx.session();
    await registerUser(ctx, session);
    const login = await session.fetch('/login');
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/');
    await login.text();
    const register = await session.fetch('/register');
    assert.equal(register.status, 302);
    assert.equal(register.headers.get('location'), '/');
    await register.text();
  });

  test('logging in as someone else replaces only that cookie', async () => {
    const usernameA = `Ada${ctx.nextId('S')}`;
    const sessionA = ctx.session();
    const userA = await registerUser(ctx, sessionA, { username: usernameA });
    const kept = ctx.session();
    const keptLogin = await kept.postForm('/login', { username: userA.username, password: userA.password });
    assert.equal(keptLogin.status, 302);
    await keptLogin.text();

    const sessionB = ctx.session();
    const userB = await registerUser(ctx, sessionB, { username: `Bea${ctx.nextId('S')}` });
    const { createRepo } = require('./helpers');
    await createRepo(sessionA, { name: 'vault', description: 'SECRET_SESSION_A', isPrivate: true });

    const switched = await sessionA.postForm('/login', { username: userB.username, password: userB.password });
    assert.equal(switched.status, 302);
    await switched.text();

    const switchedView = await sessionA.fetch(`/@${encodeURIComponent(userA.username)}`);
    assert.equal(switchedView.status, 200);
    assert.equal((await switchedView.text()).includes('SECRET_SESSION_A'), false);

    const keptView = await kept.fetch(`/@${encodeURIComponent(userA.username)}`);
    assert.match(await keptView.text(), /SECRET_SESSION_A/);

    const goodbye = await kept.fetch('/logout');
    await goodbye.text();
    const after = await kept.fetch(`/@${encodeURIComponent(userA.username)}`);
    assert.equal((await after.text()).includes('SECRET_SESSION_A'), false);
  });
});
