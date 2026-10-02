const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  Agent,
  closeTestContext,
  createTestContext,
  registerUser,
  repoPathFor,
  seedBareRepo,
  trackRepo,
  uniqueId,
} = require('./helpers');

describe('repository content parsing', { concurrency: 1 }, () => {
  let ctx;

  before(async () => {
    ctx = await createTestContext();
  });

  after(async () => {
    await closeTestContext(ctx);
  });

  test('parses files, readme, and commit history and escapes file contents', async () => {
    const owner = new Agent(ctx.server);
    const account = await registerUser(owner, {});
    trackRepo(ctx, account.username);
    const name = `hist${uniqueId()}`;
    const message = `Import history ${uniqueId()}`;
    const readme = '<script>alert(1)</script>\nsecond line';
    seedBareRepo(repoPathFor(account.username, name), {
      files: [
        { name: 'README.md', content: readme },
        { name: 'docs/guide.txt', content: 'nested' },
      ],
      message,
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
    });
    const ownerId = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(account.username).id;
    ctx.db.prepare('INSERT INTO repositories (name, full_name, description, owner_id, private) VALUES (?, ?, ?, ?, 0)')
      .run(name, `${account.username}/${name}`, 'history fixture', ownerId);

    const page = await new Agent(ctx.server).request('GET', `/${account.username}/${name}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /README\.md/);
    assert.match(page.text, />docs</);
    assert.match(page.text, new RegExp(message));
    assert.match(page.text, /[0-9a-f]{7}/);
    assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(page.text, /<script>alert\(1\)<\/script>/);

    const commits = await new Agent(ctx.server).request('GET', `/${account.username}/${name}/commits`);
    assert.equal(commits.status, 200);
    assert.match(commits.text, new RegExp(message));
    assert.match(commits.text, /Ada Lovelace/);
    assert.match(commits.text, /[0-9a-f]{7}/);
    assert.doesNotMatch(commits.text, /Invalid date/);

    const blob = await new Agent(ctx.server).request('GET', `/${account.username}/${name}/blob/main/README.md`);
    assert.equal(blob.status, 200);
    assert.match(blob.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(blob.text, /second line/);
    assert.match(blob.text, /2 lines/);
    assert.doesNotMatch(blob.text, /<script>alert\(1\)<\/script>/);

    const missing = await new Agent(ctx.server).request('GET', `/${account.username}/${name}/blob/main/missing.txt`);
    assert.notEqual(missing.status, 200);
    assert.doesNotMatch(missing.text, /second line/);
  });
});