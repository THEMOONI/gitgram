const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { nid, createTestApp, listen, close, Client, repoPath, removeOwner, commitFiles } = require('./helpers');

describe('repositories', { concurrency: false }, () => {
  let server;
  let db;

  before(async () => {
    const created = createTestApp();
    db = created.db;
    server = await listen(created.app);
  });

  after(async () => {
    await close(server);
    db.close();
  });

  test('anonymous visitors cannot open the create form or create a repository', async () => {
    const client = new Client(server);
    const form = await client.get('/new');
    assert.equal(form.status, 302);
    assert.equal(form.location, '/login');

    const created = await client.post('/new', { name: 'nope', description: 'should not exist' });
    assert.equal(created.status, 302);
    assert.equal(created.location, '/login');
    assert.equal(db.prepare('SELECT id FROM repositories WHERE name = ?').get('nope'), undefined);
  });

  test('repository names are required, trimmed, and unique per owner', async () => {
    const username = nid('mak');
    const client = new Client(server);
    assert.equal((await client.post('/register', { username, email: username + '@example.com', password: 'secret1' })).status, 302);

    const blank = await client.post('/new', { name: '   ', description: '' });
    assert.equal(blank.status, 200);
    assert.match(blank.text, /Name required/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM repositories WHERE owner_id = (SELECT id FROM users WHERE username = ?)').get(username).c, 0);

    const name = nid('app');
    const description = 'Notes <b>owned</b> & kept';
    try {
      const created = await client.post('/new', { name: '  ' + name + '  ', description });
      assert.equal(created.status, 302);
      assert.equal(created.location, '/' + username + '/' + name);

      const row = db.prepare('SELECT name, full_name, description, private FROM repositories WHERE full_name = ?').get(username + '/' + name);
      assert.equal(row.name, name);
      assert.equal(row.full_name, username + '/' + name);
      assert.equal(row.description, description);
      assert.equal(row.private, 0);

      const head = fs.readFileSync(repoPath(username, name) + '/HEAD', 'utf8');
      assert.match(head, /^ref: refs\/heads\/main\n?$/);
      const config = fs.readFileSync(repoPath(username, name) + '/config', 'utf8');
      assert.match(config, /receivepack = true/);
      assert.match(config, /uploadpack = true/);

      const page = await client.get('/' + username + '/' + name);
      assert.equal(page.status, 200);
      assert.match(page.text, /Quick setup/);
      assert.match(page.text, /Notes &lt;b&gt;owned&lt;\/b&gt; &amp; kept/);
      assert.match(page.text, new RegExp('http://localhost:3000/' + username + '/' + name + '\\.git'));
      assert.match(page.text, /Settings/);

      const duplicate = await client.post('/new', { name, description: '' });
      assert.equal(duplicate.status, 200);
      assert.match(duplicate.text, /Repo already exists/);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM repositories WHERE full_name = ?').get(username + '/' + name).c, 1);

      const anonymous = await new Client(server).get('/' + username + '/' + name);
      assert.equal(anonymous.status, 200);
      assert.match(anonymous.text, /Quick setup/);
      assert.doesNotMatch(anonymous.text, /Settings/);
    } finally {
      removeOwner(username);
    }
  });

  test('private repositories stay hidden and only the owner can change settings or delete them', async () => {
    const ownerName = nid('own');
    const strangerName = nid('str');
    const owner = new Client(server);
    const stranger = new Client(server);
    assert.equal((await owner.post('/register', { username: ownerName, email: ownerName + '@example.com', password: 'secret1' })).status, 302);
    assert.equal((await stranger.post('/register', { username: strangerName, email: strangerName + '@example.com', password: 'secret1' })).status, 302);

    const name = nid('sec');
    const description = 'classified-' + name;
    const fullName = ownerName + '/' + name;
    try {
      const created = await owner.post('/new', { name, description, is_private: '1' });
      assert.equal(created.status, 302);
      assert.equal(db.prepare('SELECT private FROM repositories WHERE full_name = ?').get(fullName).private, 1);
      assert.equal(fs.existsSync(repoPath(ownerName, name)), true);

      const ownerPage = await owner.get('/' + fullName);
      assert.equal(ownerPage.status, 200);
      assert.match(ownerPage.text, new RegExp(description));
      assert.match(ownerPage.text, /badge-private/);

      const strangerPage = await stranger.get('/' + fullName);
      assert.equal(strangerPage.status, 404);
      assert.doesNotMatch(strangerPage.text, new RegExp(description));

      const anonymousPage = await new Client(server).get('/' + fullName);
      assert.equal(anonymousPage.status, 404);
      assert.doesNotMatch(anonymousPage.text, new RegExp(description));

      const home = await new Client(server).get('/');
      assert.doesNotMatch(home.text, new RegExp(name));
      assert.doesNotMatch(home.text, new RegExp(description));

      const ownerSettings = await owner.get('/' + fullName + '/settings');
      assert.equal(ownerSettings.status, 200);
      assert.match(ownerSettings.text, /Danger Zone/);
      assert.match(ownerSettings.text, new RegExp('action="/' + fullName + '/settings/delete"'));

      const strangerSettings = await stranger.get('/' + fullName + '/settings');
      assert.equal(strangerSettings.status, 404);
      assert.doesNotMatch(strangerSettings.text, /Danger Zone/);

      const strangerDelete = await stranger.post('/' + fullName + '/settings/delete', {});
      assert.notEqual(strangerDelete.status, 302);
      assert.ok(db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName));
      assert.equal(fs.existsSync(repoPath(ownerName, name)), true);

      const anonymousDelete = await new Client(server).post('/' + fullName + '/settings/delete', {});
      assert.notEqual(anonymousDelete.status, 302);
      assert.ok(db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName));

      const deleted = await owner.post('/' + fullName + '/settings/delete', {});
      assert.equal(deleted.status, 302);
      assert.equal(deleted.location, '/@' + ownerName);
      assert.equal(db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName), undefined);
      assert.equal(fs.existsSync(repoPath(ownerName, name)), false);

      const gone = await owner.get('/' + fullName);
      assert.equal(gone.status, 404);
    } finally {
      removeOwner(ownerName);
    }
  });

  test('public repository settings and deletion are owner-only', async () => {
    const ownerName = nid('own');
    const strangerName = nid('str');
    const owner = new Client(server);
    const stranger = new Client(server);
    assert.equal((await owner.post('/register', { username: ownerName, email: ownerName + '@example.com', password: 'secret1' })).status, 302);
    assert.equal((await stranger.post('/register', { username: strangerName, email: strangerName + '@example.com', password: 'secret1' })).status, 302);
    const name = nid('pub');
    const fullName = ownerName + '/' + name;
    try {
      assert.equal((await owner.post('/new', { name, description: 'shared' })).status, 302);

      const strangerSettings = await stranger.get('/' + fullName + '/settings');
      assert.equal(strangerSettings.status, 403);
      assert.doesNotMatch(strangerSettings.text, /Danger Zone/);

      const strangerDelete = await stranger.post('/' + fullName + '/settings/delete', {});
      assert.equal(strangerDelete.status, 403);
      assert.ok(db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(fullName));
      assert.equal(fs.existsSync(repoPath(ownerName, name)), true);
    } finally {
      removeOwner(ownerName);
    }
  });

  test('commit history, directories, and file contents are parsed and escaped', async () => {
    const ownerName = nid('git');
    const owner = new Client(server);
    assert.equal((await owner.post('/register', { username: ownerName, email: ownerName + '@example.com', password: 'secret1' })).status, 302);
    const name = nid('src');
    const fullName = ownerName + '/' + name;
    try {
      assert.equal((await owner.post('/new', { name, description: 'history' })).status, 302);
      const readme = 'hello <script>alert(1)</script>\n';
      commitFiles(ownerName, name, [
        {
          message: 'First commit',
          files: [{ path: 'README.md', content: 'draft\n' }],
        },
        {
          message: 'Ship the README',
          files: [
            { path: 'README.md', content: readme },
            { path: 'docs/guide.txt', content: 'guide\n' },
          ],
        },
      ]);

      const page = await owner.get('/' + fullName);
      assert.equal(page.status, 200);
      assert.match(page.text, /Ship the README/);
      assert.match(page.text, /First commit/);
      assert.ok(page.text.indexOf('Ship the README') < page.text.indexOf('First commit'));
      assert.match(page.text, /hello &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(page.text, /<script>alert\(1\)<\/script>/);
      assert.match(page.text, /file-item"><span>📄<\/span><a [^>]*class="file-name">README\.md/);
      assert.match(page.text, /file-item"><span><\/span><a [^>]*class="file-name">docs/);

      const hash = execFileSync('git', ['--git-dir', repoPath(ownerName, name), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      assert.match(page.text, new RegExp(hash.slice(0, 7)));

      const commits = await owner.get('/' + fullName + '/commits');
      assert.equal(commits.status, 200);
      assert.match(commits.text, /Ship the README/);
      assert.match(commits.text, /Ada Lovelace/);
      assert.match(commits.text, new RegExp(hash.slice(0, 7)));
      assert.ok(commits.text.indexOf('Ship the README') < commits.text.indexOf('First commit'));

      const emptyName = nid('empty');
      assert.equal((await owner.post('/new', { name: emptyName, description: '' })).status, 302);
      const emptyCommits = await owner.get('/' + ownerName + '/' + emptyName + '/commits');
      assert.equal(emptyCommits.status, 200);
      assert.match(emptyCommits.text, /No commits yet/);

      const blob = await owner.get('/' + fullName + '/blob/main/README.md');
      assert.equal(blob.status, 200);
      assert.match(blob.text, /hello &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(blob.text, /<script>alert\(1\)<\/script>/);

      const missing = await owner.get('/' + fullName + '/blob/main/missing.txt');
      assert.equal(missing.status, 404);
      assert.doesNotMatch(missing.text, /alert\(1\)/);

      const badRef = await owner.get('/' + fullName + '/blob/no-such-ref/README.md');
      assert.equal(badRef.status, 404);
    } finally {
      removeOwner(ownerName);
    }
  });
});
