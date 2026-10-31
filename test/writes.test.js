const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertUpdatedAtStays,
  barePath,
  commitToBare,
  createRepo,
  gitSync,
  insertRepo,
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

function strangerRemote(ctx, ownerName, repo, authUser, password) {
  return `http://${encodeURIComponent(authUser)}:${encodeURIComponent(password)}@127.0.0.1:${ctx.port}/${encodeURIComponent(ownerName)}/${encodeURIComponent(repo)}.git`;
}

describe('readme selection, ref updates, and on-site redirects', { concurrency: 1 }, () => {
  test('only an anchored root readme is inlined, and the owner alone sees settings', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'readme-pick', description: 'shown' });
      commitToBare(barePath(user.username, 'readme-pick'), {
        files: {
          'README.markdown': 'MARKDOWN_README_BODY\n',
          'my-readme.md': 'MY_README_BODY\n',
          'reading.txt': 'READING_BODY\n',
          'notes.txt': 'NOTES_BODY\n',
          'docs/README.md': 'NESTED_README_BODY\n',
        },
        message: 'add-readmes',
      });

      const page = await (await owner.fetch(`/${user.username}/readme-pick`)).text();
      assert.match(page, /readme-content/);
      assert.match(page, /MARKDOWN_README_BODY/);
      assert.equal(page.includes('MY_README_BODY'), false);
      assert.equal(page.includes('READING_BODY'), false);
      assert.equal(page.includes('NOTES_BODY'), false);
      assert.equal(page.includes('NESTED_README_BODY'), false);
      assert.match(page, /my-readme\.md/);
      assert.match(page, /reading\.txt/);
      assert.match(page, /<span><\/span><a href="\/[^"]+\/docs"/);
      assert.doesNotMatch(page, /<span>📄<\/span><a href="\/[^"]+\/docs"/);
      assert.match(page, new RegExp(`/${user.username}/readme-pick/settings`));

      const anon = await (await ctx.session().fetch(`/${user.username}/readme-pick`)).text();
      assert.match(anon, /MARKDOWN_README_BODY/);
      assert.equal(anon.includes(`/${user.username}/readme-pick/settings`), false);
      assert.equal(anon.includes('NESTED_README_BODY'), false);
    });
  });

  test('an empty commit remains in history after a later file is added', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'empty-then', description: '' });
      const bare = barePath(user.username, 'empty-then');
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-empty-'));
      try {
        gitSync(['init', '-b', 'main'], { cwd: work });
        gitSync(['config', 'commit.gpgsign', 'false'], { cwd: work });
        gitSync(['config', 'core.fsmonitor', 'false'], { cwd: work });
        gitSync(['config', 'user.email', 'ada@example.com'], { cwd: work });
        gitSync(['config', 'user.name', 'Ada'], { cwd: work });
        gitSync(['commit', '--allow-empty', '-m', 'empty-ship'], { cwd: work });
        gitSync(['remote', 'add', 'origin', bare], { cwd: work });
        gitSync(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work });
        fs.writeFileSync(path.join(work, 'README.md'), 'AFTER_EMPTY_BODY\n');
        gitSync(['add', '-A'], { cwd: work });
        gitSync(['commit', '-m', 'file-ship'], { cwd: work });
        gitSync(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work });
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }

      const history = await (await owner.fetch(`/${user.username}/empty-then/commits`)).text();
      assert.match(history, /empty-ship/);
      assert.match(history, /file-ship/);

      const page = await (await owner.fetch(`/${user.username}/empty-then`)).text();
      assert.match(page, /AFTER_EMPTY_BODY/);
      assert.match(page, /file-ship/);
      assert.match(page, /empty-ship/);
    });
  });

  test('a trailing newline is its own displayed line', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'newline', description: '' });
      commitToBare(barePath(user.username, 'newline'), {
        files: { 'count.txt': 'alpha\n' },
        message: 'trailing',
      });

      const html = await (await ctx.session().fetch(`/${user.username}/newline/blob/main/count.txt`)).text();
      assert.match(html, /2 lines/);
      assert.match(html, /class="line-number">1</);
      assert.match(html, /class="line-number">2</);
      assert.equal(html.includes('class="line-number">3<'), false);
      assert.match(html, /<pre>alpha<\/pre>/);
    });
  });

  test('login, registration, and delete ignore an off-site next URL', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'stay-here', description: 'keep-desc' });
      const offsite = 'https://evil.example/phish';

      const wrong = await ctx.session().postForm(`/login?next=${encodeURIComponent(offsite)}`, {
        username: user.username,
        password: 'not-the-password',
        next: offsite,
      });
      const wrongHtml = await wrong.text();
      assert.equal(wrong.status, 200);
      assert.equal(wrong.headers.get('location'), null);
      assert.match(wrongHtml, /Invalid credentials/);
      assert.equal(wrongHtml.includes(offsite), false);

      const signedIn = await ctx.session().postForm(`/login?next=${encodeURIComponent(offsite)}`, {
        username: user.username,
        password: user.password,
        next: offsite,
      });
      assert.equal(signedIn.status, 302);
      assert.equal(signedIn.headers.get('location'), '/');
      await signedIn.text();

      const created = await ctx.session().postForm(`/register?next=${encodeURIComponent(offsite)}`, {
        username: ctx.nextId('new'),
        email: `${ctx.nextId('mail')}@example.test`,
        password: 'correct-horse',
        next: offsite,
      });
      assert.equal(created.status, 302);
      assert.equal(created.headers.get('location'), '/');
      await created.text();

      const removed = await owner.fetch(
        `/${user.username}/stay-here/settings/delete?next=${encodeURIComponent(offsite)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ next: offsite, return: offsite }).toString(),
        }
      );
      assert.equal(removed.status, 302);
      assert.equal(removed.headers.get('location'), `/@${user.username}`);
      assert.equal(String(removed.headers.get('location')).includes('evil.example'), false);
      await removed.text();
      assert.equal(repoRow(ctx.db, `${user.username}/stay-here`), undefined);
    });
  });

  test('posting to settings does not rewrite or delete the repository', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'frozen-meta', description: 'original-desc' });
      const fullName = `${user.username}/frozen-meta`;
      commitToBare(barePath(user.username, 'frozen-meta'), {
        files: { 'keep.txt': 'KEEP_BODY\n' },
        message: 'keep-ship',
      });
      const head = gitSync(['--git-dir', barePath(user.username, 'frozen-meta'), 'rev-parse', 'HEAD']).trim();

      const posted = await owner.postForm(`/${user.username}/frozen-meta/settings`, {
        description: 'rewritten-desc',
        is_private: '1',
        name: 'renamed',
      });
      assert.equal(posted.status, 404);
      await posted.text();

      const row = repoRow(ctx.db, fullName);
      assert.equal(row.description, 'original-desc');
      assert.equal(row.private, 0);
      assert.equal(row.name, 'frozen-meta');
      assert.equal(gitSync(['--git-dir', barePath(user.username, 'frozen-meta'), 'rev-parse', 'HEAD']).trim(), head);
      const blob = await (await owner.fetch(`/${user.username}/frozen-meta/blob/main/keep.txt`)).text();
      assert.match(blob, /KEEP_BODY/);
    });
  });

  test('an owner can publish and remove a side branch without moving main', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      const strangerSession = ctx.session();
      const stranger = await registerUser(ctx, strangerSession);
      await createRepo(owner, { name: 'branched', description: 'public branch' });
      const bare = barePath(user.username, 'branched');
      const fullName = `${user.username}/branched`;
      commitToBare(bare, {
        files: { 'keep.txt': 'MAIN_BODY\n' },
        message: 'main-ship',
      });
      const mainHash = gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim();
      setUpdatedAt(ctx.db, fullName, FROZEN);

      const strangerUrl = strangerRemote(ctx, user.username, 'branched', stranger.username, stranger.password);
      const attack = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-attack-'));
      try {
        gitSync(['init', '-b', 'main'], { cwd: attack });
        gitSync(['config', 'commit.gpgsign', 'false'], { cwd: attack });
        gitSync(['config', 'core.fsmonitor', 'false'], { cwd: attack });
        gitSync(['config', 'user.email', 'ada@example.com'], { cwd: attack });
        gitSync(['config', 'user.name', 'Ada'], { cwd: attack });
        fs.writeFileSync(path.join(attack, 'feature.txt'), 'STRANGER_BODY\n');
        gitSync(['add', '-A'], { cwd: attack });
        gitSync(['commit', '-m', 'stranger-ship'], { cwd: attack });
        const deniedCreate = await runGit(['push', strangerUrl, 'HEAD:refs/heads/feature'], { cwd: attack, timeout: 20000 });
        assert.notEqual(deniedCreate.code, 0);
      } finally {
        fs.rmSync(attack, { recursive: true, force: true });
      }
      const missingFeature = await runGit(['--git-dir', bare, 'rev-parse', '--verify', 'refs/heads/feature']);
      assert.notEqual(missingFeature.code, 0);
      await assertUpdatedAtStays(ctx.db, fullName, FROZEN);

      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-branch-'));
      try {
        const cloned = await runGit(['clone', remoteUrl(ctx, user.username, 'branched'), work], { timeout: 20000 });
        assert.equal(cloned.code, 0, cloned.stderr);
        await assertUpdatedAtStays(ctx.db, fullName, FROZEN);
        for (const args of [
          ['checkout', '-b', 'feature'],
          ['config', 'user.email', 'ada@example.com'],
          ['config', 'user.name', 'Ada'],
          ['config', 'commit.gpgsign', 'false'],
          ['config', 'core.fsmonitor', 'false'],
        ]) {
          const step = await runGit(args, { cwd: work, timeout: 20000 });
          assert.equal(step.code, 0, `${args.join(' ')}: ${step.stderr}`);
        }
        fs.writeFileSync(path.join(work, 'feature.txt'), 'FEATURE_BODY\n');
        fs.rmSync(path.join(work, 'keep.txt'));
        for (const args of [
          ['add', '-A'],
          ['commit', '-m', 'feature-ship'],
        ]) {
          const step = await runGit(args, { cwd: work, timeout: 20000 });
          assert.equal(step.code, 0, `${args.join(' ')}: ${step.stderr}`);
        }
        const pushed = await runGit(
          ['push', remoteUrl(ctx, user.username, 'branched', user.password), 'HEAD:refs/heads/feature'],
          { cwd: work, timeout: 20000 }
        );
        assert.equal(pushed.code, 0, pushed.stderr);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }

      assert.equal(gitSync(['--git-dir', bare, 'rev-parse', 'refs/heads/main']).trim(), mainHash);
      const featureHash = gitSync(['--git-dir', bare, 'rev-parse', 'refs/heads/feature']).trim();
      assert.notEqual(featureHash, mainHash);
      const refreshed = await waitForUpdatedAt(ctx.db, fullName, FROZEN);
      assert.notEqual(refreshed, FROZEN);

      const mainBlob = await (await ctx.session().fetch(`/${user.username}/branched/blob/main/keep.txt`)).text();
      assert.match(mainBlob, /MAIN_BODY/);
      const mainFeature = await ctx.session().fetch(`/${user.username}/branched/blob/main/feature.txt`);
      assert.equal(mainFeature.status, 404);
      const mainFeatureHtml = await mainFeature.text();
      assert.equal(mainFeatureHtml.includes('FEATURE_BODY'), false);

      const featureBlob = await (await ctx.session().fetch(`/${user.username}/branched/blob/feature/feature.txt`)).text();
      assert.match(featureBlob, /FEATURE_BODY/);
      assert.equal(featureBlob.includes('MAIN_BODY'), false);
      const featureKeep = await ctx.session().fetch(`/${user.username}/branched/blob/feature/keep.txt`);
      assert.equal(featureKeep.status, 404);
      await featureKeep.text();

      const commits = await (await ctx.session().fetch(`/${user.username}/branched/commits`)).text();
      assert.match(commits, /main-ship/);
      assert.equal(commits.includes('feature-ship'), false);

      const advertised = await (await ctx.session().fetch(`/${user.username}/branched.git/info/refs?service=git-upload-pack`)).text();
      assert.match(advertised, /refs\/heads\/main/);
      assert.match(advertised, /refs\/heads\/feature/);

      setUpdatedAt(ctx.db, fullName, FROZEN);
      const deniedDelete = await runGit(['push', strangerUrl, ':refs/heads/feature'], { cwd: bare, timeout: 20000 });
      assert.notEqual(deniedDelete.code, 0);
      assert.equal(gitSync(['--git-dir', bare, 'rev-parse', 'refs/heads/feature']).trim(), featureHash);
      await assertUpdatedAtStays(ctx.db, fullName, FROZEN);

      const removed = await runGit(
        ['push', remoteUrl(ctx, user.username, 'branched', user.password), ':refs/heads/feature'],
        { cwd: bare, timeout: 20000 }
      );
      assert.equal(removed.code, 0, removed.stderr);
      const gone = await runGit(['--git-dir', bare, 'rev-parse', '--verify', 'refs/heads/feature']);
      assert.notEqual(gone.code, 0);
      assert.equal(gitSync(['--git-dir', bare, 'rev-parse', 'refs/heads/main']).trim(), mainHash);
      const after = await waitForUpdatedAt(ctx.db, fullName, FROZEN);
      assert.notEqual(after, FROZEN);

      const stillMain = await (await ctx.session().fetch(`/${user.username}/branched/blob/main/keep.txt`)).text();
      assert.match(stillMain, /MAIN_BODY/);
      const featureGone = await ctx.session().fetch(`/${user.username}/branched/blob/feature/feature.txt`);
      assert.equal(featureGone.status, 404);
      const featureGoneHtml = await featureGone.text();
      assert.equal(featureGoneHtml.includes('FEATURE_BODY'), false);

      const afterRefs = await (await ctx.session().fetch(`/${user.username}/branched.git/info/refs?service=git-upload-pack`)).text();
      assert.match(afterRefs, /refs\/heads\/main/);
      assert.equal(afterRefs.includes('refs/heads/feature'), false);
    });
  });

  test('an owner push can delete a file and the previous commit still serves it', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'prune', description: '' });
      const bare = barePath(user.username, 'prune');
      const fullName = `${user.username}/prune`;
      commitToBare(bare, {
        files: { 'keep.txt': 'KEEP_BODY\n', 'drop.txt': 'DROP_BODY\n' },
        message: 'first-ship',
      });
      const first = gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim();
      setUpdatedAt(ctx.db, fullName, FROZEN);

      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-prune-'));
      try {
        const cloned = await runGit(['clone', remoteUrl(ctx, user.username, 'prune'), work], { timeout: 20000 });
        assert.equal(cloned.code, 0, cloned.stderr);
        await assertUpdatedAtStays(ctx.db, fullName, FROZEN);
        fs.rmSync(path.join(work, 'drop.txt'));
        for (const args of [
          ['config', 'user.email', 'ada@example.com'],
          ['config', 'user.name', 'Ada'],
          ['config', 'commit.gpgsign', 'false'],
          ['config', 'core.fsmonitor', 'false'],
          ['add', '-A'],
          ['commit', '-m', 'drop-ship'],
        ]) {
          const step = await runGit(args, { cwd: work, timeout: 20000 });
          assert.equal(step.code, 0, `${args.join(' ')}: ${step.stderr}`);
        }
        const pushed = await runGit(
          ['push', remoteUrl(ctx, user.username, 'prune', user.password), 'HEAD:refs/heads/main'],
          { cwd: work, timeout: 20000 }
        );
        assert.equal(pushed.code, 0, pushed.stderr);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }

      const second = gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim();
      assert.notEqual(second, first);
      const refreshed = await waitForUpdatedAt(ctx.db, fullName, FROZEN);
      assert.notEqual(refreshed, FROZEN);

      const dropped = await ctx.session().fetch(`/${user.username}/prune/blob/main/drop.txt`);
      assert.equal(dropped.status, 404);
      const droppedHtml = await dropped.text();
      assert.equal(droppedHtml.includes('DROP_BODY'), false);
      const kept = await (await ctx.session().fetch(`/${user.username}/prune/blob/main/keep.txt`)).text();
      assert.match(kept, /KEEP_BODY/);

      const old = await ctx.session().fetch(`/${user.username}/prune/blob/${first}/drop.txt`);
      assert.equal(old.status, 200);
      assert.match(await old.text(), /DROP_BODY/);

      const history = await (await ctx.session().fetch(`/${user.username}/prune/commits`)).text();
      assert.match(history, /first-ship/);
      assert.match(history, /drop-ship/);
    });
  });

  test('an annotated tag still serves the tagged file after main moves ahead', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'tagged', description: 'public tag' });
      const bare = barePath(user.username, 'tagged');
      const hashes = commitToBare(bare, {
        revisions: [
          { files: { 'note.txt': 'TAGGED_BODY\n' }, message: 'tagged-ship' },
          { files: { 'note.txt': 'LATER_BODY\n' }, message: 'later-ship' },
        ],
      });
      gitSync([
        '--git-dir', bare,
        '-c', 'user.name=Ada',
        '-c', 'user.email=ada@example.com',
        '-c', 'commit.gpgsign=false',
        '-c', 'tag.gpgsign=false',
        'tag', '-a', 'v1.2.0', hashes[0], '-m', 'release one',
      ]);

      const tagged = await (await ctx.session().fetch(`/${user.username}/tagged/blob/v1.2.0/note.txt`)).text();
      assert.match(tagged, /TAGGED_BODY/);
      assert.equal(tagged.includes('LATER_BODY'), false);
      assert.equal(tagged.includes('release one'), false);

      const head = await (await ctx.session().fetch(`/${user.username}/tagged/blob/main/note.txt`)).text();
      assert.match(head, /LATER_BODY/);
      assert.equal(head.includes('TAGGED_BODY'), false);

      const refs = await (await ctx.session().fetch(`/${user.username}/tagged.git/info/refs?service=git-upload-pack`)).text();
      assert.match(refs, /refs\/tags\/v1\.2\.0/);
      assert.match(refs, /refs\/heads\/main/);
    });
  });

  test('a single-character wildcard search does not return private repositories', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      insertRepo(ctx.db, {
        ownerId: user.id,
        username: user.username,
        name: 'public-plain',
        description: 'ordinary public text',
        updatedAt: '2031-01-01 00:00:00',
      });
      insertRepo(ctx.db, {
        ownerId: user.id,
        username: user.username,
        name: 'q',
        description: 'UNDERSCORE_PRIVATE_SECRET',
        isPrivate: 1,
        updatedAt: '2032-01-01 00:00:00',
      });

      const res = await ctx.session().fetch(`/api/search/repos?q=${encodeURIComponent('_')}`);
      const rows = await res.json();
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(rows));
      assert.ok(rows.every((repo) => repo.private === 0));
      assert.equal(JSON.stringify(rows).includes('UNDERSCORE_PRIVATE_SECRET'), false);
      assert.equal(rows.some((repo) => repo.name === 'q'), false);
      assert.equal(JSON.stringify(rows).includes(user.email), false);
    });
  });
});
