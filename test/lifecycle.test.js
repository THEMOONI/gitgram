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
  pushFiles,
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

function headOf(username, repo) {
  return gitSync(['--git-dir', barePath(username, repo), 'rev-parse', 'HEAD']).trim();
}

describe('repository lifecycle and history boundaries', { concurrency: 1 }, () => {
  test('deleting a repository lets the same name start empty without touching a sibling', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'kit', description: 'OLD_DESC_TOKEN_z2' });
      await createRepo(owner, { name: 'sibling', description: 'SIBLING_DESC_TOKEN_z2' });
      const kit = barePath(user.username, 'kit');
      const hashes = commitToBare(kit, {
        files: { 'secret.txt': 'OLD_SECRET_z2\n' },
        message: 'old-ship-z2',
      });
      commitToBare(kit, {
        branch: 'dev',
        files: { 'dev.txt': 'DEV_SECRET_z2\n' },
        message: 'dev-ship-z2',
      });
      commitToBare(barePath(user.username, 'sibling'), {
        files: { 'keep.txt': 'SIBLING_BODY_z2\n' },
        message: 'sibling-ship-z2',
      });
      const oldHead = hashes[0];
      const siblingHead = headOf(user.username, 'sibling');

      const removed = await owner.postForm(`/${user.username}/kit/settings/delete`, {});
      assert.equal(removed.status, 302);
      assert.equal(removed.headers.get('location'), `/@${user.username}`);
      assert.equal(repoRow(ctx.db, `${user.username}/kit`), undefined);
      assert.equal(fs.existsSync(kit), false);
      assert.equal(repoRow(ctx.db, `${user.username}/sibling`).description, 'SIBLING_DESC_TOKEN_z2');

      const gone = await owner.fetch(`/${user.username}/kit`);
      assert.equal(gone.status, 404);
      assert.equal((await gone.text()).includes('OLD_SECRET_z2'), false);
      const oldSearch = await (await ctx.session().fetch('/api/search/repos?q=OLD_DESC_TOKEN_z2')).json();
      assert.deepEqual(oldSearch, []);

      await createRepo(owner, { name: 'kit', description: 'NEW_DESC_TOKEN_z2' });
      const row = repoRow(ctx.db, `${user.username}/kit`);
      assert.equal(row.description, 'NEW_DESC_TOKEN_z2');
      assert.equal(row.private, 0);
      assert.equal(gitSync(['--git-dir', kit, 'symbolic-ref', 'HEAD']).trim(), 'refs/heads/main');
      assert.throws(() => gitSync(['--git-dir', kit, 'rev-parse', 'refs/heads/dev']));
      assert.throws(() => gitSync(['--git-dir', kit, 'cat-file', '-t', oldHead]));

      const page = await (await owner.fetch(`/${user.username}/kit`)).text();
      assert.match(page, /NEW_DESC_TOKEN_z2/);
      assert.match(page, /Quick setup/);
      assert.equal(page.includes('OLD_SECRET_z2'), false);
      assert.equal(page.includes('DEV_SECRET_z2'), false);
      assert.equal(page.includes('old-ship-z2'), false);
      assert.equal(page.includes('OLD_DESC_TOKEN_z2'), false);

      const blob = await owner.fetch(`/${user.username}/kit/blob/main/secret.txt`);
      assert.equal(blob.status, 404);
      assert.equal((await blob.text()).includes('OLD_SECRET_z2'), false);
      const devBlob = await owner.fetch(`/${user.username}/kit/blob/dev/dev.txt`);
      assert.equal(devBlob.status, 404);
      assert.equal((await devBlob.text()).includes('DEV_SECRET_z2'), false);
      const history = await (await owner.fetch(`/${user.username}/kit/commits`)).text();
      assert.match(history, /No commits yet/);
      assert.equal(history.includes('old-ship-z2'), false);
      assert.equal(history.includes('dev-ship-z2'), false);

      const refs = await (await ctx.session().fetch(`/${user.username}/kit/info/refs?service=git-upload-pack`)).text();
      assert.equal(refs.includes(oldHead), false);
      const sibling = await (await ctx.session().fetch(`/${user.username}/sibling`)).text();
      assert.match(sibling, /keep\.txt/);
      assert.match(sibling, /sibling-ship-z2/);
      assert.equal(sibling.includes('OLD_SECRET_z2'), false);
      assert.equal(sibling.includes('DEV_SECRET_z2'), false);
      const siblingBlob = await (await ctx.session().fetch(`/${user.username}/sibling/blob/main/keep.txt`)).text();
      assert.match(siblingBlob, /SIBLING_BODY_z2/);
      assert.equal(headOf(user.username, 'sibling'), siblingHead);
      const found = await (await ctx.session().fetch('/api/search/repos?q=DESC_TOKEN_z2')).json();
      assert.deepEqual(found.map((repo) => repo.description).sort(), ['NEW_DESC_TOKEN_z2', 'SIBLING_DESC_TOKEN_z2']);
    });
  });

  test('a deleted account can be registered again and its leftover files are not served', async () => {
    await withApp(async (ctx) => {
      const username = ctx.nextId('reuse');
      const email = `${username}@example.test`;
      const firstSession = ctx.session();
      const first = await registerUser(ctx, firstSession, { username, email, password: 'old-horse-pass' });
      await createRepo(firstSession, { name: 'vault', description: 'ORPHAN_DESC_z5', isPrivate: true });
      const bare = barePath(username, 'vault');
      commitToBare(bare, {
        files: { 'secret.txt': 'ORPHAN_BYTES_z5\n' },
        message: 'orphan-ship-z5',
      });
      const head = headOf(username, 'vault');
      const firstHash = passwordHash(ctx.db, username);

      ctx.db.prepare('DELETE FROM users WHERE id = ?').run(first.id);
      assert.equal(repoRow(ctx.db, `${username}/vault`), undefined);
      assert.equal(ctx.db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email), undefined);
      if (fs.existsSync(bare)) assert.equal(headOf(username, 'vault'), head);

      const hidden = await ctx.session().fetch(`/${username}/vault`);
      assert.equal(hidden.status, 404);
      assert.equal((await hidden.text()).includes('ORPHAN_BYTES_z5'), false);
      const refs = await ctx.session().fetch(`/${username}/vault/info/refs?service=git-upload-pack`);
      assert.equal(refs.status, 404);
      const refsText = await refs.text();
      assert.equal(refsText.includes(head), false);
      assert.equal(refsText.includes('ORPHAN_BYTES_z5'), false);
      const upload = await ctx.session().fetch(`/${username}/vault/git-upload-pack`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-git-upload-pack-request' },
        body: '0000',
      });
      assert.equal(upload.status, 404);
      assert.equal((await upload.text()).includes('ORPHAN_BYTES_z5'), false);

      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-orphan-'));
      try {
        const cloned = await runGit(['clone', remoteUrl(ctx, username, 'vault'), dest], { timeout: 20000 });
        assert.notEqual(cloned.code, 0);
        assert.equal(fs.existsSync(path.join(dest, 'secret.txt')), false);
      } finally {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      assert.equal(repoRow(ctx.db, `${username}/vault`), undefined);
      if (fs.existsSync(bare)) assert.equal(headOf(username, 'vault'), head);

      const oldLogin = await ctx.session().postForm('/login', { username, password: 'old-horse-pass' });
      assert.equal(oldLogin.status, 200);
      assert.match(await oldLogin.text(), /Invalid credentials/);

      const secondSession = ctx.session();
      const second = await registerUser(ctx, secondSession, { username, email, password: 'new-horse-pass' });
      assert.notEqual(second.id, first.id);
      assert.notEqual(passwordHash(ctx.db, username), firstHash);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get(username).n, 1);
      const profile = await (await secondSession.fetch(`/@${username}`)).text();
      assert.match(profile, /No repositories yet/);
      assert.equal(profile.includes('ORPHAN_DESC_z5'), false);
      assert.equal(profile.includes('ORPHAN_BYTES_z5'), false);

      const pack = await secondSession.fetch(`/${username}/vault/git-receive-pack`, {
        method: 'POST',
        headers: { authorization: basicAuth(username, 'new-horse-pass') },
        body: '',
      });
      assert.equal(pack.status, 404);
      assert.equal((await pack.text()).includes('ORPHAN_BYTES_z5'), false);
      if (fs.existsSync(bare)) assert.equal(headOf(username, 'vault'), head);
      assert.equal(repoRow(ctx.db, `${username}/vault`), undefined);

      await createRepo(secondSession, { name: 'fresh', description: 'FRESH_DESC_z5' });
      const created = repoRow(ctx.db, `${username}/fresh`);
      assert.equal(created.owner_id, second.id);
      assert.equal(created.description, 'FRESH_DESC_z5');
      const denied = await firstSession.postForm(`/${username}/fresh/settings/delete`, {});
      assert.equal(denied.status, 403);
      assert.equal(repoRow(ctx.db, `${username}/fresh`).description, 'FRESH_DESC_z5');
      assert.equal(fs.existsSync(barePath(username, 'fresh')), true);

      const emailLogin = ctx.session();
      const accepted = await emailLogin.postForm('/login', { username: email, password: 'new-horse-pass' });
      assert.equal(accepted.status, 302);
      assert.equal(accepted.headers.get('location'), '/');
      const rejected = await ctx.session().postForm('/login', { username: email, password: 'old-horse-pass' });
      assert.equal(rejected.status, 200);
      assert.match(await rejected.text(), /Invalid credentials/);
      const home = await (await emailLogin.fetch('/')).text();
      assert.match(home, new RegExp(`href="/@${username}"`));
      assert.match(home, /Log out/);
    });
  });

  test('an owner force-push replaces history and a stranger force-push does not', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      const stranger = ctx.session();
      const other = await registerUser(ctx, stranger);
      await createRepo(owner, { name: 'rewritten', description: 'history' });
      const bare = barePath(user.username, 'rewritten');
      commitToBare(bare, {
        files: { 'keep.txt': 'KEEP_BODY_z1\n' },
        message: 'first-ship-z1',
      });
      const original = headOf(user.username, 'rewritten');
      const fullName = `${user.username}/rewritten`;
      setUpdatedAt(ctx.db, fullName, FROZEN);

      const pushed = await pushFiles({
        url: remoteUrl(ctx, user.username, 'rewritten', user.password),
        files: { 'other.txt': 'REPLACEMENT_z1\n' },
        message: 'rewrite-ship-z1',
        force: true,
      });
      assert.equal(pushed.code, 0, pushed.stderr);
      const rewritten = headOf(user.username, 'rewritten');
      assert.notEqual(rewritten, original);
      const refreshed = await waitForUpdatedAt(ctx.db, fullName, FROZEN);
      assert.notEqual(refreshed, FROZEN);
      assert.equal(gitSync(['--git-dir', bare, 'show', 'HEAD:other.txt']), 'REPLACEMENT_z1\n');
      assert.throws(() => gitSync(['--git-dir', bare, 'show', 'HEAD:keep.txt']));

      const blob = await owner.fetch(`/${user.username}/rewritten/blob/main/other.txt`);
      assert.equal(blob.status, 200);
      assert.match(await blob.text(), /REPLACEMENT_z1/);
      const gone = await owner.fetch(`/${user.username}/rewritten/blob/main/keep.txt`);
      assert.equal(gone.status, 404);
      assert.equal((await gone.text()).includes('KEEP_BODY_z1'), false);
      const history = await (await owner.fetch(`/${user.username}/rewritten/commits`)).text();
      assert.match(history, /rewrite-ship-z1/);
      assert.equal(history.includes('first-ship-z1'), false);
      const page = await (await ctx.session().fetch(`/${user.username}/rewritten`)).text();
      assert.match(page, /rewrite-ship-z1/);
      assert.match(page, /other\.txt/);
      assert.equal(page.includes('KEEP_BODY_z1'), false);
      assert.equal(page.includes('first-ship-z1'), false);

      setUpdatedAt(ctx.db, fullName, FROZEN);
      const attack = await pushFiles({
        url: `http://${encodeURIComponent(other.username)}:${encodeURIComponent(other.password)}@127.0.0.1:${ctx.port}/${encodeURIComponent(user.username)}/rewritten.git`,
        files: { 'other.txt': 'PWNED_BODY_z1\n' },
        message: 'stranger-rewrite-z1',
        force: true,
      });
      assert.notEqual(attack.code, 0);
      await assertUpdatedAtStays(ctx.db, fullName, FROZEN);
      assert.equal(headOf(user.username, 'rewritten'), rewritten);
      const still = await (await owner.fetch(`/${user.username}/rewritten/blob/main/other.txt`)).text();
      assert.match(still, /REPLACEMENT_z1/);
      assert.equal(still.includes('PWNED_BODY_z1'), false);
      const commits = await (await owner.fetch(`/${user.username}/rewritten/commits`)).text();
      assert.match(commits, /rewrite-ship-z1/);
      assert.equal(commits.includes('stranger-rewrite-z1'), false);
    });
  });

  test('history shows the subject and author, not the body or committer', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'subjects', description: '' });
      commitToBare(barePath(user.username, 'subjects'), {
        files: { 'notes.txt': 'SUBJECT_FILE_z4\n' },
        message: 'subject-line-z4',
        body: 'BODY_ONLY_z4 stays off the page',
        author: 'AuthorZed',
        email: 'hidden-body-z4@example.test',
        committer: 'CommitterZed',
        committerEmail: 'committer-body-z4@example.test',
      });

      const history = await (await owner.fetch(`/${user.username}/subjects/commits`)).text();
      assert.match(history, /subject-line-z4/);
      assert.match(history, /AuthorZed/);
      assert.equal(history.includes('BODY_ONLY_z4'), false);
      assert.equal(history.includes('CommitterZed'), false);
      assert.equal(history.includes('hidden-body-z4@example.test'), false);
      assert.equal(history.includes('committer-body-z4@example.test'), false);

      const page = await (await ctx.session().fetch(`/${user.username}/subjects`)).text();
      assert.match(page, /subject-line-z4/);
      assert.match(page, /notes\.txt/);
      assert.equal(page.includes('BODY_ONLY_z4'), false);
      assert.equal(page.includes('CommitterZed'), false);
      assert.equal(page.includes('SUBJECT_FILE_z4'), false);
      const blob = await (await owner.fetch(`/${user.username}/subjects/blob/main/notes.txt`)).text();
      assert.match(blob, /SUBJECT_FILE_z4/);
    });
  });

  test('a case-variant readme is inlined and nested or outside paths are not served as that file', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'cased', description: '' });
      commitToBare(barePath(user.username, 'cased'), {
        files: {
          'ReadMe.TXT': 'README_CASE_BODY_z8\n',
          'notes.txt': 'NOTES_CASE_BODY_z8\n',
          'docs/secret.txt': 'NESTED_SECRET_z8\n',
        },
        message: 'case-ship-z8',
      });
      const outside = path.join(os.tmpdir(), `gitgram-outside-${ctx.nextId('out')}.txt`);
      fs.writeFileSync(outside, 'OUTSIDE_SENTINEL_z8\n');
      try {
        const page = await (await owner.fetch(`/${user.username}/cased`)).text();
        assert.match(page, /README_CASE_BODY_z8/);
        assert.match(page, /ReadMe\.TXT/);
        assert.match(page, /notes\.txt/);
        assert.match(page, />docs</);
        assert.equal(page.includes('NOTES_CASE_BODY_z8'), false);
        assert.equal(page.includes('NESTED_SECRET_z8'), false);
        assert.equal(page.includes('OUTSIDE_SENTINEL_z8'), false);

        const directory = await owner.fetch(`/${user.username}/cased/blob/main/docs`);
        const directoryHtml = await directory.text();
        assert.equal(directory.status, 200);
        assert.match(directoryHtml, /secret\.txt/);
        assert.equal(directoryHtml.includes('NESTED_SECRET_z8'), false);

        const nested = await owner.fetch(`/${user.username}/cased/blob/main/docs/secret.txt`);
        const nestedHtml = await nested.text();
        assert.notEqual(nested.status, 200);
        assert.equal(nestedHtml.includes('NESTED_SECRET_z8'), false);
        assert.equal(nestedHtml.includes('README_CASE_BODY_z8'), false);

        const encoded = await owner.fetch(`/${user.username}/cased/blob/main/${encodeURIComponent('docs/secret.txt')}`);
        const encodedHtml = await encoded.text();
        assert.equal(encodedHtml.includes('OUTSIDE_SENTINEL_z8'), false);
        assert.equal(encodedHtml.includes('NOTES_CASE_BODY_z8'), false);
        const escapePath = encodeURIComponent(`../../../../${outside}`);
        const escaped = await owner.fetch(`/${user.username}/cased/blob/main/${escapePath}`);
        assert.equal((await escaped.text()).includes('OUTSIDE_SENTINEL_z8'), false);

        const readme = await (await owner.fetch(`/${user.username}/cased/blob/main/ReadMe.TXT`)).text();
        assert.match(readme, /README_CASE_BODY_z8/);
        assert.equal(readme.includes('NOTES_CASE_BODY_z8'), false);
      } finally {
        fs.rmSync(outside, { force: true });
      }
    });
  });

  test('a repository row with no directory does not serve or copy a sibling', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'gone', description: 'GONE_DESC_z6' });
      await createRepo(owner, { name: 'kept', description: 'KEPT_DESC_z6' });
      commitToBare(barePath(user.username, 'gone'), {
        files: { 'notes.txt': 'GONE_BYTES_z6\n' },
        message: 'gone-ship-z6',
      });
      commitToBare(barePath(user.username, 'kept'), {
        files: { 'notes.txt': 'KEPT_BYTES_z6\n' },
        message: 'kept-ship-z6',
      });
      const keptHead = headOf(user.username, 'kept');
      setUpdatedAt(ctx.db, `${user.username}/kept`, FROZEN);
      fs.rmSync(barePath(user.username, 'gone'), { recursive: true, force: true });
      assert.equal(repoRow(ctx.db, `${user.username}/gone`).description, 'GONE_DESC_z6');

      const refs = await ctx.session().fetch(`/${user.username}/gone/info/refs?service=git-upload-pack`);
      assert.equal(refs.status, 404);
      assert.match(await refs.text(), /Not found/);

      const upload = await ctx.session().fetch(`/${user.username}/gone/git-upload-pack`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-git-upload-pack-request' },
        body: '0000',
      });
      const uploadText = await upload.text();
      assert.equal(uploadText.includes('GONE_BYTES_z6'), false);
      assert.equal(uploadText.includes('KEPT_BYTES_z6'), false);

      const pack = await owner.fetch(`/${user.username}/gone/git-receive-pack`, {
        method: 'POST',
        headers: { authorization: basicAuth(user.username, user.password) },
        body: '',
      });
      const packText = await pack.text();
      assert.equal(packText.includes('KEPT_BYTES_z6'), false);
      assert.equal(packText.includes('GONE_BYTES_z6'), false);
      assert.equal(fs.existsSync(path.join(barePath(user.username, 'gone'), 'notes.txt')), false);

      await assertUpdatedAtStays(ctx.db, `${user.username}/kept`, FROZEN);
      assert.equal(headOf(user.username, 'kept'), keptHead);
      const kept = await (await ctx.session().fetch(`/${user.username}/kept/blob/main/notes.txt`)).text();
      assert.match(kept, /KEPT_BYTES_z6/);
      assert.equal(kept.includes('GONE_BYTES_z6'), false);
      assert.equal(repoRow(ctx.db, `${user.username}/kept`).description, 'KEPT_DESC_z6');
    });
  });

  test('static assets are served and application files are not', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const css = await session.fetch('/css/style.css');
      assert.equal(css.status, 200);
      assert.match(await css.text(), /--bg-primary/);
      const js = await session.fetch('/js/app.js');
      assert.equal(js.status, 200);
      assert.match(await js.text(), /searchInput/);

      for (const pathname of ['/server.js', '/routes/auth.js', '/routes/git.js', '/db/gitgram.db', '/package.json']) {
        const res = await session.fetch(pathname);
        const text = await res.text();
        assert.equal(text.includes('openDatabase'), false, pathname);
        assert.equal(text.includes('CREATE TABLE'), false, pathname);
        assert.equal(text.includes('SQLite format 3'), false, pathname);
        assert.equal(text.includes('gitgram-secret-'), false, pathname);
        assert.equal(text.includes('bcrypt.hashSync'), false, pathname);
      }
    });
  });
});
