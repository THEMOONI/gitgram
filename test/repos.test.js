const { before, after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  unique,
  createTestContext,
  listen,
  close,
  cleanupUsers,
  Session,
  repoRoot,
} = require('./support');

describe('repository access', () => {
  let db;
  let server;
  let port;
  let users;

  before(async () => {
    ({ db, server, users } = createTestContext());
    port = await listen(server);
  });

  after(async () => {
    cleanupUsers(users);
    await close(server);
    db.close();
  });

  async function register(username, password = 'secret1') {
    users.add(username);
    const session = new Session(port);
    const response = await session.form('POST', '/register', {
      username,
      email: `${username}@example.com`,
      password,
    });
    assert.equal(response.status, 302);
    return session;
  }

  test('creating a repository requires a session, a name, and a unique full name', async () => {
    const anonymous = await new Session(port).request('GET', '/new');
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.location, '/login');

    const ownerName = unique('owner');
    const otherName = unique('peer');
    const owner = await register(ownerName);
    const peer = await register(otherName);

    const blank = await owner.form('POST', '/new', { name: '   ', description: 'nope' });
    assert.equal(blank.status, 200);
    assert.match(blank.body, /Name required/);
    assert.equal(db.prepare('SELECT id FROM repositories WHERE description = ?').get('nope'), undefined);

    const repoName = unique('app');
    const created = await owner.form('POST', '/new', {
      name: repoName,
      description: 'shared notes',
    });
    assert.equal(created.status, 302);
    assert.equal(created.headers.location, `/${ownerName}/${repoName}`);

    const row = db.prepare('SELECT * FROM repositories WHERE full_name = ?').get(`${ownerName}/${repoName}`);
    assert.equal(row.private, 0);
    assert.equal(row.description, 'shared notes');
    assert.equal(fs.existsSync(path.join(repoRoot, ownerName, repoName)), true);

    const duplicate = await owner.form('POST', '/new', { name: repoName, description: 'again' });
    assert.equal(duplicate.status, 200);
    assert.match(duplicate.body, /Repo already exists/);

    const sameName = await peer.form('POST', '/new', { name: repoName, description: 'peer copy', is_private: '1' });
    assert.equal(sameName.status, 302);
    const peerRow = db.prepare('SELECT private FROM repositories WHERE full_name = ?').get(`${otherName}/${repoName}`);
    assert.equal(peerRow.private, 1);

    const unauthenticatedPost = await new Session(port).form('POST', '/new', { name: unique('sneak') });
    assert.equal(unauthenticatedPost.status, 302);
    assert.equal(unauthenticatedPost.headers.location, '/login');
  });

  test('private repositories stay off public pages, profiles, and search', async () => {
    const ownerName = unique('nina');
    const strangerName = unique('mallory');
    const owner = await register(ownerName);
    await register(strangerName);
    const ownerId = db.prepare('SELECT id FROM users WHERE username = ?').get(ownerName).id;

    const publicName = unique('public');
    const privateName = unique('private');
    const script = '<script>alert(1)</script>';
    db.prepare(`INSERT INTO repositories (name, full_name, description, owner_id, private) VALUES (?, ?, ?, ?, 0)`)
      .run(publicName, `${ownerName}/${publicName}`, script, ownerId);
    db.prepare(`INSERT INTO repositories (name, full_name, description, owner_id, private) VALUES (?, ?, ?, ?, 1)`)
      .run(privateName, `${ownerName}/${privateName}`, 'hidden launch plan', ownerId);

    const home = await new Session(port).request('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.body, new RegExp(publicName));
    assert.match(home.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(home.body, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(home.body, /hidden launch plan/);

    const strangerProfile = await new Session(port).request('GET', `/@${ownerName}`);
    assert.equal(strangerProfile.status, 200);
    assert.match(strangerProfile.body, new RegExp(publicName));
    assert.doesNotMatch(strangerProfile.body, new RegExp(privateName));
    assert.doesNotMatch(strangerProfile.body, /hidden launch plan/);

    const ownerProfile = await owner.request('GET', `/@${ownerName}`);
    assert.match(ownerProfile.body, new RegExp(privateName));
    assert.match(ownerProfile.body, /hidden launch plan/);
    assert.match(ownerProfile.body, /Private/);

    const strangerApi = await new Session(port).request('GET', `/api/users/${ownerName}/repos`);
    assert.equal(strangerApi.status, 200);
    const strangerRepos = JSON.parse(strangerApi.body);
    assert.deepEqual(strangerRepos.map((repo) => repo.name), [publicName]);
    assert.equal(Object.hasOwn(strangerRepos[0], 'password'), false);

    const ownerApi = JSON.parse((await owner.request('GET', `/api/users/${ownerName}/repos`)).body);
    assert.deepEqual(ownerApi.map((repo) => repo.name).sort(), [privateName, publicName].sort());

    const missingUser = await new Session(port).request('GET', `/api/users/${unique('ghost')}/repos`);
    assert.equal(missingUser.status, 404);
    assert.deepEqual(JSON.parse(missingUser.body), { error: 'Not found' });

    const emptySearch = await new Session(port).request('GET', '/api/search/repos');
    assert.deepEqual(JSON.parse(emptySearch.body), []);
    const blankSearch = await new Session(port).request('GET', '/api/search/repos?q=');
    assert.deepEqual(JSON.parse(blankSearch.body), []);

    const found = JSON.parse((await new Session(port).request('GET', `/api/search/repos?q=${encodeURIComponent(publicName)}`)).body);
    assert.deepEqual(found.map((repo) => repo.full_name), [`${ownerName}/${publicName}`]);

    const hidden = JSON.parse((await new Session(port).request('GET', '/api/search/repos?q=hidden%20launch')).body);
    assert.deepEqual(hidden, []);

    const injected = JSON.parse((await new Session(port).request('GET', `/api/search/repos?q=${encodeURIComponent("' OR 1=1 --")}`)).body);
    assert.deepEqual(injected, []);
  });

  test('only the owner can open settings or delete a repository', async () => {
    const ownerName = unique('delowner');
    const otherName = unique('delpeer');
    const owner = await register(ownerName);
    const other = await register(otherName);
    const repoName = unique('doomed');

    assert.equal((await owner.form('POST', '/new', { name: repoName, description: 'keep me' })).status, 302);
    const repoPath = path.join(repoRoot, ownerName, repoName);
    assert.equal(fs.existsSync(repoPath), true);

    const deniedSettings = await other.request('GET', `/${ownerName}/${repoName}/settings`);
    assert.notEqual(deniedSettings.status, 200);
    assert.doesNotMatch(deniedSettings.body, /Danger Zone/);

    const deniedDelete = await other.form('POST', `/${ownerName}/${repoName}/settings/delete`, {});
    assert.notEqual(deniedDelete.status, 302);
    assert.equal(db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(`${ownerName}/${repoName}`) != null, true);
    assert.equal(fs.existsSync(repoPath), true);

    const anonymousDelete = await new Session(port).form('POST', `/${ownerName}/${repoName}/settings/delete`, {});
    assert.notEqual(anonymousDelete.status, 302);
    assert.equal(fs.existsSync(repoPath), true);

    const settings = await owner.request('GET', `/${ownerName}/${repoName}/settings`);
    assert.equal(settings.status, 200);
    assert.match(settings.body, /Danger Zone/);
    assert.match(settings.body, new RegExp(`/${ownerName}/${repoName}/settings/delete`));

    const removed = await owner.form('POST', `/${ownerName}/${repoName}/settings/delete`, {});
    assert.equal(removed.status, 302);
    assert.equal(removed.headers.location, `/@${ownerName}`);
    assert.equal(db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(`${ownerName}/${repoName}`), undefined);
    assert.equal(fs.existsSync(repoPath), false);
  });

  test('owner can read commits and escaped file contents; strangers cannot read a private repo', async () => {
    const ownerName = unique('reader');
    const owner = await register(ownerName);
    const repoName = unique('notes');
    assert.equal((await owner.form('POST', '/new', {
      name: repoName,
      description: 'notes',
      is_private: '1',
    })).status, 302);

    const bare = path.join(repoRoot, ownerName, repoName);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-'));
    try {
      execFileSync('git', ['clone', bare, work], { stdio: 'pipe' });
      const payload = '<img src=x onerror=alert(1)>';
      fs.writeFileSync(path.join(work, 'README.md'), `# Notes\n${payload}\n`);
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'Ada Lovelace',
        GIT_AUTHOR_EMAIL: 'ada@example.com',
        GIT_COMMITTER_NAME: 'Ada Lovelace',
        GIT_COMMITTER_EMAIL: 'ada@example.com',
      };
      execFileSync('git', ['-C', work, 'add', 'README.md'], { env: gitEnv, stdio: 'pipe' });
      execFileSync('git', ['-C', work, 'commit', '-m', 'Explain the plan'], { env: gitEnv, stdio: 'pipe' });
      execFileSync('git', ['-C', work, 'push', 'origin', 'HEAD:main'], { env: gitEnv, stdio: 'pipe' });

      const hash = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const page = await owner.request('GET', `/${ownerName}/${repoName}`);
      assert.equal(page.status, 200);
      assert.match(page.body, /README.md/);
      assert.match(page.body, /Explain the plan/);
      assert.match(page.body, new RegExp(hash.slice(0, 7)));

      const commits = await owner.request('GET', `/${ownerName}/${repoName}/commits`);
      assert.equal(commits.status, 200);
      assert.match(commits.body, /Explain the plan/);
      assert.match(commits.body, /Ada Lovelace/);
      assert.match(commits.body, new RegExp(hash.slice(0, 7)));

      const file = await owner.request('GET', `/${ownerName}/${repoName}/blob/main/README.md`);
      assert.equal(file.status, 200);
      assert.match(file.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
      assert.doesNotMatch(file.body, /<img src=x onerror=alert\(1\)>/);

      const stranger = await new Session(port).request('GET', `/${ownerName}/${repoName}/blob/main/README.md`);
      assert.notEqual(stranger.status, 200);
      assert.doesNotMatch(stranger.body, /onerror=alert/);
      const strangerPage = await new Session(port).request('GET', `/${ownerName}/${repoName}`);
      assert.notEqual(strangerPage.status, 200);
      assert.doesNotMatch(strangerPage.body, /Explain the plan/);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
