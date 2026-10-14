const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  basicAuth,
  createRepo,
  getText,
  getUpdatedAt,
  gitAsync,
  gitEnv,
  insertRepo,
  readBody,
  register,
  repoDisk,
  runGit,
  Session,
  setUpdatedAt,
  waitForUpdatedAt,
  withApp,
} = require('./helpers');

async function receive(session, owner, repo, authorization) {
  const headers = { 'content-type': 'application/x-git-receive-pack-request' };
  if (authorization) headers.authorization = authorization;
  return readBody(await session.fetch(`/${owner}/${repo}/git-receive-pack`, {
    method: 'POST',
    headers,
    body: '0000',
    signal: AbortSignal.timeout(15000),
  }));
}

describe('git http', { concurrency: false }, () => {
  test('smart HTTP advertises refs, rejects bad auth, and a bare repo starts on main', { timeout: 30000 }, async () => {
    await withApp(async (ctx) => {
      const owner = new Session(ctx);
      const other = new Session(ctx);
      const anon = new Session(ctx);
      await register(owner, { username: 'Gus', email: 'gus@example.com', password: 'pw-gus-git' });
      await register(other, { username: 'Eve', email: 'eve-git@example.com', password: 'pw-eve-git' });
      await createRepo(owner, { name: 'box', description: 'box-desc' });
      await createRepo(owner, { name: 'web.app', description: 'dotted' });
      const frozen = '1999-05-05 00:00:00';
      setUpdatedAt(ctx, 'Gus/box', frozen);
      const dottedStamp = getUpdatedAt(ctx, 'Gus/web.app');

      assert.equal(runGit(['--git-dir', repoDisk('Gus', 'web.app'), 'symbolic-ref', 'HEAD']), 'refs/heads/main');
      assert.equal(runGit(['--git-dir', repoDisk('Gus', 'web.app'), 'config', '--get', 'http.receivepack']), 'true');
      assert.equal(runGit(['--git-dir', repoDisk('Gus', 'web.app'), 'config', '--get', 'http.uploadpack']), 'true');
      const dotted = await getText(anon, '/Gus/web.app');
      assert.equal(dotted.status, 200);
      assert.match(dotted.text, /web\.app/);
      const notStripped = await getText(anon, '/Gus/web');
      assert.equal(notStripped.status, 404);
      const dottedRefs = await getText(anon, '/Gus/web.app.git/info/refs?service=git-upload-pack');
      assert.equal(dottedRefs.status, 200);
      assert.match(dottedRefs.text, /001e# service=git-upload-pack\n0000/);
      const wrongDot = await getText(anon, '/Gus/web.git/info/refs?service=git-upload-pack');
      assert.equal(wrongDot.status, 404);

      const missingService = await getText(anon, '/Gus/box/info/refs');
      assert.equal(missingService.status, 400);
      assert.match(missingService.text, /Invalid service/);
      const emptyService = await getText(anon, '/Gus/box/info/refs?service=');
      assert.equal(emptyService.status, 400);
      const wrongCase = await getText(anon, '/Gus/box/info/refs?service=git-Upload-Pack');
      assert.equal(wrongCase.status, 400);
      const missingRepo = await getText(anon, '/Gus/missing/info/refs?service=git-upload-pack');
      assert.equal(missingRepo.status, 404);
      assert.match(missingRepo.text, /Not found/);

      insertRepo(ctx, { username: 'Gus', name: 'ghost', description: 'no-disk', updatedAt: frozen });
      const ghost = await getText(anon, '/Gus/ghost/info/refs?service=git-upload-pack');
      assert.equal(ghost.status, 404);
      assert.equal(fs.existsSync(repoDisk('Gus', 'ghost')), false);

      const uploadRefs = await getText(anon, '/Gus/box/info/refs?service=git-upload-pack');
      assert.equal(uploadRefs.status, 200);
      assert.equal(uploadRefs.type, 'application/x-git-upload-pack-advertisement');
      assert.match(uploadRefs.res.headers.get('cache-control'), /no-cache/);
      assert.match(uploadRefs.text, /^001e# service=git-upload-pack\n0000/);
      const receiveRefs = await getText(anon, '/Gus/box/info/refs?service=git-receive-pack');
      assert.equal(receiveRefs.status, 200);
      assert.equal(receiveRefs.type, 'application/x-git-receive-pack-advertisement');
      assert.match(receiveRefs.text, /^001f# service=git-receive-pack\n0000/);

      const upload = await readBody(await anon.fetch('/Gus/box/git-upload-pack', {
        method: 'POST',
        headers: { 'content-type': 'application/x-git-upload-pack-request' },
        body: '0000',
        signal: AbortSignal.timeout(15000),
      }));
      assert.equal(upload.status, 200);
      assert.equal(upload.type, 'application/x-git-upload-pack-result');
      assert.equal(getUpdatedAt(ctx, 'Gus/box'), frozen);

      const noAuth = await receive(anon, 'Gus', 'box');
      assert.equal(noAuth.status, 401);
      assert.match(noAuth.text, /Authentication required/);
      assert.match(noAuth.res.headers.get('www-authenticate'), /Basic/);
      const bearer = await receive(anon, 'Gus', 'box', 'Bearer token');
      assert.equal(bearer.status, 401);
      const malformed = await receive(anon, 'Gus', 'box', 'Basic @@@');
      assert.equal(malformed.status, 401);
      const bareWord = await receive(anon, 'Gus', 'box', 'Basic');
      assert.equal(bareWord.status, 401);
      const emptyPassword = await receive(owner, 'Gus', 'box', basicAuth('Gus', ''));
      assert.equal(emptyPassword.status, 401);
      assert.match(emptyPassword.text, /Invalid credentials/);
      const badPassword = await receive(anon, 'Gus', 'box', basicAuth('Gus', 'wrong-password'));
      assert.equal(badPassword.status, 401);
      const unknown = await receive(anon, 'Gus', 'box', basicAuth('nobody', 'pw-gus-git'));
      assert.equal(unknown.status, 401);
      const wrongUserCase = await receive(anon, 'Gus', 'box', basicAuth('gus', 'pw-gus-git'));
      assert.equal(wrongUserCase.status, 401);
      const cookieOnly = await receive(owner, 'Gus', 'box');
      assert.equal(cookieOnly.status, 401);
      const stranger = await receive(other, 'Gus', 'box', basicAuth('Eve', 'pw-eve-git'));
      assert.equal(stranger.status, 403);
      assert.match(stranger.text, /Permission denied/);
      const missingReceive = await receive(owner, 'Gus', 'missing', basicAuth('Gus', 'pw-gus-git'));
      assert.equal(missingReceive.status, 404);
      assert.equal(getUpdatedAt(ctx, 'Gus/box'), frozen);

      const ownerPush = await receive(owner, 'Gus', 'box', basicAuth('Gus', 'pw-gus-git'));
      assert.equal(ownerPush.status, 200);
      assert.equal(ownerPush.type, 'application/x-git-receive-pack-result');
      assert.notEqual(await waitForUpdatedAt(ctx, 'Gus/box', frozen), frozen);
      assert.equal(getUpdatedAt(ctx, 'Gus/web.app'), dottedStamp);
    });
  });

  test('the owner can push and a stranger force-push is rejected', { timeout: 60000 }, async () => {
    await withApp(async (ctx) => {
      const owner = new Session(ctx);
      const stranger = new Session(ctx);
      await register(owner, { username: 'Pat', email: 'pat@example.com', password: 'pw-pat-push1' });
      await register(stranger, { username: 'Eve', email: 'eve-push@example.com', password: 'pw-eve-push1' });
      assert.equal((await createRepo(owner, { name: 'proj', description: 'push-proj' })).status, 302);

      const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgram-push-'));
      try {
        const remote = `${ctx.base}/Pat/proj.git`;
        await gitAsync(['init', '-b', 'main'], { cwd: wt, env: gitEnv() });
        await gitAsync(['config', 'commit.gpgsign', 'false'], { cwd: wt, env: gitEnv() });
        await gitAsync(['config', 'core.fsmonitor', 'false'], { cwd: wt, env: gitEnv() });
        await gitAsync(['config', 'user.email', 'pat@example.com'], { cwd: wt, env: gitEnv() });
        await gitAsync(['config', 'user.name', 'Pat'], { cwd: wt, env: gitEnv() });
        fs.writeFileSync(path.join(wt, 'hello.txt'), 'hello-from-push\n');
        await gitAsync(['add', 'hello.txt'], { cwd: wt, env: gitEnv() });
        await gitAsync(['commit', '-m', 'push me'], { cwd: wt, env: gitEnv() });

        const ownerHeader = `http.extraHeader=Authorization: Basic ${Buffer.from('Pat:pw-pat-push1').toString('base64')}`;
        const beforePush = '1999-01-01 00:00:00';
        setUpdatedAt(ctx, 'Pat/proj', beforePush);
        await gitAsync(['-c', 'credential.helper=', '-c', ownerHeader, 'push', remote, 'HEAD:refs/heads/main'], {
          cwd: wt,
          timeout: 20000,
          env: gitEnv(),
        });
        assert.notEqual(await waitForUpdatedAt(ctx, 'Pat/proj', beforePush), beforePush);
        const listed = await gitAsync(['ls-remote', remote, 'refs/heads/main'], {
          timeout: 20000,
          env: gitEnv(),
        });
        assert.match(listed.stdout, /refs\/heads\/main/);
        const blob = await getText(owner, '/Pat/proj/blob/main/hello.txt');
        assert.equal(blob.status, 200);
        assert.match(blob.text, /hello-from-push/);

        const head = runGit(['--git-dir', repoDisk('Pat', 'proj'), 'rev-parse', 'HEAD']);
        const stamp = getUpdatedAt(ctx, 'Pat/proj');
        fs.writeFileSync(path.join(wt, 'hello.txt'), 'pwned-content\n');
        await gitAsync(['commit', '-am', 'evil'], { cwd: wt, env: gitEnv() });

        const wrongHeader = `http.extraHeader=Authorization: Basic ${Buffer.from('Pat:wrong-password').toString('base64')}`;
        await assert.rejects(() => gitAsync(
          ['-c', 'credential.helper=', '-c', wrongHeader, 'push', remote, 'HEAD:refs/heads/main'],
          { cwd: wt, timeout: 20000, env: gitEnv() }
        ));
        assert.equal(runGit(['--git-dir', repoDisk('Pat', 'proj'), 'rev-parse', 'HEAD']), head);
        assert.equal(getUpdatedAt(ctx, 'Pat/proj'), stamp);

        const strangerHeader = `http.extraHeader=Authorization: Basic ${Buffer.from('Eve:pw-eve-push1').toString('base64')}`;
        await assert.rejects(() => gitAsync(
          ['-c', 'credential.helper=', '-c', strangerHeader, 'push', '--force', remote, 'HEAD:refs/heads/main'],
          { cwd: wt, timeout: 20000, env: gitEnv() }
        ));
        assert.equal(runGit(['--git-dir', repoDisk('Pat', 'proj'), 'rev-parse', 'HEAD']), head);
        assert.equal(getUpdatedAt(ctx, 'Pat/proj'), stamp);
        const after = await getText(stranger, '/Pat/proj/blob/main/hello.txt');
        assert.match(after.text, /hello-from-push/);
        assert.equal(after.text.includes('pwned-content'), false);
      } finally {
        fs.rmSync(wt, { recursive: true, force: true });
      }
    });
  });
});
