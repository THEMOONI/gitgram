const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const { withApp, login, form, unique, repoPath, pushCommits } = require('./helpers');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
}

describe('repository creation', () => {
  it('requires a session, a unique trimmed name, and initializes a bare main branch', async () => {
    await withApp(async (api) => {
      const user = api.seedUser(unique('owner'));

      const anon = await api.request({ method: 'POST', path: '/new', body: form({ name: 'demo' }) });
      assert.equal(anon.status, 302);
      assert.equal(anon.headers.location, '/login');

      const jar = await login(api, user);
      const blank = await api.request({
        method: 'POST',
        path: '/new',
        body: form({ name: '   ' }),
        jar
      });
      assert.equal(blank.status, 200);
      assert.match(blank.body, /Name required/);

      const created = await api.request({
        method: 'POST',
        path: '/new',
        body: form({ name: '  Demo  ', description: 'Ship <script>alert(1)</script>', is_private: '1' }),
        jar
      });
      assert.equal(created.status, 302);
      assert.equal(created.headers.location, '/' + user.username + '/Demo');

      const row = api.db.prepare('SELECT name, full_name, description, private FROM repositories WHERE full_name = ?').get(user.username + '/Demo');
      assert.equal(row.name, 'Demo');
      assert.equal(row.private, 1);
      assert.match(row.description, /<script>/);

      const bare = repoPath(user.username, 'Demo');
      assert.equal(git(['--git-dir', bare, 'rev-parse', '--is-bare-repository']), 'true');
      assert.equal(git(['--git-dir', bare, 'symbolic-ref', 'HEAD']), 'refs/heads/main');
      assert.equal(git(['--git-dir', bare, 'config', '--get', 'http.receivepack']), 'true');
      assert.equal(git(['--git-dir', bare, 'config', '--get', 'http.uploadpack']), 'true');

      const duplicate = await api.request({
        method: 'POST',
        path: '/new',
        body: form({ name: 'Demo', description: 'again' }),
        jar
      });
      assert.equal(duplicate.status, 200);
      assert.match(duplicate.body, /Repo already exists/);
      assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n, 1);

      const page = await api.request({ path: '/' + user.username + '/Demo', jar });
      assert.equal(page.status, 200);
      assert.match(page.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(page.body, /<script>alert\(1\)<\/script>/);
      assert.match(page.body, /badge-private/);
    });
  });
});

describe('repository permissions', () => {
  it('hides private repositories and limits settings and deletion to the owner', async () => {
    await withApp(async (api) => {
      const owner = api.seedUser(unique('owner'));
      const stranger = api.seedUser(unique('stranger'));
      api.seedRepo(owner, 'locked', { description: 'LOCKED-DESCRIPTION', isPrivate: true });
      api.seedRepo(owner, 'shared', { description: 'SHARED-DESCRIPTION', isPrivate: false });
      const ownerJar = await login(api, owner);
      const strangerJar = await login(api, stranger);

      const ownerView = await api.request({ path: '/' + owner.username + '/locked', jar: ownerJar });
      assert.equal(ownerView.status, 200);
      assert.match(ownerView.body, /LOCKED-DESCRIPTION/);

      for (const jar of [{}, strangerJar]) {
        const hidden = await api.request({ path: '/' + owner.username + '/locked', jar });
        assert.equal(hidden.status, 404);
        assert.match(hidden.body, /Not Found - GITGRAM/);
        assert.doesNotMatch(hidden.body, /LOCKED-DESCRIPTION/);
        const hiddenSettings = await api.request({ path: '/' + owner.username + '/locked/settings', jar });
        assert.equal(hiddenSettings.status, 404);
        assert.doesNotMatch(hiddenSettings.body, /Danger Zone/);
      }

      const publicView = await api.request({ path: '/' + owner.username + '/shared' });
      assert.equal(publicView.status, 200);
      assert.match(publicView.body, /SHARED-DESCRIPTION/);

      const deniedSettings = await api.request({ path: '/' + owner.username + '/shared/settings', jar: strangerJar });
      assert.equal(deniedSettings.status, 403);
      assert.match(deniedSettings.body, /Access Denied/);
      assert.doesNotMatch(deniedSettings.body, /Danger Zone/);

      const settings = await api.request({ path: '/' + owner.username + '/shared/settings', jar: ownerJar });
      assert.equal(settings.status, 200);
      assert.match(settings.body, /Danger Zone/);
      assert.match(settings.body, new RegExp('action="/' + owner.username + '/shared/settings/delete"'));

      const deniedDelete = await api.request({
        method: 'POST',
        path: '/' + owner.username + '/shared/settings/delete',
        jar: strangerJar
      });
      assert.equal(deniedDelete.status, 403);
      assert.ok(api.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(owner.username + '/shared'));

      const hiddenDelete = await api.request({
        method: 'POST',
        path: '/' + owner.username + '/locked/settings/delete',
        jar: strangerJar
      });
      assert.equal(hiddenDelete.status, 404);
      assert.ok(api.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(owner.username + '/locked'));

      const removed = await api.request({
        method: 'POST',
        path: '/' + owner.username + '/locked/settings/delete',
        jar: ownerJar
      });
      assert.equal(removed.status, 302);
      assert.equal(removed.headers.location, '/@' + owner.username);
      assert.equal(api.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(owner.username + '/locked'), undefined);
      assert.ok(api.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(owner.username + '/shared'));
    });
  });

  it('removes the bare repository from disk when the owner deletes it', async () => {
    await withApp(async (api) => {
      const owner = api.seedUser(unique('owner'));
      const jar = await login(api, owner);
      const created = await api.request({
        method: 'POST',
        path: '/new',
        body: form({ name: 'scratch' }),
        jar
      });
      assert.equal(created.status, 302);
      const bare = repoPath(owner.username, 'scratch');
      assert.equal(fs.existsSync(bare), true);

      const removed = await api.request({
        method: 'POST',
        path: '/' + owner.username + '/scratch/settings/delete',
        jar
      });
      assert.equal(removed.status, 302);
      assert.equal(removed.headers.location, '/@' + owner.username);
      assert.equal(fs.existsSync(bare), false);
      assert.equal(api.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(owner.username + '/scratch'), undefined);
    });
  });
});

