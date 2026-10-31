const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertUpdatedAtStays,
  barePath,
  basicAuth,
  commitToBare,
  createRepo,
  gitSync,
  passwordHash,
  pushFiles,
  registerUser,
  remoteUrl,
  repoRow,
  setUpdatedAt,
  start,
  waitForUpdatedAt,
} = require('./helpers');

const FROZEN = '2000-01-01 00:00:00';

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function strangerRemote(ctx, ownerName, repo, authUser, password) {
  return `http://${encodeURIComponent(authUser)}:${encodeURIComponent(password)}@127.0.0.1:${ctx.port}/${encodeURIComponent(ownerName)}/${encodeURIComponent(repo)}.git`;
}

function commitLinks(repoPath, { files, links, message }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-link-'));
  try {
    gitSync(['init', '-b', 'main'], { cwd: work });
    gitSync(['config', 'commit.gpgsign', 'false'], { cwd: work });
    gitSync(['config', 'core.fsmonitor', 'false'], { cwd: work });
    gitSync(['config', 'user.email', 'ada@example.com'], { cwd: work });
    gitSync(['config', 'user.name', 'Ada'], { cwd: work });
    gitSync(['--git-dir', repoPath, 'config', 'core.fsmonitor', 'false']);
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(work, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    for (const [name, target] of Object.entries(links)) {
      fs.symlinkSync(target, path.join(work, name));
    }
    gitSync(['add', '-A'], { cwd: work });
    gitSync(['commit', '-m', message], { cwd: work });
    gitSync(['remote', 'add', 'origin', repoPath], { cwd: work });
    gitSync(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

describe('repository tenancy and read boundaries', { concurrency: 1 }, () => {
  test('a push or delete for one owner does not change the other owner\'s repository of the same name', async () => {
    await withApp(async (ctx) => {
      const leftSession = ctx.session();
      const left = await registerUser(ctx, leftSession);
      const rightSession = ctx.session();
      const right = await registerUser(ctx, rightSession);
      await createRepo(leftSession, { name: 'notes', description: 'LEFT_NOTES_DESC' });
      await createRepo(rightSession, { name: 'notes', description: 'RIGHT_NOTES_DESC' });
      commitToBare(barePath(left.username, 'notes'), {
        files: { 'keep.txt': 'LEFT_KEEP_BODY\n' },
        message: 'left-ship',
      });
      const leftName = `${left.username}/notes`;
      const rightName = `${right.username}/notes`;
      const leftHead = gitSync(['--git-dir', barePath(left.username, 'notes'), 'rev-parse', 'HEAD']).trim();
      setUpdatedAt(ctx.db, leftName, FROZEN);
      setUpdatedAt(ctx.db, rightName, FROZEN);
      assert.notEqual(barePath(left.username, 'notes'), barePath(right.username, 'notes'));
      assert.notEqual(repoRow(ctx.db, leftName).owner_id, repoRow(ctx.db, rightName).owner_id);

      const deniedDelete = await rightSession.postForm(`/${left.username}/notes/settings/delete`, {});
      assert.equal(deniedDelete.status, 403);
      const deniedDeleteBody = await deniedDelete.text();
      assert.equal(deniedDeleteBody.includes('LEFT_KEEP_BODY'), false);
      assert.equal(deniedDeleteBody.includes(right.password), false);
      assert.equal(repoRow(ctx.db, leftName).description, 'LEFT_NOTES_DESC');
      assert.equal(repoRow(ctx.db, rightName).description, 'RIGHT_NOTES_DESC');

      const deniedPack = await ctx.session().fetch(`/${left.username}/notes/git-receive-pack`, {
        method: 'POST',
        headers: { authorization: basicAuth(right.username, right.password) },
        body: '',
      });
      assert.equal(deniedPack.status, 403);
      const deniedPackBody = await deniedPack.text();
      assert.match(deniedPackBody, /Permission denied/);
      assert.equal(deniedPackBody.includes(right.password), false);
      assert.equal(deniedPackBody.includes(passwordHash(ctx.db, right.username)), false);

      const attack = await pushFiles({
        url: strangerRemote(ctx, left.username, 'notes', right.username, right.password),
        files: { 'pushed.txt': 'ATTACK_BODY\n' },
        message: 'attack-ship',
        force: true,
      });
      assert.notEqual(attack.code, 0);
      await assertUpdatedAtStays(ctx.db, leftName, FROZEN, 400);
      assert.equal(repoRow(ctx.db, rightName).updated_at, FROZEN);
      assert.equal(gitSync(['--git-dir', barePath(left.username, 'notes'), 'rev-parse', 'HEAD']).trim(), leftHead);

      const leftBlob = await (await ctx.session().fetch(`/${left.username}/notes/blob/main/keep.txt`)).text();
      assert.match(leftBlob, /LEFT_KEEP_BODY/);
      assert.equal(leftBlob.includes('ATTACK_BODY'), false);
      const leftPage = await (await ctx.session().fetch(`/${left.username}/notes`)).text();
      assert.match(leftPage, /LEFT_NOTES_DESC/);
      assert.equal(leftPage.includes('ATTACK_BODY'), false);
      assert.equal(leftPage.includes('RIGHT_NOTES_DESC'), false);
      const refs = await (await ctx.session().fetch(`/${left.username}/notes/info/refs?service=git-upload-pack`)).text();
      assert.match(refs, new RegExp(leftHead));

      const pushed = await pushFiles({
        url: remoteUrl(ctx, right.username, 'notes', right.password),
        files: { 'pushed.txt': 'RIGHT_PUSH_BODY\n' },
        message: 'right-ship',
      });
      assert.equal(pushed.code, 0, pushed.stderr);
      const refreshed = await waitForUpdatedAt(ctx.db, rightName, FROZEN);
      assert.notEqual(refreshed, FROZEN);
      await assertUpdatedAtStays(ctx.db, leftName, FROZEN, 400);
      assert.equal(gitSync(['--git-dir', barePath(left.username, 'notes'), 'rev-parse', 'HEAD']).trim(), leftHead);
      const rightHead = gitSync(['--git-dir', barePath(right.username, 'notes'), 'rev-parse', 'HEAD']).trim();
      assert.notEqual(rightHead, leftHead);

      const rightBlob = await (await ctx.session().fetch(`/${right.username}/notes/blob/main/pushed.txt`)).text();
      assert.match(rightBlob, /RIGHT_PUSH_BODY/);
      assert.equal(rightBlob.includes('LEFT_KEEP_BODY'), false);
      assert.equal(rightBlob.includes('ATTACK_BODY'), false);
      const stillLeft = await (await leftSession.fetch(`/${left.username}/notes/blob/main/keep.txt`)).text();
      assert.match(stillLeft, /LEFT_KEEP_BODY/);
      assert.equal(stillLeft.includes('RIGHT_PUSH_BODY'), false);
      const rightPage = await (await rightSession.fetch(`/${right.username}/notes`)).text();
      assert.match(rightPage, /RIGHT_NOTES_DESC/);
      assert.match(rightPage, /right-ship/);
      assert.equal(rightPage.includes('LEFT_KEEP_BODY'), false);
      assert.equal(rightPage.includes('left-ship'), false);
    });
  });

  test('deleting a repository does not remove another whose name only starts with that name', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const user = await registerUser(ctx, session);
      await createRepo(session, { name: 'kit', description: 'KIT_ONLY_DESC' });
      await createRepo(session, { name: 'kitchen', description: 'KITCHEN_ONLY_DESC' });
      commitToBare(barePath(user.username, 'kit'), {
        files: { 'kit.txt': 'KIT_FILE_BODY\n' },
        message: 'kit-ship',
      });
      commitToBare(barePath(user.username, 'kitchen'), {
        files: { 'kitchen.txt': 'KITCHEN_FILE_BODY\n' },
        message: 'kitchen-ship',
      });
      const kitchenHead = gitSync(['--git-dir', barePath(user.username, 'kitchen'), 'rev-parse', 'HEAD']).trim();

      const removed = await session.postForm(`/${user.username}/kit/settings/delete`, {});
      assert.equal(removed.status, 302);
      assert.equal(removed.headers.get('location'), `/@${user.username}`);
      await removed.text();

      assert.equal(repoRow(ctx.db, `${user.username}/kit`), undefined);
      assert.equal(fs.existsSync(barePath(user.username, 'kit')), false);
      assert.equal(repoRow(ctx.db, `${user.username}/kitchen`).description, 'KITCHEN_ONLY_DESC');
      assert.equal(fs.existsSync(barePath(user.username, 'kitchen')), true);
      assert.equal(gitSync(['--git-dir', barePath(user.username, 'kitchen'), 'rev-parse', 'HEAD']).trim(), kitchenHead);

      const kitchenBlob = await (await session.fetch(`/${user.username}/kitchen/blob/main/kitchen.txt`)).text();
      assert.match(kitchenBlob, /KITCHEN_FILE_BODY/);
      assert.equal(kitchenBlob.includes('KIT_FILE_BODY'), false);
      const kitchenPage = await (await session.fetch(`/${user.username}/kitchen`)).text();
      assert.match(kitchenPage, /KITCHEN_ONLY_DESC/);
      assert.match(kitchenPage, /kitchen-ship/);
      assert.equal(kitchenPage.includes('KIT_ONLY_DESC'), false);
      assert.equal(kitchenPage.includes('KIT_FILE_BODY'), false);
      const gone = await session.fetch(`/${user.username}/kit`);
      assert.equal(gone.status, 404);
      assert.equal((await gone.text()).includes('KIT_FILE_BODY'), false);

      const profile = await (await session.fetch(`/@${encodeURIComponent(user.username)}`)).text();
      assert.match(profile, /KITCHEN_ONLY_DESC/);
      assert.equal(profile.includes('KIT_ONLY_DESC'), false);
      const home = await (await ctx.session().fetch('/')).text();
      assert.match(home, /KITCHEN_ONLY_DESC/);
      assert.equal(home.includes('KIT_ONLY_DESC'), false);
    });
  });

  test('a username prefix does not reveal the longer account\'s private repository', async () => {
    await withApp(async (ctx) => {
      const pamSession = ctx.session();
      const pam = await registerUser(ctx, pamSession, { username: 'pam', password: 'pam-pass-7k2' });
      const pamelaSession = ctx.session();
      const pamela = await registerUser(ctx, pamelaSession, { username: 'pamela', password: 'pamela-pass-7k2' });
      await createRepo(pamSession, { name: 'vault', description: 'PAM_ONLY_DESC', isPrivate: true });
      await createRepo(pamelaSession, { name: 'vault', description: 'PAMELA_ONLY_DESC', isPrivate: true });
      commitToBare(barePath(pam.username, 'vault'), {
        files: { 'secret.txt': 'PAM_FILE_SECRET\n' },
        message: 'pam-ship',
      });
      commitToBare(barePath(pamela.username, 'vault'), {
        files: { 'secret.txt': 'PAMELA_FILE_SECRET\n' },
        message: 'pamela-ship',
      });
      assert.notEqual(passwordHash(ctx.db, 'pam'), passwordHash(ctx.db, 'pamela'));

      const pamRepos = await (await pamSession.fetch('/api/users/pam/repos')).json();
      assert.deepEqual(pamRepos.map((repo) => repo.full_name), ['pam/vault']);
      assert.equal(pamRepos[0].description, 'PAM_ONLY_DESC');
      assert.equal(pamRepos[0].private, 1);
      assert.equal(JSON.stringify(pamRepos).includes('PAMELA_ONLY_DESC'), false);
      assert.equal(JSON.stringify(pamRepos).includes('PAMELA_FILE_SECRET'), false);

      const pamelaRepos = await (await pamelaSession.fetch('/api/users/pamela/repos')).json();
      assert.deepEqual(pamelaRepos.map((repo) => repo.full_name), ['pamela/vault']);
      assert.equal(pamelaRepos[0].description, 'PAMELA_ONLY_DESC');
      assert.equal(JSON.stringify(pamelaRepos).includes('PAM_ONLY_DESC'), false);
      assert.equal(JSON.stringify(pamelaRepos).includes('PAM_FILE_SECRET'), false);

      assert.deepEqual(await (await ctx.session().fetch('/api/users/pam/repos')).json(), []);
      assert.deepEqual(await (await ctx.session().fetch('/api/users/pamela/repos')).json(), []);
      assert.deepEqual(await (await ctx.session().fetch('/api/search/repos?q=PAM_ONLY_DESC')).json(), []);
      assert.deepEqual(await (await ctx.session().fetch('/api/search/repos?q=PAMELA_ONLY_DESC')).json(), []);
      assert.deepEqual(await (await pamSession.fetch('/api/search/repos?q=PAM')).json(), []);

      const pamProfile = await (await pamSession.fetch('/@pam')).text();
      assert.match(pamProfile, /PAM_ONLY_DESC/);
      assert.equal(pamProfile.includes('PAMELA_ONLY_DESC'), false);
      assert.equal(pamProfile.includes('PAMELA_FILE_SECRET'), false);
      const strangerProfile = await (await pamelaSession.fetch('/@pam')).text();
      assert.match(strangerProfile, /No repositories yet/);
      assert.equal(strangerProfile.includes('PAM_ONLY_DESC'), false);
      assert.equal(strangerProfile.includes('PAM_FILE_SECRET'), false);

      const ownBlob = await pamSession.fetch('/pam/vault/blob/main/secret.txt');
      assert.equal(ownBlob.status, 200);
      assert.match(await ownBlob.text(), /PAM_FILE_SECRET/);
      const crossBlob = await pamelaSession.fetch('/pam/vault/blob/main/secret.txt');
      assert.equal(crossBlob.status, 404);
      assert.equal((await crossBlob.text()).includes('PAM_FILE_SECRET'), false);
      const otherBlob = await pamSession.fetch('/pamela/vault/blob/main/secret.txt');
      assert.equal(otherBlob.status, 404);
      assert.equal((await otherBlob.text()).includes('PAMELA_FILE_SECRET'), false);

      const home = await (await ctx.session().fetch('/')).text();
      assert.equal(home.includes('PAM_ONLY_DESC'), false);
      assert.equal(home.includes('PAMELA_ONLY_DESC'), false);
      assert.equal(home.includes('PAM_FILE_SECRET'), false);
      assert.equal(home.includes('PAMELA_FILE_SECRET'), false);
    });
  });

  test('opening a repository does not change its updated time or its place in the list', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const user = await registerUser(ctx, session);
      await createRepo(session, { name: 'older', description: 'OLDER_PAGE_DESC' });
      await createRepo(session, { name: 'viewed', description: 'VIEWED_PAGE_DESC' });
      commitToBare(barePath(user.username, 'viewed'), {
        files: { 'note.txt': 'VIEWED_FILE_BODY\n' },
        message: 'viewed-ship',
      });
      const viewedName = `${user.username}/viewed`;
      const olderName = `${user.username}/older`;
      setUpdatedAt(ctx.db, olderName, '2019-01-01 00:00:00');
      setUpdatedAt(ctx.db, viewedName, '2018-01-01 00:00:00');

      const repoPage = await session.fetch(`/${user.username}/viewed`);
      assert.equal(repoPage.status, 200);
      assert.match(await repoPage.text(), /viewed-ship/);
      const blob = await session.fetch(`/${user.username}/viewed/blob/main/note.txt`);
      assert.equal(blob.status, 200);
      assert.match(await blob.text(), /VIEWED_FILE_BODY/);
      const commits = await session.fetch(`/${user.username}/viewed/commits`);
      assert.equal(commits.status, 200);
      assert.match(await commits.text(), /viewed-ship/);
      const settings = await session.fetch(`/${user.username}/viewed/settings`);
      assert.equal(settings.status, 200);
      await settings.text();
      const strangerSettings = await ctx.session().fetch(`/${user.username}/viewed/settings`);
      assert.equal(strangerSettings.status, 403);
      await strangerSettings.text();
      const anonRepo = await ctx.session().fetch(`/${user.username}/viewed`);
      assert.equal(anonRepo.status, 200);
      await anonRepo.text();
      const profile = await (await session.fetch(`/@${encodeURIComponent(user.username)}`)).text();
      const olderAtProfile = profile.indexOf('OLDER_PAGE_DESC');
      const viewedAtProfile = profile.indexOf('VIEWED_PAGE_DESC');
      assert.ok(olderAtProfile >= 0);
      assert.ok(viewedAtProfile > olderAtProfile);

      const home = await (await ctx.session().fetch('/')).text();
      const olderAtHome = home.indexOf('OLDER_PAGE_DESC');
      const viewedAtHome = home.indexOf('VIEWED_PAGE_DESC');
      assert.ok(olderAtHome >= 0);
      assert.ok(viewedAtHome > olderAtHome);
      const found = await (await ctx.session().fetch('/api/search/repos?q=PAGE_DESC')).json();
      assert.deepEqual(found.map((repo) => repo.name), ['older', 'viewed']);
      const listed = await (await session.fetch(`/api/users/${encodeURIComponent(user.username)}/repos`)).json();
      assert.deepEqual(listed.map((repo) => repo.name), ['older', 'viewed']);

      await assertUpdatedAtStays(ctx.db, viewedName, '2018-01-01 00:00:00', 400);
      assert.equal(repoRow(ctx.db, olderName).updated_at, '2019-01-01 00:00:00');
    });
  });

  test('a symlink blob serves the link text and not the target file', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const user = await registerUser(ctx, session);
      await createRepo(session, { name: 'links', description: 'links' });
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-out-'));
      const outsideFile = path.join(outsideDir, 'secret.txt');
      try {
        fs.writeFileSync(outsideFile, 'OUTSIDE_SENTINEL_z7\n');
        commitLinks(barePath(user.username, 'links'), {
          files: { 'inside.txt': 'INSIDE_BODY_z7\n' },
          links: {
            'inside-link': 'inside.txt',
            'outside-link': outsideFile,
          },
          message: 'link-ship',
        });
        const tree = gitSync(['--git-dir', barePath(user.username, 'links'), 'ls-tree', 'HEAD']);
        assert.match(tree, /120000 blob \S+\tinside-link/);
        assert.match(tree, /120000 blob \S+\toutside-link/);
        assert.match(tree, /100644 blob \S+\tinside.txt/);
        fs.rmSync(outsideFile, { force: true });

        const inside = await session.fetch(`/${user.username}/links/blob/main/inside.txt`);
        assert.equal(inside.status, 200);
        const insideBody = await inside.text();
        assert.match(insideBody, /INSIDE_BODY_z7/);
        assert.equal(insideBody.includes('OUTSIDE_SENTINEL_z7'), false);

        const alias = await ctx.session().fetch(`/${user.username}/links/blob/main/inside-link`);
        assert.equal(alias.status, 200);
        const aliasBody = await alias.text();
        assert.match(aliasBody, /inside\.txt/);
        assert.equal(aliasBody.includes('INSIDE_BODY_z7'), false);
        assert.equal(aliasBody.includes('OUTSIDE_SENTINEL_z7'), false);

        const outside = await ctx.session().fetch(`/${user.username}/links/blob/main/outside-link`);
        assert.equal(outside.status, 200);
        const outsideBody = await outside.text();
        assert.match(outsideBody, /secret\.txt/);
        assert.equal(outsideBody.includes('OUTSIDE_SENTINEL_z7'), false);

        const page = await (await ctx.session().fetch(`/${user.username}/links`)).text();
        assert.match(page, /inside-link/);
        assert.match(page, /outside-link/);
        assert.equal(page.includes('INSIDE_BODY_z7'), false);
        assert.equal(page.includes('OUTSIDE_SENTINEL_z7'), false);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  test('failed login and duplicate registration do not echo the password', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const password = 'stable-pass-7k2m';
      const user = await registerUser(ctx, owner, { password });
      const hash = passwordHash(ctx.db, user.username);

      const wrongPassword = 'login-echo-7k2m';
      const login = ctx.session();
      const failed = await login.postForm('/login', { username: user.username, password: wrongPassword });
      assert.equal(failed.status, 200);
      assert.equal(failed.headers.get('location'), null);
      const failedBody = await failed.text();
      assert.match(failedBody, /Invalid credentials/);
      assert.equal(failedBody.includes(wrongPassword), false);
      assert.equal(failedBody.includes(password), false);
      assert.equal(failedBody.includes(hash), false);
      assert.doesNotMatch(await (await login.fetch('/')).text(), /Log out/);
      assert.equal(passwordHash(ctx.db, user.username), hash);

      const attempted = 'register-echo-7k2m';
      const duplicate = ctx.session();
      const again = await duplicate.postForm('/register', {
        username: user.username,
        email: user.email,
        password: attempted,
      });
      assert.equal(again.status, 200);
      assert.equal(again.headers.get('location'), null);
      const againBody = await again.text();
      assert.match(againBody, /User already exists/);
      assert.equal(againBody.includes(attempted), false);
      assert.equal(againBody.includes(password), false);
      assert.equal(againBody.includes(hash), false);
      assert.doesNotMatch(await (await duplicate.fetch('/')).text(), /Log out/);
      assert.equal(passwordHash(ctx.db, user.username), hash);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
      assert.match(await (await owner.fetch('/')).text(), /Log out/);
    });
  });

  test('commits that share a message stay distinct', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const user = await registerUser(ctx, session);
      await createRepo(session, { name: 'dup', description: 'dup' });
      const hashes = commitToBare(barePath(user.username, 'dup'), {
        revisions: [
          { files: { 'note.txt': 'BODY_ONE_z3\n' }, message: 'same-ship' },
          { files: { 'note.txt': 'BODY_TWO_z3\n' }, message: 'same-ship' },
        ],
      });
      const short = hashes.map((hash) => hash.slice(0, 7));
      assert.equal(hashes.length, 2);
      assert.notEqual(short[0], short[1]);

      const commits = await (await session.fetch(`/${user.username}/dup/commits`)).text();
      assert.match(commits, new RegExp(short[0]));
      assert.match(commits, new RegExp(short[1]));
      const firstAt = commits.indexOf(short[1]);
      const secondAt = commits.indexOf(short[0]);
      assert.ok(firstAt >= 0);
      assert.ok(secondAt > firstAt);

      const repoPage = await (await ctx.session().fetch(`/${user.username}/dup`)).text();
      assert.match(repoPage, new RegExp(short[0]));
      assert.match(repoPage, new RegExp(short[1]));
      assert.equal(repoPage.includes('BODY_ONE_z3'), false);
      assert.equal(repoPage.includes('BODY_TWO_z3'), false);

      const older = await (await session.fetch(`/${user.username}/dup/blob/${hashes[0]}/note.txt`)).text();
      assert.match(older, /BODY_ONE_z3/);
      assert.equal(older.includes('BODY_TWO_z3'), false);
      const head = await (await session.fetch(`/${user.username}/dup/blob/main/note.txt`)).text();
      assert.match(head, /BODY_TWO_z3/);
      assert.equal(head.includes('BODY_ONE_z3'), false);
    });
  });
});
