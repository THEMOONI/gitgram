const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { createTestContext, registerUser, assertStatus, repoDiskPath, commitToBare, uid } = require('./helpers');

async function withApp(fn) {
  const ctx = await createTestContext();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

test('public reads show the requested revision and only the newest commits on the repo page', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const stranger = await registerUser(ctx);
    const created = await owner.session.postForm('/new', { name: 'notes', description: 'shared notes' });
    assertStatus(created, 302);

    const disk = repoDiskPath(owner.username, 'notes');
    const authorEmail = 'hidden-history@example.com';
    const revisions = [];
    for (let i = 0; i < 6; i++) {
      revisions.push({
        message: 'msg-' + i,
        files: { 'note.txt': 'body-' + i + '\n' }
      });
    }
    commitToBare(disk, {
      authorName: 'Grace Hopper',
      authorEmail,
      revisions
    });

    const hashes = execFileSync('git', ['--git-dir', disk, 'rev-list', '--reverse', 'HEAD'], { encoding: 'utf8' })
      .trim()
      .split('\n');
    const firstHash = hashes[0];
    const fullName = owner.username + '/notes';

    for (const session of [ctx.session(), stranger.session]) {
      const repoPage = await session.fetch('/' + fullName);
      assertStatus(repoPage, 200);
      assert.match(repoPage.text, /msg-5/);
      assert.match(repoPage.text, /msg-1/);
      assert.doesNotMatch(repoPage.text, /msg-0/);
      assert.match(repoPage.text, /View all commits/);
      assert.match(repoPage.text, new RegExp(fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.git'));
      assert.doesNotMatch(repoPage.text, /Settings/);
      assert.doesNotMatch(repoPage.text, new RegExp(authorEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      const history = await session.fetch('/' + fullName + '/commits');
      assertStatus(history, 200);
      assert.match(history.text, /msg-0/);
      assert.match(history.text, /msg-5/);
      assert.match(history.text, /Grace Hopper/);
      assert.doesNotMatch(history.text, new RegExp(authorEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      const latest = await session.fetch('/' + fullName + '/blob/main/note.txt');
      assertStatus(latest, 200);
      assert.match(latest.text, /body-5/);
      assert.doesNotMatch(latest.text, /body-0/);

      const original = await session.fetch('/' + fullName + '/blob/' + firstHash + '/note.txt');
      assertStatus(original, 200);
      assert.match(original.text, /body-0/);
      assert.doesNotMatch(original.text, /body-5/);
    }
  });
});

test('the repository page inlines only a top-level readme, not other file bodies', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const readmeMarker = 'readme-marker-' + uid('body');
    const notesMarker = 'notes-marker-' + uid('body');

    const withReadme = await owner.session.postForm('/new', { name: 'with-readme', description: 'shown' });
    assertStatus(withReadme, 302);
    commitToBare(repoDiskPath(owner.username, 'with-readme'), {
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      message: 'Add files',
      files: {
        'readme.md': readmeMarker + '\nsecond readme line',
        'notes.txt': notesMarker + '\n'
      }
    });

    const repoPage = await ctx.session().fetch('/' + owner.username + '/with-readme');
    assertStatus(repoPage, 200);
    const readmeBlock = (repoPage.text.split('class="readme-content"')[1] || '');
    assert.match(readmeBlock, new RegExp(readmeMarker));
    assert.match(readmeBlock, /second readme line/);
    assert.doesNotMatch(repoPage.text, new RegExp(notesMarker));
    assert.match(repoPage.text, /file-name">readme\.md</);
    assert.match(repoPage.text, /file-name">notes\.txt</);

    const noReadme = await owner.session.postForm('/new', { name: 'no-readme', description: 'plain' });
    assertStatus(noReadme, 302);
    commitToBare(repoDiskPath(owner.username, 'no-readme'), {
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      message: 'Add notes only',
      files: { 'notes.txt': notesMarker + '\n' }
    });

    const plainPage = await ctx.session().fetch('/' + owner.username + '/no-readme');
    assertStatus(plainPage, 200);
    assert.doesNotMatch(plainPage.text, /readme-content/);
    assert.doesNotMatch(plainPage.text, new RegExp(notesMarker));
    assert.match(plainPage.text, /file-name">notes\.txt</);
    assert.match(plainPage.text, /Add notes only/);
  });
});

test('a conventional README.md is inlined and a second readme-like file is not', async () => {
  await withApp(async (ctx) => {
    const owner = await registerUser(ctx);
    const readmeMarker = 'readme-md-' + uid('body');
    const otherMarker = 'readme-txt-' + uid('body');
    const licenseMarker = 'license-body-' + uid('body');

    const created = await owner.session.postForm('/new', { name: 'docs', description: 'shown' });
    assertStatus(created, 302);
    commitToBare(repoDiskPath(owner.username, 'docs'), {
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      message: 'Add readmes',
      files: {
        'README.md': readmeMarker + '\n',
        'readme.txt': otherMarker + '\n',
        'LICENSE': licenseMarker + '\n'
      }
    });

    const repoPage = await ctx.session().fetch('/' + owner.username + '/docs');
    assertStatus(repoPage, 200);
    const readmeBlock = (repoPage.text.split('class="readme-content"')[1] || '');
    assert.match(readmeBlock, new RegExp(readmeMarker));
    assert.doesNotMatch(readmeBlock, new RegExp(otherMarker));
    assert.doesNotMatch(repoPage.text, new RegExp(licenseMarker));
    assert.match(repoPage.text, /file-name">README\.md</);
    assert.match(repoPage.text, /file-name">readme\.txt</);
    assert.match(repoPage.text, /file-name">LICENSE</);
  });
});