describe('repository history parsing', () => {
  it('parses commits, directories, README text, and blob contents', async () => {
    await withApp(async (api) => {
      const owner = api.seedUser(unique('owner'));
      const stranger = api.seedUser(unique('stranger'));
      const jar = await login(api, owner);
      const created = await api.request({
        method: 'POST',
        path: '/new',
        body: form({ name: 'parser', description: 'history', is_private: '1' }),
        jar
      });
      assert.equal(created.status, 302);

      const bare = repoPath(owner.username, 'parser');
      pushCommits(bare, [
        {
          message: 'Add README: initial import',
          files: {
            'README.md': '# Parser\n\nHello',
            'src/app.js': 'console.log(1)\n'
          }
        },
        {
          message: 'Record SECRET_TOKEN_91',
          files: {
            'README.md': 'visible <script>alert(1)</script>\nSECRET_TOKEN_91\n'
          }
        }
      ]);

      const page = await api.request({ path: '/' + owner.username + '/parser', jar });
      assert.equal(page.status, 200);
      assert.match(page.body, /Record SECRET_TOKEN_91/);
      assert.match(page.body, /Add README: initial import/);
      assert.ok(page.body.indexOf('Record SECRET_TOKEN_91') < page.body.indexOf('Add README: initial import'));
      assert.match(page.body, /visible &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.match(page.body, /SECRET_TOKEN_91/);
      assert.match(page.body, new RegExp('<span>📄</span><a href="/' + owner.username + '/parser/blob/main/README.md" class="file-name">README.md</a>'));
      assert.match(page.body, new RegExp('<span></span><a href="/' + owner.username + '/parser/blob/main/src" class="file-name">src</a>'));

      const shortHash = git(['--git-dir', bare, 'rev-parse', '--short=7', 'HEAD']);
      const commits = await api.request({ path: '/' + owner.username + '/parser/commits', jar });
      assert.equal(commits.status, 200);
      assert.match(commits.body, /Ada Lovelace/);
      assert.match(commits.body, /Record SECRET_TOKEN_91/);
      assert.match(commits.body, new RegExp(shortHash));
      assert.ok(commits.body.indexOf('Record SECRET_TOKEN_91') < commits.body.indexOf('Add README: initial import'));

      const blob = await api.request({ path: '/' + owner.username + '/parser/blob/main/README.md', jar });
      assert.equal(blob.status, 200);
      assert.match(blob.body, /SECRET_TOKEN_91/);
      assert.match(blob.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(blob.body, /<script>alert\(1\)<\/script>/);

      const missing = await api.request({ path: '/' + owner.username + '/parser/blob/main/missing.txt', jar });
      assert.equal(missing.status, 404);
      assert.doesNotMatch(missing.body, /SECRET_TOKEN_91/);

      const leaked = await api.request({
        path: '/' + owner.username + '/parser/blob/main/README.md',
        jar: await login(api, stranger)
      });
      assert.equal(leaked.status, 404);
      assert.doesNotMatch(leaked.body, /SECRET_TOKEN_91/);

      const emptyCommits = await api.request({
        method: 'POST',
        path: '/new',
        body: form({ name: 'emptyhist' }),
        jar
      });
      assert.equal(emptyCommits.status, 302);
      const noCommits = await api.request({ path: '/' + owner.username + '/emptyhist/commits', jar });
      assert.match(noCommits.body, /No commits yet/);
    });
  });
});
