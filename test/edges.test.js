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
  remoteUrl,
  repoRow,
  runGit,
  setUpdatedAt,
  start,
  waitForUpdatedAt,
} = require('./helpers');

const FROZEN = '2000-01-01 00:00:00';

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

describe('credential and path edges', { concurrency: 1 }, () => {
  test('emails that differ only by case are separate accounts', async () => {
    await withApp(async (ctx) => {
      const stamp = ctx.nextId('e');
      const emailUpper = `Ada.${stamp}@Example.test`;
      const emailLower = emailUpper.toLowerCase();
      assert.notEqual(emailUpper, emailLower);

      const upperSession = ctx.session();
      const upper = await registerUser(ctx, upperSession, {
        username: `Upper${stamp}`,
        email: emailUpper,
        password: 'upper-pass-1',
      });
      const upperHash = passwordHash(ctx.db, upper.username);

      const lowerSession = ctx.session();
      const lower = await registerUser(ctx, lowerSession, {
        username: `Lower${stamp}`,
        email: emailLower,
        password: 'lower-pass-1',
      });
      assert.notEqual(upper.id, lower.id);
      assert.equal(passwordHash(ctx.db, upper.username), upperHash);
      assert.notEqual(passwordHash(ctx.db, lower.username), upperHash);

      const upperAgain = ctx.session();
      const duplicate = await upperAgain.postForm('/register', {
        username: `Other${stamp}`,
        email: emailUpper,
        password: 'replacement-pass',
      });
      assert.equal(duplicate.status, 200);
      assert.match(await duplicate.text(), /User already exists/);
      assert.equal(passwordHash(ctx.db, upper.username), upperHash);
      assert.doesNotMatch(await (await upperAgain.fetch('/')).text(), /Log out/);

      const asUpper = ctx.session();
      const upperLogin = await asUpper.postForm('/login', { username: emailUpper, password: upper.password });
      assert.equal(upperLogin.status, 302);
      await upperLogin.text();
      const upperHome = await (await asUpper.fetch('/')).text();
      assert.match(upperHome, new RegExp(`/@${upper.username}`));
      assert.equal(upperHome.includes(`/@${lower.username}`), false);

      const asLower = ctx.session();
      const lowerLogin = await asLower.postForm('/login', { username: emailLower, password: lower.password });
      assert.equal(lowerLogin.status, 302);
      await lowerLogin.text();
      assert.match(await (await asLower.fetch('/')).text(), new RegExp(`/@${lower.username}`));

      const folded = ctx.session();
      const foldedLogin = await folded.postForm('/login', { username: emailLower, password: upper.password });
      assert.equal(foldedLogin.status, 200);
      assert.match(await foldedLogin.text(), /Invalid credentials/);
      assert.doesNotMatch(await (await folded.fetch('/')).text(), /Log out/);
      assert.equal(passwordHash(ctx.db, upper.username), upperHash);
    });
  });

  test('surrounding whitespace does not authenticate on the web or over git', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      const hash = passwordHash(ctx.db, user.username);
      await createRepo(owner, { name: 'writes', description: '' });
      const fullName = `${user.username}/writes`;
      setUpdatedAt(ctx.db, fullName, FROZEN);

      const attempts = [
        { username: ` ${user.username}`, password: user.password },
        { username: `${user.username} `, password: user.password },
        { username: user.username, password: ` ${user.password}` },
        { username: user.username, password: `${user.password} ` },
        { username: user.username, password: user.password.toUpperCase() },
      ];
      for (const fields of attempts) {
        const session = ctx.session();
        const res = await session.postForm('/login', fields);
        assert.equal(res.status, 200);
        assert.match(await res.text(), /Invalid credentials/);
        assert.doesNotMatch(await (await session.fetch('/')).text(), /Log out/);
      }
      assert.equal(passwordHash(ctx.db, user.username), hash);

      const pack = `/${user.username}/writes/git-receive-pack`;
      for (const authorization of [
        basicAuth(`${user.username} `, user.password),
        basicAuth(user.username, `${user.password} `),
        basicAuth(user.username, user.password.toUpperCase()),
      ]) {
        const res = await ctx.session().fetch(pack, {
          method: 'POST',
          headers: { authorization },
          body: '',
        });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Basic realm="GITGRAM"');
        const text = await res.text();
        assert.equal(text.includes(user.password), false);
        assert.equal(text.includes(hash), false);
      }
      await assertUpdatedAtStays(ctx.db, fullName, FROZEN);
    });
  });

  test('a repository name containing a space stays distinct from the shorter name', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      const spaced = 'spaced name';
      const created = await createRepo(owner, { name: spaced, description: 'space-desc' });
      assert.equal(created.status, 302);

      const fullName = `${user.username}/${spaced}`;
      const row = repoRow(ctx.db, fullName);
      assert.equal(row.name, spaced);
      assert.equal(row.description, 'space-desc');
      assert.equal(row.private, 0);
      assert.equal(fs.existsSync(barePath(user.username, spaced)), true);
      assert.equal(fs.existsSync(barePath(user.username, 'spaced')), false);

      const page = await owner.fetch(`/${encodeURIComponent(user.username)}/${encodeURIComponent(spaced)}`);
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.match(html, /spaced name/);
      assert.match(html, /space-desc/);

      await createRepo(owner, { name: 'spaced', description: 'short-desc' });
      assert.equal(repoRow(ctx.db, `${user.username}/spaced`).description, 'short-desc');
      assert.equal(repoRow(ctx.db, fullName).description, 'space-desc');

      const shortPage = await (await owner.fetch(`/${user.username}/spaced`)).text();
      assert.match(shortPage, /short-desc/);
      assert.equal(shortPage.includes('space-desc'), false);

      const found = await (await ctx.session().fetch(`/api/search/repos?q=${encodeURIComponent(spaced)}`)).json();
      assert.deepEqual(found.map((repo) => repo.name), [spaced]);
      assert.equal(found[0].description, 'space-desc');
    });
  });

  test('a file name containing a space is listed and served as that file', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'docs', description: '' });
      commitToBare(barePath(user.username, 'docs'), {
        files: {
          'my notes.txt': 'SPACE_FILE_BODY\n',
          'notes.txt': 'PLAIN_FILE_BODY\n',
          'my docs/guide.txt': 'NESTED_GUIDE_BODY\n',
        },
        message: 'add spaced names',
      });

      const page = await (await owner.fetch(`/${user.username}/docs`)).text();
      assert.match(page, /my notes\.txt/);
      assert.match(page, /my docs/);
      assert.equal(page.includes('SPACE_FILE_BODY'), false);
      assert.equal(page.includes('PLAIN_FILE_BODY'), false);
      assert.equal(page.includes('NESTED_GUIDE_BODY'), false);
      assert.match(page, /<span>📄<\/span><a href="\/[^"]+\/my notes\.txt"/);
      assert.match(page, /<span><\/span><a href="\/[^"]+\/my docs"/);

      const spaced = await owner.fetch(`/${user.username}/docs/blob/main/${encodeURIComponent('my notes.txt')}`);
      const spacedHtml = await spaced.text();
      assert.equal(spaced.status, 200);
      assert.match(spacedHtml, /SPACE_FILE_BODY/);
      assert.equal(spacedHtml.includes('PLAIN_FILE_BODY'), false);
      assert.equal(spacedHtml.includes('NESTED_GUIDE_BODY'), false);

      const plain = await (await owner.fetch(`/${user.username}/docs/blob/main/notes.txt`)).text();
      assert.match(plain, /PLAIN_FILE_BODY/);
      assert.equal(plain.includes('SPACE_FILE_BODY'), false);

      const directory = await owner.fetch(`/${user.username}/docs/blob/main/${encodeURIComponent('my docs')}`);
      const directoryHtml = await directory.text();
      assert.equal(directory.status, 200);
      assert.match(directoryHtml, /guide\.txt/);
      assert.equal(directoryHtml.includes('NESTED_GUIDE_BODY'), false);
    });
  });

  test('an owner fast-forward push keeps the previous blob and advances HEAD', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'shipped', description: 'history' });
      const fullName = `${user.username}/shipped`;
      commitToBare(barePath(user.username, 'shipped'), {
        files: { 'keep.txt': 'version-one\n' },
        message: 'first-ship',
      });
      const hash1 = gitSync(['--git-dir', barePath(user.username, 'shipped'), 'rev-parse', 'HEAD']).trim();
      setUpdatedAt(ctx.db, fullName, FROZEN);

      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-ff-'));
      try {
        const cloned = await runGit(['clone', remoteUrl(ctx, user.username, 'shipped'), work], { timeout: 20000 });
        assert.equal(cloned.code, 0, cloned.stderr);
        assert.equal(fs.readFileSync(path.join(work, 'keep.txt'), 'utf8'), 'version-one\n');
        await assertUpdatedAtStays(ctx.db, fullName, FROZEN);

        fs.writeFileSync(path.join(work, 'keep.txt'), 'version-two\n');
        for (const args of [
          ['config', 'user.email', 'ada@example.com'],
          ['config', 'user.name', 'Ada'],
          ['config', 'commit.gpgsign', 'false'],
          ['config', 'core.fsmonitor', 'false'],
          ['add', '-A'],
          ['commit', '-m', 'second-ship'],
        ]) {
          const step = await runGit(args, { cwd: work, timeout: 20000 });
          assert.equal(step.code, 0, `${args.join(' ')}: ${step.stderr}`);
        }
        const pushed = await runGit(
          ['push', remoteUrl(ctx, user.username, 'shipped', user.password), 'HEAD:refs/heads/main'],
          { cwd: work, timeout: 20000 }
        );
        assert.equal(pushed.code, 0, pushed.stderr);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }

      const hash2 = gitSync(['--git-dir', barePath(user.username, 'shipped'), 'rev-parse', 'HEAD']).trim();
      assert.notEqual(hash2, hash1);
      const refreshed = await waitForUpdatedAt(ctx.db, fullName, FROZEN);
      assert.notEqual(refreshed, FROZEN);

      const headBlob = await (await owner.fetch(`/${user.username}/shipped/blob/main/keep.txt`)).text();
      assert.match(headBlob, /version-two/);
      assert.equal(headBlob.includes('version-one'), false);

      const oldBlob = await owner.fetch(`/${user.username}/shipped/blob/${hash1}/keep.txt`);
      const oldHtml = await oldBlob.text();
      assert.equal(oldBlob.status, 200);
      assert.match(oldHtml, /version-one/);
      assert.equal(oldHtml.includes('version-two'), false);

      const history = await (await owner.fetch(`/${user.username}/shipped/commits`)).text();
      assert.match(history, /first-ship/);
      assert.match(history, /second-ship/);
    });
  });
});
