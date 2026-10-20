const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  barePath,
  commitToBare,
  createRepo,
  gitSync,
  registerUser,
  start,
} = require('./helpers');

describe('repository content', { concurrency: 1 }, () => {
  let ctx;

  before(async () => {
    ctx = await start();
  });

  after(async () => {
    if (ctx) await ctx.close();
  });

  test('only a top-level readme is inlined, with README.md ahead of readme.txt', async () => {
    const session = ctx.session();
    const user = await registerUser(ctx, session);

    await createRepo(session, { name: 'notes-only', description: '' });
    commitToBare(barePath(user.username, 'notes-only'), {
      files: { 'notes.txt': 'NOTES_ONLY_BODY\n' },
      message: 'notes',
    });
    const notesPage = await (await session.fetch(`/${user.username}/notes-only`)).text();
    assert.match(notesPage, /notes\.txt/);
    assert.equal(notesPage.includes('NOTES_ONLY_BODY'), false);
    assert.equal(notesPage.includes('readme-content'), false);

    await createRepo(session, { name: 'with-readme', description: '' });
    commitToBare(barePath(user.username, 'with-readme'), {
      files: {
        'readme.txt': 'README_BODY\n',
        'notes.txt': 'OTHER_FILE_BODY\n',
      },
      message: 'readme',
    });
    const readmePage = await (await session.fetch(`/${user.username}/with-readme`)).text();
    assert.match(readmePage, /README_BODY/);
    assert.equal(readmePage.includes('OTHER_FILE_BODY'), false);
    assert.match(readmePage, /readme-content/);

    await createRepo(session, { name: 'preferred', description: '' });
    commitToBare(barePath(user.username, 'preferred'), {
      files: {
        'README.md': 'README_MD_BODY\n',
        'readme.txt': 'README_TXT_BODY\n',
        'LICENSE': 'LICENSE_BODY\n',
      },
      message: 'prefer',
    });
    const preferred = await (await session.fetch(`/${user.username}/preferred`)).text();
    assert.match(preferred, /README_MD_BODY/);
    assert.equal(preferred.includes('README_TXT_BODY'), false);
    assert.equal(preferred.includes('LICENSE_BODY'), false);
  });

  test('descriptions, commits, filenames, blob lines, and author names are escaped', async () => {
    const session = ctx.session();
    const user = await registerUser(ctx, session);
    await createRepo(session, {
      name: 'escape-me',
      description: '<script>alert(1)</script>',
    });
    const hashes = commitToBare(barePath(user.username, 'escape-me'), {
      revisions: [
        {
          files: { 'README.md': 'alpha-readme-unique\n' },
          message: 'first-note',
          author: 'Ada & Bob',
          email: 'hidden-7f3a@example.test',
        },
        {
          files: {
            'README.md': 'beta-readme-unique\n',
            'a<b>.txt': 'line <script>alert(1)</script>\n',
          },
          message: 'ship <script>',
          author: 'Ada & Bob',
          email: 'hidden-7f3a@example.test',
        },
      ],
    });

    const page = await (await session.fetch(`/${user.username}/escape-me`)).text();
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(page, /ship &lt;script&gt;/);
    assert.match(page, /a&lt;b&gt;\.txt/);
    assert.match(page, /beta-readme-unique/);
    assert.equal(page.includes('alpha-readme-unique'), false);
    const full = hashes[1];
    const short = full.slice(0, 7);
    assert.equal(short.length, 7);
    assert.match(page, new RegExp(short));
    assert.equal(page.includes(full), false);
    assert.match(page, /<script src="\/js\/app\.js">/);

    const blob = await (await session.fetch(`/${user.username}/escape-me/blob/main/${encodeURIComponent('a<b>.txt')}`)).text();
    assert.match(blob, /line &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(blob, /<script src="\/js\/app\.js">/);

    const commits = await (await session.fetch(`/${user.username}/escape-me/commits`)).text();
    assert.match(commits, /Ada &amp; Bob/);
    assert.match(commits, /ship &lt;script&gt;/);
    assert.equal(commits.includes('hidden-7f3a@example.test'), false);
    assert.match(commits, new RegExp(user.username));

    const older = await session.fetch(`/${user.username}/escape-me/blob/${hashes[0]}/README.md`);
    const olderHtml = await older.text();
    assert.equal(older.status, 200);
    assert.match(olderHtml, /alpha-readme-unique/);
    assert.equal(olderHtml.includes('beta-readme-unique'), false);
    const headBlob = await (await session.fetch(`/${user.username}/escape-me/blob/main/README.md`)).text();
    assert.match(headBlob, /beta-readme-unique/);
    assert.equal(headBlob.includes('alpha-readme-unique'), false);
  });

  test('a username containing an ampersand is escaped in the nav, profile, and title', async () => {
    const username = `A&B${ctx.nextId('U')}`;
    const session = ctx.session();
    const user = await registerUser(ctx, session, { username });
    await createRepo(session, { name: 'amp-repo', description: '' });
    const escaped = username.replace(/&/g, '&amp;');

    const home = await (await session.fetch('/')).text();
    assert.match(home, new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(home.includes(`>${username}<`), false);

    const profile = await (await session.fetch(`/@${encodeURIComponent(username)}`)).text();
    assert.match(profile, new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const repo = await (await session.fetch(`/${encodeURIComponent(username)}/amp-repo`)).text();
    assert.match(repo, new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('the repo page shows the five newest commits and history keeps the fifty newest of fifty-one', async () => {
    const session = ctx.session();
    const user = await registerUser(ctx, session);
    await createRepo(session, { name: 'history', description: '' });
    const revisions = [];
    for (let i = 0; i <= 50; i += 1) {
      const label = `cmt-${String(i).padStart(2, '0')}`;
      revisions.push({ files: { VERSION: `${label}\n` }, message: label });
    }
    commitToBare(barePath(user.username, 'history'), { revisions });

    const page = await (await session.fetch(`/${user.username}/history`)).text();
    assert.match(page, /cmt-50/);
    assert.match(page, /cmt-46/);
    assert.equal(page.includes('cmt-45'), false);
    assert.match(page, /View all commits/);

    const history = await (await session.fetch(`/${user.username}/history/commits`)).text();
    assert.match(history, /cmt-50/);
    assert.match(history, /cmt-01/);
    assert.equal(history.includes('cmt-00'), false);
  });

  test('a deleted file disappears from HEAD and remains readable at the creating commit', async () => {
    const session = ctx.session();
    const user = await registerUser(ctx, session);
    await createRepo(session, { name: 'edits', description: '' });
    const hashes = commitToBare(barePath(user.username, 'edits'), {
      revisions: [
        { files: { 'README.md': 'SECRET_README_V1\n', 'keep.txt': 'kept\n' }, message: 'add-readme' },
        { files: { 'other.txt': 'stays\n' }, remove: ['README.md'], message: 'drop-readme' },
      ],
    });

    const page = await (await session.fetch(`/${user.username}/edits`)).text();
    assert.match(page, /keep\.txt/);
    assert.equal(page.includes('SECRET_README_V1'), false);
    assert.equal(page.includes('readme-content'), false);

    const old = await session.fetch(`/${user.username}/edits/blob/${hashes[0]}/README.md`);
    assert.equal(old.status, 200);
    assert.match(await old.text(), /SECRET_README_V1/);
    const gone = await session.fetch(`/${user.username}/edits/blob/main/README.md`);
    assert.equal(gone.status, 404);
  });

  test('branches, directories, and empty files stay on the path that was requested', async () => {
    const session = ctx.session();
    const user = await registerUser(ctx, session);
    await createRepo(session, { name: 'tree', description: '' });
    const bare = barePath(user.username, 'tree');
    commitToBare(bare, {
      files: {
        'README.md': 'main-branch-readme\n',
        'empty.txt': '',
        'notes.txt': 'NOTES_ONLY_BODY\n',
        'docs/guide.txt': 'UNIQUE_GUIDE_BODY\n',
      },
      message: 'commit-on-main',
    });
    commitToBare(bare, {
      branch: 'dev',
      files: { 'README.md': 'dev-branch-readme\n' },
      message: 'commit-on-dev',
    });

    const page = await (await session.fetch(`/${user.username}/tree`)).text();
    assert.match(page, /main-branch-readme/);
    assert.equal(page.includes('dev-branch-readme'), false);
    assert.equal(page.includes('NOTES_ONLY_BODY'), false);
    assert.match(page, /<span>📄<\/span><a href="\/[^"]+\/README\.md"/);
    assert.match(page, /<span><\/span><a href="\/[^"]+\/docs"/);
    assert.doesNotMatch(page, /<span>📄<\/span><a href="\/[^"]+\/docs"/);

    const mainBlob = await (await session.fetch(`/${user.username}/tree/blob/main/README.md`)).text();
    assert.match(mainBlob, /main-branch-readme/);
    assert.equal(mainBlob.includes('dev-branch-readme'), false);
    const devBlob = await (await session.fetch(`/${user.username}/tree/blob/dev/README.md`)).text();
    assert.match(devBlob, /dev-branch-readme/);
    assert.equal(devBlob.includes('main-branch-readme'), false);

    const commits = await (await session.fetch(`/${user.username}/tree/commits`)).text();
    assert.match(commits, /commit-on-main/);
    assert.equal(commits.includes('commit-on-dev'), false);

    const empty = await session.fetch(`/${user.username}/tree/blob/main/empty.txt`);
    assert.equal(empty.status, 200);
    assert.match(await empty.text(), /1 lines/);

    const missing = await session.fetch(`/${user.username}/tree/blob/main/no-such-file`);
    assert.equal(missing.status, 404);
    const missingHtml = await missing.text();
    assert.equal(missingHtml.includes('main-branch-readme'), false);
    assert.equal(missingHtml.includes('UNIQUE_GUIDE_BODY'), false);

    const directory = await session.fetch(`/${user.username}/tree/blob/main/docs`);
    const directoryHtml = await directory.text();
    assert.equal(directory.status, 200);
    assert.match(directoryHtml, /guide\.txt/);
    assert.equal(directoryHtml.includes('UNIQUE_GUIDE_BODY'), false);

    const head = gitSync(['--git-dir', bare, 'rev-parse', '--abbrev-ref', 'HEAD']).trim();
    assert.equal(head, 'main');
  });

  test('public pages are readable without a settings link, and PUBLIC_URL is the clone host', async () => {
    const owner = ctx.session();
    const user = await registerUser(ctx, owner);
    await createRepo(owner, { name: 'open-repo', description: 'hello public' });
    commitToBare(barePath(user.username, 'open-repo'), {
      files: { 'readme.txt': 'public-body\n' },
      message: 'public-commit',
    });
    const stranger = ctx.session();
    await registerUser(ctx, stranger);

    for (const session of [ctx.session(), stranger]) {
      const page = await session.fetch(`/${user.username}/open-repo`);
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.match(html, /public-body/);
      assert.match(html, /badge-public/);
      assert.equal(html.includes(`/${user.username}/open-repo/settings`), false);
      const commits = await session.fetch(`/${user.username}/open-repo/commits`);
      assert.equal(commits.status, 200);
      assert.match(await commits.text(), /public-commit/);
      const blob = await session.fetch(`/${user.username}/open-repo/blob/main/readme.txt`);
      assert.equal(blob.status, 200);
      assert.match(await blob.text(), /public-body/);
    }

    const previous = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = 'https://git.example.test';
    try {
      const html = await (await ctx.session().fetch(`/${user.username}/open-repo`)).text();
      assert.ok(html.includes(`https://git.example.test/${user.username}/open-repo.git`));
      assert.equal(html.includes(`${user.username}/open-repo.git.git`), false);
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = previous;
    }
  });
});
