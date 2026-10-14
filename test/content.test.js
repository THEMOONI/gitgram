const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  commitToBare,
  createRepo,
  getText,
  locationPath,
  register,
  repoDisk,
  repoRow,
  runGit,
  Session,
  withApp,
} = require('./helpers');

describe('content', { concurrency: false }, () => {
  test('pages escape untrusted text and inline only the first readme', { timeout: 30000 }, async () => {
    await withApp(async (ctx) => {
      const owner = new Session(ctx);
      const anon = new Session(ctx);
      const username = 'A&B';
      await register(owner, { username, email: 'ab@example.com', password: 'pw-ab-content' });
      const created = await createRepo(owner, {
        name: 'widgets',
        description: 'Tom & <b>Jerry</b>',
      });
      assert.equal(created.status, 302);
      assert.equal(locationPath(created.location), '/A&B/widgets');

      const dangerousName = await createRepo(owner, { name: 'a<img>', description: 'name-desc' });
      assert.equal(dangerousName.status, 302);
      assert.equal(repoRow(ctx, 'A&B/a<img>').name, 'a<img>');
      const named = await getText(owner, `/${encodeURIComponent(username)}/${encodeURIComponent('a<img>')}`);
      assert.equal(named.status, 200);
      assert.match(named.text, /a&lt;img&gt;/);
      assert.equal(named.text.includes('<img>'), false);
      assert.match(named.text, /echo "# a&lt;img&gt;"/);
      const namedHome = await getText(anon, '/');
      assert.match(namedHome.text, /a&lt;img&gt;/);
      assert.equal(namedHome.text.includes('<img>'), false);

      commitToBare(repoDisk(username, 'widgets'), {
        files: {
          'README.md': 'UPPER-README-BODY',
          'readme.txt': 'LOWER-README-BODY',
          'notes.txt': 'NOTES-BODY-SECRET',
          'LICENSE': 'LICENSE-BODY-SECRET',
          'docs/guide.txt': 'guide-secret-body',
          'blank.txt': '',
          'a&b.txt': '<script>alert(1)</script>',
        },
        message: 'ship <script>',
        author: 'Pat & Sam',
        email: 'hidden-author@example.test',
      });

      const repo = await getText(anon, `/${encodeURIComponent(username)}/widgets`);
      assert.equal(repo.status, 200);
      assert.match(repo.text, /A&amp;B/);
      assert.equal(repo.text.includes('A&B'), false);
      assert.match(repo.text, /Tom &amp; &lt;b&gt;Jerry&lt;\/b&gt;/);
      assert.equal(repo.text.includes('<b>'), false);
      assert.match(repo.text, /UPPER-README-BODY/);
      assert.match(repo.text, /📖 README/);
      assert.equal(repo.text.includes('LOWER-README-BODY'), false);
      assert.equal(repo.text.includes('NOTES-BODY-SECRET'), false);
      assert.equal(repo.text.includes('LICENSE-BODY-SECRET'), false);
      assert.equal(repo.text.includes('guide-secret-body'), false);
      assert.match(repo.text, /a&amp;b\.txt/);
      assert.equal(repo.text.includes('a&b.txt'), false);
      assert.match(repo.text, /ship &lt;script&gt;/);
      assert.equal(repo.text.includes('ship <script>'), false);
      assert.equal(repo.text.includes('<script>alert(1)</script>'), false);

      const profile = await getText(owner, `/@${encodeURIComponent(username)}`);
      assert.match(profile.text, /A&amp;B/);
      assert.equal(profile.text.includes('A&B'), false);

      const file = await getText(anon, `/${encodeURIComponent(username)}/widgets/blob/main/${encodeURIComponent('a&b.txt')}`);
      assert.equal(file.status, 200);
      assert.match(file.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.equal(file.text.includes('<script>alert(1)</script>'), false);

      const blank = await getText(anon, `/${encodeURIComponent(username)}/widgets/blob/main/blank.txt`);
      assert.equal(blank.status, 200);
      assert.match(blank.text, /1 lines/);

      const directory = await getText(anon, `/${encodeURIComponent(username)}/widgets/blob/main/docs`);
      assert.equal(directory.status, 200);
      assert.match(directory.text, /guide\.txt/);
      assert.equal(directory.text.includes('guide-secret-body'), false);

      const missing = await getText(anon, `/${encodeURIComponent(username)}/widgets/blob/main/missing.txt`);
      assert.equal(missing.status, 404);
      assert.equal(missing.text.includes('UPPER-README-BODY'), false);
      assert.equal(missing.text.includes('guide-secret-body'), false);

      const commits = await getText(anon, `/${encodeURIComponent(username)}/widgets/commits`);
      assert.equal(commits.status, 200);
      assert.match(commits.text, /Pat &amp; Sam/);
      assert.equal(commits.text.includes('Pat & Sam'), false);
      assert.equal(commits.text.includes('hidden-author@example.test'), false);
      assert.match(commits.text, /ship &lt;script&gt;/);
      assert.equal(commits.text.includes('ship <script>'), false);
      assert.equal(commits.text.includes('<script>alert(1)</script>'), false);

      await createRepo(owner, { name: 'notesonly', description: '' });
      commitToBare(repoDisk(username, 'notesonly'), {
        files: { 'notes.txt': 'NOTES-ONLY-SECRET' },
        message: 'notes only',
      });
      const notes = await getText(anon, `/${encodeURIComponent(username)}/notesonly`);
      assert.equal(notes.status, 200);
      assert.equal(notes.text.includes('📖 README'), false);
      assert.equal(notes.text.includes('NOTES-ONLY-SECRET'), false);
      assert.match(notes.text, /notes\.txt/);
    });
  });

  test('history, deleted files, and other branches stay on the revision that was requested', { timeout: 30000 }, async () => {
    await withApp(async (ctx) => {
      const owner = new Session(ctx);
      const anon = new Session(ctx);
      await register(owner, { username: 'Rita', email: 'rita@example.com', password: 'pw-rita-revs' });
      await createRepo(owner, { name: 'lines', description: 'lines-desc' });
      const disk = repoDisk('Rita', 'lines');
      commitToBare(disk, {
        revisions: [
          { files: { 'readme.txt': 'old-readme-body', 'keep.txt': 'keep-body' }, message: 'created-files' },
          { files: { 'readme.txt': 'new-readme-body' }, message: 'updated-readme' },
          { remove: ['readme.txt'], message: 'deleted-readme' },
          { branch: 'dev', files: { 'readme.txt': 'dev-readme-body' }, message: 'dev-only-commit' },
        ],
      });
      const commits = runGit(['--git-dir', disk, 'rev-list', '--reverse', 'HEAD']).split('\n').filter(Boolean);
      assert.equal(commits.length, 3);
      const head = runGit(['--git-dir', disk, 'rev-parse', 'HEAD']);

      const repo = await getText(anon, '/Rita/lines');
      assert.equal(repo.status, 200);
      assert.match(repo.text, /keep\.txt/);
      assert.equal(repo.text.includes('readme.txt'), false);
      assert.equal(repo.text.includes('old-readme-body'), false);
      assert.equal(repo.text.includes('new-readme-body'), false);
      assert.equal(repo.text.includes('dev-readme-body'), false);
      assert.equal(repo.text.includes('keep-body'), false);
      assert.equal(repo.text.includes('dev-only-commit'), false);
      const deletedAt = repo.text.indexOf('deleted-readme');
      const createdAt = repo.text.indexOf('created-files');
      assert.ok(deletedAt !== -1 && createdAt !== -1 && deletedAt < createdAt);
      assert.match(repo.text, /\/Rita\/lines\/commits/);

      const history = await getText(anon, '/Rita/lines/commits');
      assert.match(history.text, new RegExp(head.slice(0, 7)));
      assert.equal(history.text.includes(head), false);
      assert.equal(history.text.includes('dev-only-commit'), false);
      const historyDeleted = history.text.indexOf('deleted-readme');
      const historyCreated = history.text.indexOf('created-files');
      assert.ok(historyDeleted !== -1 && historyCreated !== -1 && historyDeleted < historyCreated);

      const oldBlob = await getText(anon, `/Rita/lines/blob/${commits[0]}/readme.txt`);
      assert.equal(oldBlob.status, 200);
      assert.match(oldBlob.text, /old-readme-body/);
      assert.equal(oldBlob.text.includes('new-readme-body'), false);
      const newBlob = await getText(anon, `/Rita/lines/blob/${commits[1]}/readme.txt`);
      assert.match(newBlob.text, /new-readme-body/);
      assert.equal(newBlob.text.includes('old-readme-body'), false);
      const headBlob = await getText(anon, '/Rita/lines/blob/main/readme.txt');
      assert.equal(headBlob.status, 404);
      assert.equal(headBlob.text.includes('old-readme-body'), false);

      const devBlob = await getText(anon, '/Rita/lines/blob/dev/readme.txt');
      assert.equal(devBlob.status, 200);
      assert.match(devBlob.text, /dev-readme-body/);
      assert.equal(devBlob.text.includes('new-readme-body'), false);
      const mainKeep = await getText(anon, '/Rita/lines/blob/main/keep.txt');
      assert.match(mainKeep.text, /keep-body/);
      const devKeep = await getText(anon, '/Rita/lines/blob/dev/keep.txt');
      assert.match(devKeep.text, /keep-body/);
    });
  });

  test('the repo page shows five commits and history shows fifty', { timeout: 60000 }, async () => {
    await withApp(async (ctx) => {
      const owner = new Session(ctx);
      const anon = new Session(ctx);
      await register(owner, { username: 'Hist', email: 'hist@example.com', password: 'pw-hist-limit' });
      await createRepo(owner, { name: 'chronicle', description: 'history' });
      const revisions = [];
      for (let i = 0; i <= 50; i += 1) {
        const label = `cmt-${String(i).padStart(2, '0')}`;
        revisions.push({
          files: i === 0 ? { 'readme.txt': 'history-body' } : {},
          message: label,
        });
      }
      commitToBare(repoDisk('Hist', 'chronicle'), { revisions });

      const repo = await getText(anon, '/Hist/chronicle');
      assert.match(repo.text, /cmt-50/);
      assert.match(repo.text, /cmt-46/);
      assert.equal(repo.text.includes('cmt-45'), false);
      assert.match(repo.text, /\/Hist\/chronicle\/commits/);

      const history = await getText(anon, '/Hist/chronicle/commits');
      assert.match(history.text, /cmt-50/);
      assert.match(history.text, /cmt-01/);
      assert.equal(history.text.includes('cmt-00'), false);
    });
  });
});
