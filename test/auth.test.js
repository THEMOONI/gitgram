const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const { createTestContext, registerUser, assertStatus, uid, repoDiskPath } = require('./helpers');

async function withApp(fn) {
  const ctx = await createTestContext();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

test('registration rejects incomplete, short, and duplicate accounts', async () => {
  await withApp(async (ctx) => {
    const anon = ctx.session();

    const missing = await anon.postForm('/register', { username: 'ada', email: '', password: '' });
    assertStatus(missing, 200);
    assert.match(missing.text, /All fields required/);

    const shortName = await anon.postForm('/register', { username: 'ab', email: 'ab@example.com', password: 'long-enough' });
    assertStatus(shortName, 200);
    assert.match(shortName.text, /Username too short/);

    const shortPassword = await anon.postForm('/register', { username: uid('user'), email: uid('mail') + '@example.com', password: '12345' });
    assertStatus(shortPassword, 200);
    assert.match(shortPassword.text, /Password too short/);
    assert.equal(ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('ab'), undefined);

    const minUsername = uid('u').slice(0, 3);
    const minPassword = await registerUser(ctx, { username: minUsername, password: '123456' });
    assertStatus(minPassword.res, 302);
    const minRow = ctx.db.prepare('SELECT password FROM users WHERE username = ?').get(minUsername);
    assert.equal(bcrypt.compareSync('123456', minRow.password), true);

    const username = uid('user');
    const email = username + '@example.com';
    const created = await registerUser(ctx, { username, email, password: 'correct-horse' });
    assertStatus(created.res, 302);
    assert.equal(created.res.headers.get('location'), '/');
    assert.match(created.res.headers.get('set-cookie') || '', /httponly/i);

    const stored = ctx.db.prepare('SELECT password FROM users WHERE username = ?').get(username);
    assert.notEqual(stored.password, 'correct-horse');
    assert.match(stored.password, /^\$2[aby]\$/);

    const duplicateName = await anon.postForm('/register', {
      username,
      email: uid('other') + '@example.com',
      password: 'correct-horse'
    });
    assertStatus(duplicateName, 200);
    assert.match(duplicateName.text, /User already exists/);

    const duplicateEmail = await anon.postForm('/register', {
      username: uid('other'),
      email,
      password: 'correct-horse'
    });
    assertStatus(duplicateEmail, 200);
    assert.match(duplicateEmail.text, /User already exists/);

    const count = ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ? OR email = ?').get(username, email).n;
    assert.equal(count, 1);
  });
});

test('login accepts username or email and rejects bad credentials', async () => {
  await withApp(async (ctx) => {
    const account = await registerUser(ctx, { username: 'Ada' + uid('U'), password: 'correct-horse' });

    const fresh = ctx.session();
    const blank = await fresh.postForm('/login', { username: '', password: '' });
    assertStatus(blank, 200);
    assert.match(blank.text, /Invalid credentials/);

    const emptyPassword = await fresh.postForm('/login', { username: account.username, password: '' });
    assertStatus(emptyPassword, 200);
    assert.match(emptyPassword.text, /Invalid credentials/);

    const wrong = await fresh.postForm('/login', { username: account.username, password: 'incorrect-password' });
    assertStatus(wrong, 200);
    assert.match(wrong.text, /Invalid credentials/);

    const wrongCase = await fresh.postForm('/login', { username: account.username.toLowerCase(), password: account.password });
    assertStatus(wrongCase, 200);
    assert.match(wrongCase.text, /Invalid credentials/);

    const injection = await ctx.session().postForm('/login', { username: "' OR '1'='1", password: 'correct-horse' });
    assertStatus(injection, 200);
    assert.match(injection.text, /Invalid credentials/);

    const byName = ctx.session();
    const nameLogin = await byName.postForm('/login', { username: account.username, password: account.password });
    assertStatus(nameLogin, 302);
    assert.equal(nameLogin.headers.get('location'), '/');
    const home = await byName.fetch('/');
    assertStatus(home, 200);
    assert.match(home.text, new RegExp('/@' + account.username));

    const byEmail = ctx.session();
    const emailLogin = await byEmail.postForm('/login', { username: account.email, password: account.password });
    assertStatus(emailLogin, 302);
    const emailHome = await byEmail.fetch('/');
    assert.match(emailHome.text, new RegExp('/@' + account.username));

    const stillOut = await fresh.fetch('/');
    assert.match(stillOut.text, /Start for free/);
    assert.doesNotMatch(stillOut.text, new RegExp('/@' + account.username));
  });
});

test('logout ends the session and blocks owner actions', async () => {
  await withApp(async (ctx) => {
    const account = await registerUser(ctx);
    const created = await account.session.postForm('/new', { name: 'kept', description: 'still here' });
    assertStatus(created, 302);
    const disk = repoDiskPath(account.username, 'kept');
    const fullName = account.username + '/kept';

    const before = await account.session.fetch('/');
    assert.match(before.text, new RegExp('/@' + account.username));

    const registerPage = await account.session.fetch('/register');
    assertStatus(registerPage, 302);
    assert.equal(registerPage.headers.get('location'), '/');

    const loginPage = await account.session.fetch('/login');
    assertStatus(loginPage, 302);
    assert.equal(loginPage.headers.get('location'), '/');

    const loggedOut = await account.session.fetch('/logout');
    assertStatus(loggedOut, 302);

    const after = await account.session.fetch('/');
    assertStatus(after, 200);
    assert.doesNotMatch(after.text, new RegExp('/@' + account.username));
    assert.match(after.text, /Start for free/);

    const denied = await account.session.postForm('/' + fullName + '/settings/delete', {});
    assertStatus(denied, 403);
    assert.equal(fs.existsSync(disk), true);
    assert.equal(ctx.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName) != null, true);
  });
});
