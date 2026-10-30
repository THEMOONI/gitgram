const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertUpdatedAtStays,
  barePath,
  basicAuth,
  commitToBare,
  createRepo,
  gitSync,
  passwordHash,
  registerUser,
  repoRow,
  setUpdatedAt,
  start,
  waitForUpdatedAt,
} = require('./helpers');

const FROZEN = '2000-01-01 00:00:00';
const NOTES_BODY = 'NOTES_BODY_z4';
const OUTSIDE_SENTINEL = 'OUTSIDE_README_SENTINEL_z4';

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function commitSymlinkReadme(repoPath, outsideFile) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-readme-link-'));
  try {
    gitSync(['init', '-b', 'main'], { cwd: work });
    gitSync(['config', 'commit.gpgsign', 'false'], { cwd: work });
    gitSync(['config', 'core.fsmonitor', 'false'], { cwd: work });
    gitSync(['config', 'user.email', 'ada@example.com'], { cwd: work });
    gitSync(['config', 'user.name', 'Ada'], { cwd: work });
    fs.writeFileSync(path.join(work, 'notes.txt'), `${NOTES_BODY}\n`);
    fs.symlinkSync(outsideFile, path.join(work, 'README.md'));
    gitSync(['add', '-A'], { cwd: work });
    gitSync(['commit', '-m', 'readme-link'], { cwd: work });
    gitSync(['remote', 'add', 'origin', repoPath], { cwd: work });
    gitSync(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

describe('exact matches and read boundaries', { concurrency: 1 }, () => {
  test('a shorter username, email, or password does not authenticate the longer account', async () => {
    await withApp(async (ctx) => {
      const shortSession = ctx.session();
      const shortPassword = 'sam-secret-k1';
      const shortUser = await registerUser(ctx, shortSession, {
        username: `sam${ctx.nextId('s')}`,
        password: shortPassword,
      });
      const longPassword = 'other-secret-k2';
      const longName = `${shortUser.username}x`;
      const longEmail = `${shortUser.email}.more`;
      const longSession = ctx.session();
      const longUser = await registerUser(ctx, longSession, {
        username: longName,
        email: longEmail,
        password: longPassword,
      });
      assert.ok(longUser.username.startsWith(shortUser.username));
      assert.ok(longUser.email.startsWith(shortUser.email));
      assert.notEqual(shortPassword, longPassword);

      await createRepo(shortSession, { name: 'vault', description: 'SAM_VAULT_z4', isPrivate: true });
      await createRepo(longSession, { name: 'vault', description: 'SAMX_VAULT_z4', isPrivate: true });
      await createRepo(shortSession, { name: 'notes', description: 'SAM_NOTES_z4' });
      const vault = `${shortUser.username}/vault`;
      const notes = `${shortUser.username}/notes`;
      setUpdatedAt(ctx.db, vault, FROZEN);
      setUpdatedAt(ctx.db, notes, FROZEN);
      const shortHash = passwordHash(ctx.db, shortUser.username);
      const longHash = passwordHash(ctx.db, longUser.username);

      const rejected = [
        { username: shortUser.username, password: longPassword },
        { username: longUser.username, password: shortPassword },
        { username: shortUser.email, password: longPassword },
        { username: longUser.email, password: shortPassword },
        { username: shortUser.username, password: 'sam-secret' },
        { username: shortUser.username, password: `${shortPassword}-extra` },
      ];
      for (const fields of rejected) {
        const session = ctx.session();
        const res = await session.postForm('/login', fields);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('location'), null);
        const text = await res.text();
        assert.match(text, /Invalid credentials/);
        assert.equal(text.includes(shortPassword), false);
        assert.equal(text.includes(longPassword), false);
        assert.equal(text.includes(shortHash), false);
        assert.equal(text.includes(longHash), false);
        assert.doesNotMatch(await (await session.fetch('/')).text(), /Log out/);
      }
      assert.equal(passwordHash(ctx.db, shortUser.username), shortHash);
      assert.equal(passwordHash(ctx.db, longUser.username), longHash);

      const pack = `/${shortUser.username}/vault/git-receive-pack`;
      for (const authorization of [
        basicAuth(shortUser.username, longPassword),
        basicAuth(shortUser.username, 'sam-secret'),
        basicAuth(shortUser.username, `${shortPassword}-extra`),
        basicAuth(longUser.username, shortPassword),
      ]) {
        const res = await ctx.session().fetch(pack, {
          method: 'POST',
          headers: { authorization },
          body: '',
        });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Basic realm="GITGRAM"');
        const text = await res.text();
        assert.match(text, /Invalid credentials/);
        assert.equal(text.includes(shortPassword), false);
        assert.equal(text.includes(longPassword), false);
        assert.equal(text.includes(shortHash), false);
        assert.equal(text.includes(longHash), false);
      }
      await assertUpdatedAtStays(ctx.db, vault, FROZEN);
      assert.equal(repoRow(ctx.db, notes).updated_at, FROZEN);

      const asShort = ctx.session();
      const shortLogin = await asShort.postForm('/login', {
        username: shortUser.email,
        password: shortPassword,
      });
      assert.equal(shortLogin.status, 302);
      await shortLogin.text();
      const shortVault = await asShort.fetch(`/${shortUser.username}/vault`);
      assert.equal(shortVault.status, 200);
      const shortHtml = await shortVault.text();
      assert.match(shortHtml, /SAM_VAULT_z4/);
      assert.equal(shortHtml.includes('SAMX_VAULT_z4'), false);
      const otherVault = await asShort.fetch(`/${longUser.username}/vault`);
      assert.equal(otherVault.status, 404);
      assert.equal((await otherVault.text()).includes('SAMX_VAULT_z4'), false);

      const asLong = ctx.session();
      const longLogin = await asLong.postForm('/login', {
        username: longUser.email,
        password: longPassword,
      });
      assert.equal(longLogin.status, 302);
      await longLogin.text();
      const longHtml = await (await asLong.fetch(`/${longUser.username}/vault`)).text();
      assert.match(longHtml, /SAMX_VAULT_z4/);
      assert.equal(longHtml.includes('SAM_VAULT_z4'), false);

      const allowed = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(shortUser.username, shortPassword) },
        body: '',
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('content-type'), 'application/x-git-receive-pack-result');
      const allowedText = await allowed.text();
      assert.equal(allowedText.includes(shortPassword), false);
      assert.equal(allowedText.includes(shortHash), false);
      const refreshed = await waitForUpdatedAt(ctx.db, vault, FROZEN);
      assert.notEqual(refreshed, FROZEN);
      assert.equal(repoRow(ctx.db, notes).updated_at, FROZEN);
      assert.equal(passwordHash(ctx.db, shortUser.username), shortHash);
    });
  });

  test('a failed login keeps the session that was already signed in', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const password = 'keep-session-k3';
      const user = await registerUser(ctx, owner, { password });
      await createRepo(owner, { name: 'vault', description: 'KEEP_VAULT_z3', isPrivate: true });
      const hash = passwordHash(ctx.db, user.username);
      const wrong = 'keep-session-miss';

      const failed = await owner.postForm('/login', { username: user.username, password: wrong });
      assert.equal(failed.status, 200);
      assert.equal(failed.headers.get('location'), null);
      const failedText = await failed.text();
      assert.match(failedText, /Invalid credentials/);
      assert.equal(failedText.includes(wrong), false);
      assert.equal(failedText.includes(password), false);
      assert.equal(failedText.includes(hash), false);

      const home = await (await owner.fetch('/')).text();
      assert.match(home, /Log out/);
      assert.equal(home.includes('KEEP_VAULT_z3'), false);
      const vault = await owner.fetch(`/${user.username}/vault`);
      assert.equal(vault.status, 200);
      assert.match(await vault.text(), /KEEP_VAULT_z3/);
      assert.equal(passwordHash(ctx.db, user.username), hash);

      const stranger = ctx.session();
      const hidden = await stranger.fetch(`/${user.username}/vault`);
      assert.equal(hidden.status, 404);
      assert.equal((await hidden.text()).includes('KEEP_VAULT_z3'), false);
    });
  });

  test('JSON null descriptions stay blank and a numeric privacy flag is stored', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);

      async function createJson(fields) {
        const res = await owner.fetch('/new', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fields),
        });
        const text = await res.text();
        assert.equal(res.status, 302, text.slice(0, 200));
        return res.headers.get('location');
      }

      assert.equal(
        await createJson({ name: 'null-desc', description: null, is_private: 0 }),
        `/${user.username}/null-desc`
      );
      assert.equal(
        await createJson({ name: 'num-private', description: 'NUM_PRIVATE_DESC_z4', is_private: 1 }),
        `/${user.username}/num-private`
      );

      const blank = repoRow(ctx.db, `${user.username}/null-desc`);
      assert.equal(blank.description, '');
      assert.equal(blank.private, 0);
      const hidden = repoRow(ctx.db, `${user.username}/num-private`);
      assert.equal(hidden.description, 'NUM_PRIVATE_DESC_z4');
      assert.equal(hidden.private, 1);

      const page = await (await ctx.session().fetch(`/${user.username}/null-desc`)).text();
      assert.match(page, /null-desc/);
      assert.equal(page.includes('undefined'), false);
      assert.equal(page.includes('>null<'), false);
      assert.equal(page.includes('NUM_PRIVATE_DESC_z4'), false);

      const stranger = ctx.session();
      await registerUser(ctx, stranger);
      const denied = await stranger.fetch(`/${user.username}/num-private`);
      assert.equal(denied.status, 404);
      assert.equal((await denied.text()).includes('NUM_PRIVATE_DESC_z4'), false);

      const found = await (await ctx.session().fetch('/api/search/repos?q=NUM_PRIVATE_DESC_z4')).json();
      assert.deepEqual(found, []);
      const listed = await (await ctx.session().fetch('/api/search/repos?q=null-desc')).json();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].description, '');
      assert.equal(listed[0].private, 0);
      assert.equal(Object.hasOwn(listed[0], 'password'), false);

      const home = await (await ctx.session().fetch('/')).text();
      assert.match(home, /null-desc/);
      assert.equal(home.includes('NUM_PRIVATE_DESC_z4'), false);
      const ownerPage = await (await owner.fetch(`/${user.username}/num-private`)).text();
      assert.match(ownerPage, /NUM_PRIVATE_DESC_z4/);
    });
  });

  test('a symlink readme inlines the link text and not the target bytes', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'linked', description: 'linked readme' });
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-readme-out-'));
      const outsideFile = path.join(outsideDir, 'readme-target-z4.txt');
      try {
        fs.writeFileSync(outsideFile, `${OUTSIDE_SENTINEL}\n`);
        const bare = barePath(user.username, 'linked');
        commitSymlinkReadme(bare, outsideFile);
        const tree = gitSync(['--git-dir', bare, 'ls-tree', 'HEAD']);
        assert.match(tree, /120000 blob \S+\tREADME\.md/);
        assert.match(tree, /100644 blob \S+\tnotes\.txt/);
        const linkText = gitSync(['--git-dir', bare, 'cat-file', '-p', 'HEAD:README.md']);
        assert.match(linkText, /readme-target-z4\.txt/);
        assert.equal(linkText.includes(OUTSIDE_SENTINEL), false);
        assert.equal(linkText.includes(NOTES_BODY), false);

        const page = await (await ctx.session().fetch(`/${user.username}/linked`)).text();
        assert.match(page, /readme-target-z4\.txt/);
        assert.match(page, /notes\.txt/);
        assert.equal(page.includes(OUTSIDE_SENTINEL), false);
        assert.equal(page.includes(NOTES_BODY), false);

        const readme = await ctx.session().fetch(`/${user.username}/linked/blob/main/README.md`);
        assert.equal(readme.status, 200);
        const readmeHtml = await readme.text();
        assert.match(readmeHtml, /readme-target-z4\.txt/);
        assert.equal(readmeHtml.includes(OUTSIDE_SENTINEL), false);
        assert.equal(readmeHtml.includes(NOTES_BODY), false);

        const notes = await (await owner.fetch(`/${user.username}/linked/blob/main/notes.txt`)).text();
        assert.match(notes, new RegExp(NOTES_BODY));
        assert.equal(notes.includes(OUTSIDE_SENTINEL), false);
        assert.equal(notes.includes('readme-target-z4.txt'), false);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  test('blob lines keep an interior blank row and do not split a carriage return twice', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'rows', description: '' });
      commitToBare(barePath(user.username, 'rows'), {
        files: {
          'blank.txt': 'alpha\n\nbeta',
          'crlf.txt': 'alpha\r\nbeta',
        },
        message: 'row-shapes',
      });

      const blank = await (await ctx.session().fetch(`/${user.username}/rows/blob/main/blank.txt`)).text();
      assert.match(blank, /3 lines/);
      assert.match(blank, /class="line-number">1</);
      assert.match(blank, /class="line-number">2</);
      assert.match(blank, /class="line-number">3</);
      assert.equal(blank.includes('class="line-number">4<'), false);
      assert.match(blank, /<pre>alpha<\/pre>/);
      assert.match(blank, /<pre>beta<\/pre>/);
      assert.match(blank, /<pre><\/pre>/);

      const crlf = await (await ctx.session().fetch(`/${user.username}/rows/blob/main/crlf.txt`)).text();
      assert.match(crlf, /2 lines/);
      assert.match(crlf, /class="line-number">1</);
      assert.match(crlf, /class="line-number">2</);
      assert.equal(crlf.includes('class="line-number">3<'), false);
      assert.match(crlf, /alpha/);
      assert.match(crlf, /<pre>beta<\/pre>/);
      assert.equal(crlf.includes(NOTES_BODY), false);
    });
  });

  test('static file requests cannot escape the public directory', async () => {
    await withApp(async (ctx) => {
      const css = await ctx.session().fetch('/css/style.css');
      assert.equal(css.status, 200);
      assert.match(await css.text(), /--bg-primary/);

      const probes = [
        '/css/../../server.js',
        '/js/../../routes/auth.js',
        '/css/../../db/gitgram.db',
        '/css/../../package.json',
        '/%2e%2e/%2e%2e/server.js',
        '/css/%2e%2e/%2e%2e/routes/git.js',
      ];
      for (const pathname of probes) {
        const res = await ctx.session().fetch(pathname);
        const text = await res.text();
        assert.notEqual(res.status, 200, pathname);
        assert.equal(text.includes('openDatabase'), false, pathname);
        assert.equal(text.includes('bcrypt.hashSync'), false, pathname);
        assert.equal(text.includes('gitgram-secret-'), false, pathname);
        assert.equal(text.includes('CREATE TABLE'), false, pathname);
        assert.equal(text.includes('SQLite format 3'), false, pathname);
      }
    });
  });
});
