const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { createTestContext, registerUser, assertStatus, repoDiskPath, commitToBare } = require('./helpers');

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
