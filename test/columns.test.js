const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  barePath,
  createRepo,
  gitSync,
  passwordHash,
  registerUser,
  repoRow,
  start,
} = require('./helpers');

const SPOOFED_CREATED = '1999-01-01 00:00:00';
const SPOOFED_UPDATED = '2099-01-01 00:00:00';
const AUTHOR_DATE = '2020-01-15T00:00:00Z';
const COMMITTER_DATE = '2099-06-01T00:00:00Z';

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function commitWithDates(repoPath) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-dates-'));
  try {
    gitSync(['init', '-b', 'main'], { cwd: work });
    gitSync(['config', 'commit.gpgsign', 'false'], { cwd: work });
    gitSync(['config', 'core.fsmonitor', 'false'], { cwd: work });
    gitSync(['config', 'user.email', 'ada@example.com'], { cwd: work });
    gitSync(['config', 'user.name', 'Ada'], { cwd: work });
    gitSync(['--git-dir', repoPath, 'config', 'core.fsmonitor', 'false']);
    fs.writeFileSync(path.join(work, 'notes.txt'), 'DATE_FILE_BODY_z3\n');
    gitSync(['add', '-A'], { cwd: work });
    gitSync(['commit', '-m', 'date-ship-z3'], {
      cwd: work,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'NiaDate',
        GIT_AUTHOR_EMAIL: 'nia-date@example.test',
        GIT_AUTHOR_DATE: AUTHOR_DATE,
        GIT_COMMITTER_NAME: 'ComDate',
        GIT_COMMITTER_EMAIL: 'com-date@example.test',
        GIT_COMMITTER_DATE: COMMITTER_DATE,
      },
    });
    gitSync(['remote', 'add', 'origin', repoPath], { cwd: work });
    gitSync(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

describe('server-owned columns and author timestamps', { concurrency: 1 }, () => {
  test('creating a repository ignores spoofed columns and keeps the private flag', async () => {
    await withApp(async (ctx) => {
      const victimSession = ctx.session();
      const victim = await registerUser(ctx, victimSession);
      await createRepo(victimSession, { name: 'kept', description: 'VICTIM_DESC_z7' });
      const victimName = `${victim.username}/kept`;
      const before = repoRow(ctx.db, victimName);

      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      const created = await owner.fetch('/new', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'hidden',
          description: 'SPOOF_DESC_z7',
          is_private: true,
          private: 0,
          default_branch: 'evil',
          created_at: SPOOFED_CREATED,
          updated_at: SPOOFED_UPDATED,
          id: 99999,
          owner_id: victim.id,
          full_name: `${victim.username}/hidden`,
          username: victim.username,
        }),
      });
      const createdText = await created.text();
      assert.equal(created.status, 302, createdText.slice(0, 200));
      assert.equal(created.headers.get('location'), `/${user.username}/hidden`);

      const row = repoRow(ctx.db, `${user.username}/hidden`);
      assert.equal(row.name, 'hidden');
      assert.equal(row.full_name, `${user.username}/hidden`);
      assert.equal(row.description, 'SPOOF_DESC_z7');
      assert.equal(row.owner_id, user.id);
      assert.equal(row.private, 1);
      assert.equal(row.default_branch, 'main');
      assert.notEqual(row.id, 99999);
      assert.notEqual(row.created_at, SPOOFED_CREATED);
      assert.notEqual(row.updated_at, SPOOFED_UPDATED);
      assert.deepEqual(repoRow(ctx.db, victimName), before);
      assert.equal(fs.existsSync(barePath(user.username, 'hidden')), true);
      assert.equal(fs.existsSync(barePath(victim.username, 'hidden')), false);
      assert.equal(
        gitSync(['--git-dir', barePath(user.username, 'hidden'), 'symbolic-ref', 'HEAD']).trim(),
        'refs/heads/main'
      );

      const stranger = ctx.session();
      const hidden = await stranger.fetch(`/${user.username}/hidden`);
      const hiddenHtml = await hidden.text();
      assert.equal(hidden.status, 404);
      assert.equal(hiddenHtml.includes('SPOOF_DESC_z7'), false);

      const home = await (await ctx.session().fetch('/')).text();
      assert.match(home, /VICTIM_DESC_z7/);
      assert.equal(home.includes('SPOOF_DESC_z7'), false);

      const found = await (await ctx.session().fetch('/api/search/repos?q=SPOOF_DESC_z7')).json();
      assert.deepEqual(found, []);

      const ownProfile = await (await owner.fetch(`/@${encodeURIComponent(user.username)}`)).text();
      assert.match(ownProfile, /hidden/);
      assert.match(ownProfile, /badge-private/);
      assert.equal(ownProfile.includes('badge-public'), false);
      assert.equal(ownProfile.includes('evil'), false);
      assert.match(ownProfile, /main/);

      const otherProfile = await (await stranger.fetch(`/@${encodeURIComponent(user.username)}`)).text();
      assert.match(otherProfile, /No repositories yet/);
      assert.equal(otherProfile.includes('SPOOF_DESC_z7'), false);

      const ownApi = await (await owner.fetch(`/api/users/${encodeURIComponent(user.username)}/repos`)).json();
      assert.equal(ownApi.length, 1);
      assert.equal(ownApi[0].private, 1);
      assert.equal(ownApi[0].default_branch, 'main');
      assert.equal(ownApi[0].owner_id, user.id);
      assert.equal(Object.hasOwn(ownApi[0], 'password'), false);

      const strangerApi = await (await stranger.fetch(`/api/users/${encodeURIComponent(user.username)}/repos`)).json();
      assert.deepEqual(strangerApi, []);
    });
  });

  test('registration ignores spoofed identity columns', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const username = ctx.nextId('stamp');
      const email = `${username}@example.test`;
      const password = 'correct-horse';
      ctx.users.add(username);
      const created = await session.postForm('/register', {
        username,
        email,
        password,
        id: '99999',
        bio: 'BIO_SPOOF_z6',
        created_at: SPOOFED_CREATED,
      });
      assert.equal(created.status, 302);
      assert.equal(created.headers.get('location'), '/');
      await created.text();

      const row = ctx.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      assert.notEqual(row.id, 99999);
      assert.equal(row.email, email);
      assert.equal(row.bio, '');
      assert.notEqual(row.created_at, SPOOFED_CREATED);
      assert.match(row.password, /^\$2[aby]\$10\$/);
      assert.notEqual(row.password, password);

      const profile = await (await session.fetch(`/@${encodeURIComponent(username)}`)).text();
      assert.match(profile, /Joined /);
      assert.equal(profile.includes('January 1999'), false);
      assert.equal(profile.includes('BIO_SPOOF_z6'), false);
      assert.equal(profile.includes(password), false);
      assert.equal(profile.includes(row.password), false);
      assert.match(profile, /Log out/);
    });
  });

  test('short credentials do not reveal that an account already exists', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      const hash = passwordHash(ctx.db, user.username);
      const beforeCount = ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

      const sameName = ctx.session();
      const shortPassword = await sameName.postForm('/register', {
        username: user.username,
        email: `fresh-${user.username}@example.test`,
        password: 'abcde',
      });
      const shortText = await shortPassword.text();
      assert.equal(shortPassword.status, 200);
      assert.match(shortText, /Password too short/);
      assert.equal(shortText.includes('User already exists'), false);
      assert.equal(shortText.includes(hash), false);
      assert.equal(shortText.includes(user.password), false);
      assert.equal(
        ctx.db.prepare('SELECT id FROM users WHERE email = ?').get(`fresh-${user.username}@example.test`),
        undefined
      );
      assert.doesNotMatch(await (await sameName.fetch('/')).text(), /Log out/);

      const sameEmail = ctx.session();
      const shortName = await sameEmail.postForm('/register', {
        username: 'ab',
        email: user.email,
        password: 'brand-new-password',
      });
      const nameText = await shortName.text();
      assert.equal(shortName.status, 200);
      assert.match(nameText, /Username too short/);
      assert.equal(nameText.includes('User already exists'), false);
      assert.equal(nameText.includes('brand-new-password'), false);
      assert.equal(nameText.includes(hash), false);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get(user.email).n, 1);
      assert.equal(passwordHash(ctx.db, user.username), hash);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, beforeCount);
      assert.match(await (await owner.fetch('/')).text(), /Log out/);
      assert.doesNotMatch(await (await sameEmail.fetch('/')).text(), /Log out/);
    });
  });

  test('commit history shows the author date and not the committer date', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'dated', description: '' });
      const bare = barePath(user.username, 'dated');
      commitWithDates(bare);

      assert.match(gitSync(['--git-dir', bare, 'log', '-1', '--format=%aI']).trim(), /^2020-01-15/);
      assert.match(gitSync(['--git-dir', bare, 'log', '-1', '--format=%cI']).trim(), /^2099-06-01/);
      assert.equal(gitSync(['--git-dir', bare, 'log', '-1', '--format=%an']).trim(), 'NiaDate');
      assert.equal(gitSync(['--git-dir', bare, 'log', '-1', '--format=%cn']).trim(), 'ComDate');

      const historyRes = await ctx.session().fetch(`/${user.username}/dated/commits`);
      const history = await historyRes.text();
      assert.equal(historyRes.status, 200);
      assert.match(history, /date-ship-z3/);
      assert.match(history, /NiaDate/);
      assert.match(history, /years ago/);
      assert.equal(history.includes('ComDate'), false);
      assert.equal(history.includes('nia-date@example.test'), false);
      assert.equal(history.includes('com-date@example.test'), false);
      assert.equal(history.includes('2020-01-15'), false);
      assert.equal(history.includes('2099-06-01'), false);
      assert.equal(history.includes('Invalid date'), false);
      assert.doesNotMatch(history, /in \d+ years/);
      assert.equal(history.includes('DATE_FILE_BODY_z3'), false);

      const page = await (await ctx.session().fetch(`/${user.username}/dated`)).text();
      assert.match(page, /date-ship-z3/);
      assert.match(page, /notes\.txt/);
      assert.equal(page.includes('DATE_FILE_BODY_z3'), false);
      assert.equal(page.includes('ComDate'), false);

      const blob = await (await owner.fetch(`/${user.username}/dated/blob/main/notes.txt`)).text();
      assert.match(blob, /DATE_FILE_BODY_z3/);
    });
  });
});
