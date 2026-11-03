const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  barePath,
  createRepo,
  gitSync,
  registerUser,
  start,
} = require('./helpers');

const CHILD_BODY = 'DIR_CHILD_BODY_z1';
const LINKED_BODY = 'LINKED_BODY_z1';
const NOTE_BODY = 'NOTE_BODY_z1';

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

describe('git object modes', { concurrency: 1 }, () => {
  test('a readme directory does not inline child bytes, and a gitlink is not a directory', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'objects', description: 'modes' });
      const bare = barePath(user.username, 'objects');
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-modes-'));
      try {
        gitSync(['init', '-b', 'main'], { cwd: work });
        gitSync(['config', 'commit.gpgsign', 'false'], { cwd: work });
        gitSync(['config', 'core.fsmonitor', 'false'], { cwd: work });
        gitSync(['config', 'user.email', 'ada@example.com'], { cwd: work });
        gitSync(['config', 'user.name', 'Ada'], { cwd: work });
        fs.writeFileSync(path.join(work, 'target.txt'), `${LINKED_BODY}\n`);
        gitSync(['add', '-A'], { cwd: work });
        gitSync(['commit', '-m', 'link-target'], { cwd: work });
        const linked = gitSync(['rev-parse', 'HEAD'], { cwd: work }).trim();

        fs.rmSync(path.join(work, 'target.txt'));
        fs.mkdirSync(path.join(work, 'readme'));
        fs.writeFileSync(path.join(work, 'readme', 'guide.txt'), `${CHILD_BODY}\n`);
        fs.writeFileSync(path.join(work, 'notes.txt'), `${NOTE_BODY}\n`);
        gitSync(['add', '-A'], { cwd: work });
        gitSync(['update-index', '--add', '--cacheinfo', `160000,${linked},vendor`], { cwd: work });
        gitSync(['commit', '-m', 'record-modes'], { cwd: work });
        gitSync(['remote', 'add', 'origin', bare], { cwd: work });
        gitSync(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work });
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }

      const page = await (await owner.fetch(`/${user.username}/objects`)).text();
      assert.equal(page.includes(CHILD_BODY), false);
      assert.equal(page.includes(LINKED_BODY), false);
      assert.equal(page.includes(NOTE_BODY), false);
      assert.match(page, /<span><\/span><a href="\/[^"]+\/readme"/);
      assert.doesNotMatch(page, /<span>📄<\/span><a href="\/[^"]+\/readme"/);
      assert.match(page, /<span>📄<\/span><a href="\/[^"]+\/vendor"/);
      assert.doesNotMatch(page, /<span><\/span><a href="\/[^"]+\/vendor"/);
      assert.match(page, /<span>📄<\/span><a href="\/[^"]+\/notes\.txt"/);

      const anon = await (await ctx.session().fetch(`/${user.username}/objects`)).text();
      assert.equal(anon.includes(CHILD_BODY), false);
      assert.equal(anon.includes(LINKED_BODY), false);
      assert.equal(anon.includes(NOTE_BODY), false);

      const notes = await (await owner.fetch(`/${user.username}/objects/blob/main/notes.txt`)).text();
      assert.match(notes, new RegExp(NOTE_BODY));
      assert.equal(notes.includes(CHILD_BODY), false);
      assert.equal(notes.includes(LINKED_BODY), false);

      const directory = await owner.fetch(`/${user.username}/objects/blob/main/readme`);
      const directoryHtml = await directory.text();
      assert.equal(directory.status, 200);
      assert.match(directoryHtml, /guide\.txt/);
      assert.equal(directoryHtml.includes(CHILD_BODY), false);
      assert.equal(directoryHtml.includes(LINKED_BODY), false);

      const nested = await owner.fetch(`/${user.username}/objects/blob/main/readme/guide.txt`);
      const nestedHtml = await nested.text();
      assert.notEqual(nested.status, 200);
      assert.equal(nestedHtml.includes(CHILD_BODY), false);
    });
  });
});
