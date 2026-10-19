const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertUpdatedAtStays,
  barePath,
  basicAuth,
  createRepo,
  gitSync,
  pushFiles,
  registerUser,
  remoteUrl,
  repoRow,
  runGit,
  setUpdatedAt,
  start,
  waitForUpdatedAt,
} = require('./helpers');

const FROZEN = '2000-01-01 00:00:00';

describe('smart HTTP', { concurrency: 1 }, () => {
  let ctx;

  before(async () => {
    ctx = await start();
  });

  after(async () => {
    if (ctx) await ctx.close();
  });

  test('new repositories advertise main and reject invalid or missing refs lookups', async () => {
    const session = ctx.session();
    const user = await registerUser(ctx, session);
    await createRepo(session, { name: 'web.app', description: 'dotted' });
    const bare = barePath(user.username, 'web.app');
    assert.equal(gitSync(['--git-dir', bare, 'symbolic-ref', 'HEAD']).trim(), 'refs/heads/main');
    assert.equal(gitSync(['--git-dir', bare, 'config', '--get', 'http.receivepack']).trim(), 'true');
    assert.equal(gitSync(['--git-dir', bare, 'config', '--get', 'http.uploadpack']).trim(), 'true');

    const upload = await session.fetch(`/${user.username}/web.app.git/info/refs?service=git-upload-pack`);
    const uploadText = await upload.text();
    assert.equal(upload.status, 200);
    assert.equal(upload.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
    assert.equal(upload.headers.get('cache-control'), 'no-cache');
    assert.match(uploadText, /^001e# service=git-upload-pack\n0000/);

    const receive = await session.fetch(`/${user.username}/web.app/info/refs?service=git-receive-pack`);
    const receiveText = await receive.text();
    assert.equal(receive.status, 200);
    assert.equal(receive.headers.get('content-type'), 'application/x-git-receive-pack-advertisement');
    assert.match(receiveText, /^001f# service=git-receive-pack\n0000/);

    const stripped = await session.fetch(`/${user.username}/web.git/info/refs?service=git-upload-pack`);
    assert.equal(stripped.status, 404);
    await stripped.text();
    const asWeb = await session.fetch(`/${user.username}/web`);
    assert.equal(asWeb.status, 404);
    await asWeb.text();

    for (const service of ['', 'evil', 'git-Upload-pack']) {
      const query = service ? `?service=${encodeURIComponent(service)}` : '';
      const res = await session.fetch(`/${user.username}/web.app/info/refs${query}`);
      assert.equal(res.status, 400, service || '(missing)');
      assert.match(await res.text(), /Invalid service/);
    }

    const missing = await session.fetch(`/${user.username}/missing.git/info/refs?service=git-upload-pack`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Not found/);

    ctx.db.prepare('INSERT INTO repositories (name, full_name, description, owner_id, private) VALUES (?, ?, ?, ?, 0)').run(
      'ghost',
      `${user.username}/ghost`,
      '',
      user.id
    );
    const ghost = await session.fetch(`/${user.username}/ghost/info/refs?service=git-upload-pack`);
    assert.equal(ghost.status, 404);
    assert.match(await ghost.text(), /Not found/);
  });

  test('receive-pack requires the owner and updates only that repository', async () => {
    const ownerSession = ctx.session();
    const owner = await registerUser(ctx, ownerSession);
    const strangerSession = ctx.session();
    const stranger = await registerUser(ctx, strangerSession, { username: `Ada${ctx.nextId('G')}` });
    await createRepo(ownerSession, { name: 'writes', description: '', isPrivate: true });
    await createRepo(ownerSession, { name: 'sibling', description: 'sibling' });
    const target = `${owner.username}/writes`;
    const sibling = `${owner.username}/sibling`;
    setUpdatedAt(ctx.db, target, FROZEN);
    setUpdatedAt(ctx.db, sibling, FROZEN);

    async function postPack(session, pathname, authorization) {
      const headers = {};
      if (authorization) headers.authorization = authorization;
      const res = await session.fetch(pathname, { method: 'POST', headers, body: '' });
      const text = await res.text();
      return { status: res.status, text, type: res.headers.get('content-type') };
    }

    const pack = `/${owner.username}/writes/git-receive-pack`;
    const noAuth = await postPack(ctx.session(), pack);
    assert.equal(noAuth.status, 401);
    assert.match(noAuth.text, /Authentication required/);

    const cookieOnly = await postPack(ownerSession, pack);
    assert.equal(cookieOnly.status, 401);
    assert.match(cookieOnly.text, /Authentication required/);

    const bearer = await postPack(ctx.session(), pack, 'Bearer abc');
    assert.equal(bearer.status, 401);

    const badPassword = await postPack(ctx.session(), pack, basicAuth(owner.username, 'wrong-password'));
    assert.equal(badPassword.status, 401);
    assert.match(badPassword.text, /Invalid credentials/);

    const emptyPassword = await postPack(ctx.session(), pack, basicAuth(owner.username, ''));
    assert.equal(emptyPassword.status, 401);

    const unknown = await postPack(ctx.session(), pack, basicAuth('no-such-user', 'correct-horse'));
    assert.equal(unknown.status, 401);

    const wrongCase = await postPack(ctx.session(), pack, basicAuth(stranger.username.toLowerCase(), stranger.password));
    assert.equal(wrongCase.status, 401);
    assert.notEqual(stranger.username, stranger.username.toLowerCase());

    const notOwner = await postPack(strangerSession, pack, basicAuth(stranger.username, stranger.password));
    assert.equal(notOwner.status, 403);
    assert.match(notOwner.text, /Permission denied/);

    const missing = await postPack(ownerSession, `/${owner.username}/missing/git-receive-pack`, basicAuth(owner.username, owner.password));
    assert.equal(missing.status, 404);

    await assertUpdatedAtStays(ctx.db, target, FROZEN, 400);
    assert.equal(repoRow(ctx.db, sibling).updated_at, FROZEN);

    const allowed = await postPack(ownerSession, pack, basicAuth(owner.username, owner.password));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.type, 'application/x-git-receive-pack-result');
    const refreshed = await waitForUpdatedAt(ctx.db, target, FROZEN);
    assert.notEqual(refreshed, FROZEN);
    assert.equal(repoRow(ctx.db, sibling).updated_at, FROZEN);
  });

  test('an owner push is visible and a stranger force-push changes nothing', async () => {
    const ownerSession = ctx.session();
    const owner = await registerUser(ctx, ownerSession);
    const strangerSession = ctx.session();
    const stranger = await registerUser(ctx, strangerSession);
    await createRepo(ownerSession, { name: 'shipped', description: 'shipped' });
    const fullName = `${owner.username}/shipped`;
    setUpdatedAt(ctx.db, fullName, FROZEN);

    const pushed = await pushFiles({
      url: remoteUrl(ctx, owner.username, 'shipped', owner.password),
      files: { 'pushed.txt': 'owner-bytes\n' },
      message: 'owner push',
    });
    assert.equal(pushed.code, 0, pushed.stderr);
    const refreshed = await waitForUpdatedAt(ctx.db, fullName, FROZEN);
    assert.notEqual(refreshed, FROZEN);

    const head = gitSync(['--git-dir', barePath(owner.username, 'shipped'), 'rev-parse', 'HEAD']).trim();
    const listed = await runGit(['ls-remote', remoteUrl(ctx, owner.username, 'shipped')], { timeout: 20000 });
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`${head}\\s+refs/heads/main`));

    const blob = await (await ctx.session().fetch(`/${owner.username}/shipped/blob/main/pushed.txt`)).text();
    assert.match(blob, /owner-bytes/);

    setUpdatedAt(ctx.db, fullName, FROZEN);
    const upload = await ctx.session().fetch(`/${owner.username}/shipped/git-upload-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-upload-pack-request' },
      body: '0000',
    });
    assert.equal(upload.status, 200);
    assert.equal(upload.headers.get('content-type'), 'application/x-git-upload-pack-result');
    await upload.text();
    const afterList = await runGit(['ls-remote', remoteUrl(ctx, owner.username, 'shipped')], { timeout: 20000 });
    assert.equal(afterList.code, 0, afterList.stderr);

    const attack = await pushFiles({
      url: `http://${encodeURIComponent(stranger.username)}:${encodeURIComponent(stranger.password)}@127.0.0.1:${ctx.port}/${encodeURIComponent(owner.username)}/shipped.git`,
      files: { 'pushed.txt': 'pwned-bytes\n' },
      message: 'force in',
      force: true,
    });
    assert.notEqual(attack.code, 0);

    await assertUpdatedAtStays(ctx.db, fullName, FROZEN, 400);
    assert.equal(gitSync(['--git-dir', barePath(owner.username, 'shipped'), 'rev-parse', 'HEAD']).trim(), head);
    const still = await (await ownerSession.fetch(`/${owner.username}/shipped/blob/main/pushed.txt`)).text();
    assert.match(still, /owner-bytes/);
    assert.equal(still.includes('pwned-bytes'), false);
    assert.equal(strangerSession.cookies.size > 0, true);
  });
});
