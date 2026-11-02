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
  registerUser,
  repoRow,
  setUpdatedAt,
  start,
  waitForUpdatedAt,
} = require('./helpers');

const FROZEN = '2018-01-01 00:00:00';

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

describe('ownership and history bounds', { concurrency: 1 }, () => {
  test('a session cookie cannot grant or replace basic auth for receive-pack', async () => {
    await withApp(async (ctx) => {
      const ownerSession = ctx.session();
      const owner = await registerUser(ctx, ownerSession, { password: 'owner-pack-z5' });
      const strangerSession = ctx.session();
      const stranger = await registerUser(ctx, strangerSession, { password: 'stranger-pack-z5' });
      await createRepo(ownerSession, { name: 'writes', description: 'owned writes' });
      await createRepo(ownerSession, { name: 'sibling', description: 'owned sibling' });
      const bare = barePath(owner.username, 'writes');
      commitToBare(bare, { files: { 'keep.txt': 'KEEP_PACK_z5\n' }, message: 'keep-pack' });
      const head = gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim();
      const target = `${owner.username}/writes`;
      const sibling = `${owner.username}/sibling`;
      setUpdatedAt(ctx.db, target, FROZEN);
      setUpdatedAt(ctx.db, sibling, FROZEN);
      const pack = `/${owner.username}/writes/git-receive-pack`;

      async function postPack(session, authorization) {
        const res = await session.fetch(pack, {
          method: 'POST',
          headers: { authorization },
          body: '',
        });
        const text = await res.text();
        return { status: res.status, text, type: res.headers.get('content-type') };
      }

      const cookieEscalation = await postPack(ownerSession, basicAuth(stranger.username, stranger.password));
      assert.equal(cookieEscalation.status, 403);
      assert.match(cookieEscalation.text, /Permission denied/);
      assert.equal(cookieEscalation.text.includes(owner.password), false);
      assert.equal(cookieEscalation.text.includes(stranger.password), false);
      assert.equal(cookieEscalation.text.includes(passwordHash(ctx.db, owner.username)), false);
      await assertUpdatedAtStays(ctx.db, target, FROZEN, 400);
      assert.equal(repoRow(ctx.db, sibling).updated_at, FROZEN);
      assert.equal(gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim(), head);

      const basicWins = await postPack(strangerSession, basicAuth(owner.username, owner.password));
      assert.equal(basicWins.status, 200);
      assert.equal(basicWins.type, 'application/x-git-receive-pack-result');
      assert.equal(basicWins.text.includes(owner.password), false);
      assert.equal(basicWins.text.includes(stranger.password), false);
      const refreshed = await waitForUpdatedAt(ctx.db, target, FROZEN);
      assert.notEqual(refreshed, FROZEN);
      assert.equal(repoRow(ctx.db, sibling).updated_at, FROZEN);
      assert.equal(gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim(), head);
      const blob = await (await ownerSession.fetch(`/${owner.username}/writes/blob/main/keep.txt`)).text();
      assert.match(blob, /KEEP_PACK_z5/);
      assert.equal(ownerSession.cookies.size > 0, true);
      assert.equal(strangerSession.cookies.size > 0, true);
    });
  });

  test('creating a repository ignores a spoofed owner', async () => {
    await withApp(async (ctx) => {
      const victimSession = ctx.session();
      const victim = await registerUser(ctx, victimSession, { password: 'victim-create-z3' });
      await createRepo(victimSession, { name: 'secret', description: 'VICTIM_SECRET_z3', isPrivate: true });
      const attackerSession = ctx.session();
      const attacker = await registerUser(ctx, attackerSession, { password: 'attacker-create-z3' });

      const created = await attackerSession.postForm('/new', {
        name: 'taken',
        description: 'ATTACKER_DESC_z3',
        username: victim.username,
        owner: victim.username,
        owner_id: String(victim.id),
        userId: String(victim.id),
        full_name: `${victim.username}/taken`,
      });
      assert.equal(created.status, 302);
      assert.equal(created.headers.get('location'), `/${attacker.username}/taken`);
      await created.text();

      const row = repoRow(ctx.db, `${attacker.username}/taken`);
      assert.equal(row.owner_id, attacker.id);
      assert.equal(row.name, 'taken');
      assert.equal(row.private, 0);
      assert.equal(row.description, 'ATTACKER_DESC_z3');
      assert.equal(repoRow(ctx.db, `${victim.username}/taken`), undefined);
      assert.equal(fs.existsSync(barePath(attacker.username, 'taken')), true);
      assert.equal(fs.existsSync(barePath(victim.username, 'taken')), false);
      assert.equal(fs.existsSync(barePath(victim.username, 'secret')), true);

      const victimRepos = await (await victimSession.fetch(`/api/users/${encodeURIComponent(victim.username)}/repos`)).json();
      assert.deepEqual(victimRepos.map((repo) => repo.name), ['secret']);
      const attackerRepos = await (await attackerSession.fetch(`/api/users/${encodeURIComponent(attacker.username)}/repos`)).json();
      assert.deepEqual(attackerRepos.map((repo) => repo.name), ['taken']);

      const home = await (await ctx.session().fetch('/')).text();
      assert.match(home, /ATTACKER_DESC_z3/);
      assert.equal(home.includes('VICTIM_SECRET_z3'), false);

      const peek = await attackerSession.fetch(`/${victim.username}/secret`);
      assert.equal(peek.status, 404);
      assert.equal((await peek.text()).includes('VICTIM_SECRET_z3'), false);

      const denied = await victimSession.postForm(`/${attacker.username}/taken/settings/delete`, {
        owner: victim.username,
        name: 'secret',
      });
      assert.equal(denied.status, 403);
      await denied.text();
      assert.equal(repoRow(ctx.db, `${attacker.username}/taken`).description, 'ATTACKER_DESC_z3');
      assert.equal(repoRow(ctx.db, `${victim.username}/secret`).description, 'VICTIM_SECRET_z3');
    });
  });

  test('registration and login ignore a spoofed user id', async () => {
    await withApp(async (ctx) => {
      const victimSession = ctx.session();
      const victimName = ctx.nextId('vic');
      const victim = await registerUser(ctx, victimSession, {
        username: victimName,
        password: 'victim-login-z7',
      });
      await createRepo(victimSession, { name: 'vault', description: 'VICTIM_VAULT_z7', isPrivate: true });
      const victimHash = passwordHash(ctx.db, victim.username);

      const attackerSession = ctx.session();
      const attackerName = ctx.nextId('atk');
      const attackerPassword = 'attacker-login-z7';
      ctx.users.add(attackerName);
      const registered = await attackerSession.postForm('/register', {
        username: attackerName,
        email: `${attackerName}@example.test`,
        password: attackerPassword,
        id: String(victim.id),
        userId: String(victim.id),
      });
      assert.equal(registered.status, 302);
      assert.equal(registered.headers.get('location'), '/');
      await registered.text();

      const attacker = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(attackerName);
      assert.ok(attacker);
      assert.notEqual(attacker.id, victim.id);
      assert.equal(passwordHash(ctx.db, victim.username), victimHash);
      assert.notEqual(passwordHash(ctx.db, attackerName), victimHash);
      assert.match(passwordHash(ctx.db, attackerName), /^\$2[aby]\$/);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);

      const registeredHome = await (await attackerSession.fetch('/')).text();
      assert.match(registeredHome, new RegExp(`/@${attackerName}`));
      assert.equal(registeredHome.includes(`/@${victim.username}`), false);
      assert.equal(registeredHome.includes('VICTIM_VAULT_z7'), false);

      const spoofed = ctx.session();
      const logged = await spoofed.postForm('/login', {
        username: attackerName,
        password: attackerPassword,
        id: String(victim.id),
        userId: String(victim.id),
      });
      assert.equal(logged.status, 302);
      assert.equal(logged.headers.get('location'), '/');
      await logged.text();
      const spoofHome = await (await spoofed.fetch('/')).text();
      assert.match(spoofHome, new RegExp(`/@${attackerName}`));
      assert.equal(spoofHome.includes(`/@${victim.username}`), false);
      const hidden = await spoofed.fetch(`/${victim.username}/vault`);
      assert.equal(hidden.status, 404);
      assert.equal((await hidden.text()).includes('VICTIM_VAULT_z7'), false);

      const victimAgain = ctx.session();
      const victimLogin = await victimAgain.postForm('/login', {
        username: victim.email,
        password: victim.password,
        id: String(attacker.id),
        userId: String(attacker.id),
      });
      assert.equal(victimLogin.status, 302);
      await victimLogin.text();
      const victimHome = await (await victimAgain.fetch('/')).text();
      assert.match(victimHome, new RegExp(`/@${victim.username}`));
      assert.equal(victimHome.includes(`/@${attackerName}`), false);
      const vault = await (await victimAgain.fetch(`/${victim.username}/vault`)).text();
      assert.match(vault, /VICTIM_VAULT_z7/);
      assert.equal(passwordHash(ctx.db, victim.username), victimHash);
    });
  });

  test('the stored bcrypt hash is not a valid password', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const user = await registerUser(ctx, session, { password: 'correct-horse' });
      await createRepo(session, { name: 'notes', description: 'hash notes' });
      const hash = passwordHash(ctx.db, user.username);
      assert.notEqual(hash, user.password);
      assert.match(hash, /^\$2[aby]\$/);
      const fullName = `${user.username}/notes`;
      setUpdatedAt(ctx.db, fullName, FROZEN);

      const denied = await ctx.session().postForm('/login', { username: user.username, password: hash });
      assert.equal(denied.status, 200);
      assert.equal(denied.headers.get('location'), null);
      assert.equal(denied.headers.getSetCookie().some((cookie) => cookie.startsWith('connect.sid=')), false);
      const deniedText = await denied.text();
      assert.match(deniedText, /Invalid credentials/);
      assert.equal(deniedText.includes(hash), false);
      assert.equal(deniedText.includes(user.password), false);
      assert.equal(passwordHash(ctx.db, user.username), hash);

      const packed = await ctx.session().fetch(`/${user.username}/notes/git-receive-pack`, {
        method: 'POST',
        headers: { authorization: basicAuth(user.username, hash) },
        body: '',
      });
      const packedText = await packed.text();
      assert.equal(packed.status, 401);
      assert.equal(packed.headers.get('www-authenticate'), 'Basic realm="GITGRAM"');
      assert.match(packedText, /Invalid credentials/);
      assert.equal(packedText.includes(hash), false);
      assert.equal(packedText.includes(user.password), false);
      await assertUpdatedAtStays(ctx.db, fullName, FROZEN, 400);

      const allowed = await ctx.session().postForm('/login', {
        username: user.email,
        password: user.password,
      });
      assert.equal(allowed.status, 302);
      assert.equal(allowed.headers.get('location'), '/');
      const cookies = allowed.headers.getSetCookie();
      assert.ok(cookies.some((cookie) => cookie.startsWith('connect.sid=') && cookie.includes('HttpOnly')));
      assert.equal(cookies.join('\n').includes(user.password), false);
      assert.equal(cookies.join('\n').includes(hash), false);
      await allowed.text();
      assert.equal(passwordHash(ctx.db, user.username), hash);
      assert.equal(repoRow(ctx.db, fullName).updated_at, FROZEN);
    });
  });

  test('renaming a file leaves the body only on the new path', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const user = await registerUser(ctx, session);
      await createRepo(session, { name: 'notes', description: 'rename notes' });
      const bare = barePath(user.username, 'notes');
      const hashes = commitToBare(bare, {
        revisions: [
          {
            files: { 'old-name.txt': 'RENAME_BODY_z8\n', 'stay.txt': 'STAY_BODY_z8\n' },
            message: 'add-old-z8',
          },
          {
            files: { 'new-name.txt': 'RENAME_BODY_z8\n' },
            remove: ['old-name.txt'],
            message: 'rename-ship-z8',
          },
        ],
      });
      assert.equal(hashes.length, 2);

      const repoPage = await (await session.fetch(`/${user.username}/notes`)).text();
      assert.match(repoPage, /new-name\.txt/);
      assert.match(repoPage, /stay\.txt/);
      assert.match(repoPage, /2 commits/);
      assert.match(repoPage, /rename-ship-z8/);
      assert.match(repoPage, /add-old-z8/);
      assert.equal(repoPage.includes('old-name.txt'), false);
      assert.equal(repoPage.includes('RENAME_BODY_z8'), false);
      assert.equal(repoPage.includes('STAY_BODY_z8'), false);

      const renamed = await (await session.fetch(`/${user.username}/notes/blob/main/new-name.txt`)).text();
      assert.match(renamed, /RENAME_BODY_z8/);
      assert.equal(renamed.includes('STAY_BODY_z8'), false);
      const stayed = await (await session.fetch(`/${user.username}/notes/blob/main/stay.txt`)).text();
      assert.match(stayed, /STAY_BODY_z8/);
      assert.equal(stayed.includes('RENAME_BODY_z8'), false);

      const removed = await session.fetch(`/${user.username}/notes/blob/main/old-name.txt`);
      assert.equal(removed.status, 404);
      assert.equal((await removed.text()).includes('RENAME_BODY_z8'), false);

      const previous = await (await session.fetch(`/${user.username}/notes/blob/${hashes[0]}/old-name.txt`)).text();
      assert.match(previous, /RENAME_BODY_z8/);
      assert.equal(previous.includes('STAY_BODY_z8'), false);
      const previousNew = await session.fetch(`/${user.username}/notes/blob/${hashes[0]}/new-name.txt`);
      assert.equal(previousNew.status, 404);
      assert.equal((await previousNew.text()).includes('RENAME_BODY_z8'), false);

      const history = await (await session.fetch(`/${user.username}/notes/commits`)).text();
      assert.match(history, /rename-ship-z8/);
      assert.match(history, /add-old-z8/);
      assert.match(history, new RegExp(hashes[0].slice(0, 7)));
      assert.match(history, new RegExp(hashes[1].slice(0, 7)));
    });
  });

  test('a merge commit keeps both sides on main and in history', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const user = await registerUser(ctx, session);
      await createRepo(session, { name: 'merged', description: 'merge notes' });
      const bare = barePath(user.username, 'merged');
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-merge-'));
      try {
        gitSync(['init', '-b', 'main'], { cwd: work });
        gitSync(['config', 'commit.gpgsign', 'false'], { cwd: work });
        gitSync(['config', 'core.fsmonitor', 'false'], { cwd: work });
        gitSync(['config', 'user.email', 'ada@example.com'], { cwd: work });
        gitSync(['config', 'user.name', 'Ada'], { cwd: work });
        gitSync(['--git-dir', bare, 'config', 'core.fsmonitor', 'false']);
        fs.writeFileSync(path.join(work, 'keep.txt'), 'MAIN_ONLY_z4\n');
        gitSync(['add', '-A'], { cwd: work });
        gitSync(['commit', '-m', 'base-ship-z4'], { cwd: work });
        gitSync(['checkout', '-b', 'topic'], { cwd: work });
        fs.writeFileSync(path.join(work, 'topic.txt'), 'TOPIC_ONLY_z4\n');
        gitSync(['add', '-A'], { cwd: work });
        gitSync(['commit', '-m', 'topic-ship-z4'], { cwd: work });
        gitSync(['checkout', 'main'], { cwd: work });
        fs.writeFileSync(path.join(work, 'extra.txt'), 'EXTRA_ONLY_z4\n');
        gitSync(['add', '-A'], { cwd: work });
        gitSync(['commit', '-m', 'side-ship-z4'], { cwd: work });
        gitSync(['merge', '--no-ff', 'topic', '-m', 'merge-ship-z4'], { cwd: work });
        gitSync(['remote', 'add', 'origin', bare], { cwd: work });
        gitSync(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work });
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }

      const head = gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim();
      gitSync(['--git-dir', bare, 'rev-parse', `${head}^2`]);
      const repoPage = await (await session.fetch(`/${user.username}/merged`)).text();
      assert.match(repoPage, /4 commits/);
      assert.match(repoPage, /keep\.txt/);
      assert.match(repoPage, /topic\.txt/);
      assert.match(repoPage, /extra\.txt/);
      assert.match(repoPage, /merge-ship-z4/);
      assert.equal(repoPage.includes('MAIN_ONLY_z4'), false);
      assert.equal(repoPage.includes('TOPIC_ONLY_z4'), false);
      assert.equal(repoPage.includes('EXTRA_ONLY_z4'), false);

      const keep = await (await session.fetch(`/${user.username}/merged/blob/main/keep.txt`)).text();
      const topic = await (await session.fetch(`/${user.username}/merged/blob/main/topic.txt`)).text();
      const extra = await (await session.fetch(`/${user.username}/merged/blob/main/extra.txt`)).text();
      assert.match(keep, /MAIN_ONLY_z4/);
      assert.equal(keep.includes('TOPIC_ONLY_z4'), false);
      assert.match(topic, /TOPIC_ONLY_z4/);
      assert.equal(topic.includes('EXTRA_ONLY_z4'), false);
      assert.match(extra, /EXTRA_ONLY_z4/);
      assert.equal(extra.includes('MAIN_ONLY_z4'), false);

      const history = await (await session.fetch(`/${user.username}/merged/commits`)).text();
      for (const subject of ['merge-ship-z4', 'side-ship-z4', 'topic-ship-z4', 'base-ship-z4']) {
        assert.match(history, new RegExp(subject));
      }
      assert.equal(history.includes('MAIN_ONLY_z4'), false);
      assert.equal(history.includes('TOPIC_ONLY_z4'), false);
    });
  });

  test('a directory and a file that share a prefix stay distinct', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const user = await registerUser(ctx, session);
      await createRepo(session, { name: 'tree', description: 'prefix tree' });
      commitToBare(barePath(user.username, 'tree'), {
        files: {
          'docs.txt': 'DOCS_FILE_BODY_z6\n',
          'docs/guide.txt': 'NESTED_GUIDE_z6\n',
        },
        message: 'prefix-ship-z6',
      });

      const repoPage = await (await session.fetch(`/${user.username}/tree`)).text();
      const root = `/${user.username}/tree/blob/main`;
      assert.match(repoPage, new RegExp(`href="${root}/docs\\.txt"`));
      assert.match(repoPage, new RegExp(`href="${root}/docs"`));
      assert.equal(repoPage.includes('DOCS_FILE_BODY_z6'), false);
      assert.equal(repoPage.includes('NESTED_GUIDE_z6'), false);

      const file = await (await session.fetch(`/${user.username}/tree/blob/main/docs.txt`)).text();
      assert.match(file, /DOCS_FILE_BODY_z6/);
      assert.match(file, /2 lines/);
      assert.equal(file.includes('NESTED_GUIDE_z6'), false);
      assert.equal(file.includes('guide.txt'), false);

      const dir = await session.fetch(`/${user.username}/tree/blob/main/docs`);
      assert.equal(dir.status, 200);
      const dirText = await dir.text();
      assert.match(dirText, /guide\.txt/);
      assert.equal(dirText.includes('DOCS_FILE_BODY_z6'), false);
      assert.equal(dirText.includes('NESTED_GUIDE_z6'), false);
    });
  });

  test('advertising refs does not refresh the repository', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const user = await registerUser(ctx, session);
      await createRepo(session, { name: 'notes', description: 'NOTES_STAMP_z2' });
      await createRepo(session, { name: 'control', description: 'CONTROL_STAMP_z2' });
      const bare = barePath(user.username, 'notes');
      commitToBare(bare, { files: { 'keep.txt': 'STAMP_BODY_z2\n' }, message: 'stamp-ship-z2' });
      const head = gitSync(['--git-dir', bare, 'rev-parse', 'HEAD']).trim();
      const target = `${user.username}/notes`;
      const control = `${user.username}/control`;
      setUpdatedAt(ctx.db, target, FROZEN);
      setUpdatedAt(ctx.db, control, '2019-06-01 00:00:00');

      const upload = await session.fetch(`/${user.username}/notes.git/info/refs?service=git-upload-pack`);
      const uploadText = await upload.text();
      assert.equal(upload.status, 200);
      assert.equal(upload.headers.get('cache-control'), 'no-cache');
      assert.match(uploadText, new RegExp(head));

      const receive = await session.fetch(`/${user.username}/notes/info/refs?service=git-receive-pack`);
      const receiveText = await receive.text();
      assert.equal(receive.status, 200);
      assert.equal(receive.headers.get('content-type'), 'application/x-git-receive-pack-advertisement');
      assert.equal(receive.headers.get('cache-control'), 'no-cache');
      assert.match(receiveText, new RegExp(head));

      const invalid = await session.fetch(`/${user.username}/notes/info/refs?service=git-upload-pack%20--evil`);
      assert.equal(invalid.status, 400);
      assert.match(await invalid.text(), /Invalid service/);

      await assertUpdatedAtStays(ctx.db, target, FROZEN, 400);
      assert.equal(repoRow(ctx.db, control).updated_at, '2019-06-01 00:00:00');
      const names = (await (await session.fetch(`/api/users/${encodeURIComponent(user.username)}/repos`)).json())
        .map((repo) => repo.name);
      assert.deepEqual(names, ['control', 'notes']);
      const home = await (await ctx.session().fetch('/')).text();
      assert.ok(home.indexOf('CONTROL_STAMP_z2') < home.indexOf('NOTES_STAMP_z2'));
      const blob = await (await session.fetch(`/${user.username}/notes/blob/main/keep.txt`)).text();
      assert.match(blob, /STAMP_BODY_z2/);
    });
  });
});
