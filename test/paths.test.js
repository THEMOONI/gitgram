const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertUpdatedAtStays,
  barePath,
  basicAuth,
  commitToBare,
  createRepo,
  passwordHash,
  registerUser,
  setUpdatedAt,
  start,
} = require('./helpers');

const FROZEN = '2017-06-01 00:00:00';
const MARKUP = 'MARKUP_z7<img>';

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

describe('reserved paths, blob revisions, and login fields', { concurrency: 1 }, () => {
  test('reserved repository names and filenames do not steal another repository', async () => {
    await withApp(async (ctx) => {
      const ownerSession = ctx.session();
      const owner = await registerUser(ctx, ownerSession);
      const strangerSession = ctx.session();
      const stranger = await registerUser(ctx, strangerSession);
      const root = `/${owner.username}`;

      await createRepo(ownerSession, { name: 'notes', description: 'NOTES_DESC_z7' });
      await createRepo(ownerSession, { name: 'commits', description: 'COMMITS_DESC_z7' });
      await createRepo(ownerSession, { name: 'settings', description: 'SETTINGS_DESC_z7' });
      await createRepo(ownerSession, { name: 'blob', description: 'BLOB_DESC_z7' });
      await createRepo(ownerSession, { name: 'info', description: 'INFO_DESC_z7' });

      const noteHashes = commitToBare(barePath(owner.username, 'notes'), {
        files: {
          'keep.txt': 'NOTES_BODY_z7',
          commits: 'FILE_NAMED_COMMITS_z7',
          settings: 'FILE_NAMED_SETTINGS_z7',
        },
        message: 'notes-ship-z7',
      });
      const commitHashes = commitToBare(barePath(owner.username, 'commits'), {
        files: { 'side.txt': 'COMMITS_BODY_z7' },
        message: 'commits-ship-z7',
      });
      commitToBare(barePath(owner.username, 'settings'), {
        files: { 'gear.txt': 'SETTINGS_BODY_z7' },
        message: 'settings-ship-z7',
      });
      commitToBare(barePath(owner.username, 'blob'), {
        files: { 'payload.txt': 'BLOB_BODY_z7' },
        message: 'blob-ship-z7',
      });
      const infoHashes = commitToBare(barePath(owner.username, 'info'), {
        files: { 'marker.txt': 'INFO_BODY_z7' },
        message: 'info-ship-z7',
      });

      for (const name of ['notes', 'commits', 'settings', 'blob', 'info']) {
        setUpdatedAt(ctx.db, `${owner.username}/${name}`, FROZEN);
      }

      const commitsRepo = await (await strangerSession.fetch(`${root}/commits`)).text();
      assert.match(commitsRepo, /COMMITS_DESC_z7/);
      assert.match(commitsRepo, /side\.txt/);
      assert.equal(commitsRepo.includes('NOTES_DESC_z7'), false);
      assert.equal(commitsRepo.includes('notes-ship-z7'), false);
      assert.equal(commitsRepo.includes('NOTES_BODY_z7'), false);
      assert.equal(commitsRepo.includes('Commit History'), false);

      const notesHistory = await (await strangerSession.fetch(`${root}/notes/commits`)).text();
      assert.match(notesHistory, /Commit History/);
      assert.match(notesHistory, /notes-ship-z7/);
      assert.equal(notesHistory.includes('commits-ship-z7'), false);
      assert.equal(notesHistory.includes('FILE_NAMED_COMMITS_z7'), false);
      assert.equal(notesHistory.includes('COMMITS_BODY_z7'), false);

      const namedCommits = await (await strangerSession.fetch(`${root}/notes/blob/main/commits`)).text();
      assert.match(namedCommits, /FILE_NAMED_COMMITS_z7/);
      assert.equal(namedCommits.includes('NOTES_BODY_z7'), false);
      assert.equal(namedCommits.includes('notes-ship-z7'), false);

      const notesBlob = await (await strangerSession.fetch(`${root}/notes/blob/main/keep.txt`)).text();
      assert.match(notesBlob, /NOTES_BODY_z7/);
      assert.equal(notesBlob.includes('COMMITS_BODY_z7'), false);
      assert.equal(notesBlob.includes('BLOB_BODY_z7'), false);

      const blobRepo = await (await strangerSession.fetch(`${root}/blob`)).text();
      assert.match(blobRepo, /BLOB_DESC_z7/);
      assert.match(blobRepo, /payload\.txt/);
      assert.equal(blobRepo.includes('NOTES_BODY_z7'), false);

      const blobFile = await (await strangerSession.fetch(`${root}/blob/blob/main/payload.txt`)).text();
      assert.match(blobFile, /BLOB_BODY_z7/);
      assert.equal(blobFile.includes('NOTES_BODY_z7'), false);
      assert.equal(blobFile.includes('FILE_NAMED_COMMITS_z7'), false);

      const settingsRepo = await (await strangerSession.fetch(`${root}/settings`)).text();
      assert.match(settingsRepo, /SETTINGS_DESC_z7/);
      assert.match(settingsRepo, /gear\.txt/);
      assert.equal(settingsRepo.includes('NOTES_DESC_z7'), false);

      const strangerSettings = await strangerSession.fetch(`${root}/settings/settings`);
      assert.equal(strangerSettings.status, 403);
      const strangerSettingsHtml = await strangerSettings.text();
      assert.match(strangerSettingsHtml, /Access Denied/);
      assert.equal(strangerSettingsHtml.includes('SETTINGS_BODY_z7'), false);
      assert.equal(strangerSettingsHtml.includes('settings/delete'), false);

      const strangerNotesSettings = await strangerSession.fetch(`${root}/notes/settings`);
      assert.equal(strangerNotesSettings.status, 403);
      assert.equal((await strangerNotesSettings.text()).includes('FILE_NAMED_SETTINGS_z7'), false);

      const ownerSettings = await (await ownerSession.fetch(`${root}/settings/settings`)).text();
      assert.match(ownerSettings, new RegExp(`action="${root}/settings/settings/delete"`));
      assert.equal(ownerSettings.includes('NOTES_BODY_z7'), false);
      assert.equal(ownerSettings.includes('FILE_NAMED_SETTINGS_z7'), false);

      const ownerNotesSettings = await (await ownerSession.fetch(`${root}/notes/settings`)).text();
      assert.match(ownerNotesSettings, new RegExp(`action="${root}/notes/settings/delete"`));
      assert.equal(ownerNotesSettings.includes('FILE_NAMED_SETTINGS_z7'), false);

      const settingsFile = await (await ownerSession.fetch(`${root}/notes/blob/main/settings`)).text();
      assert.match(settingsFile, /FILE_NAMED_SETTINGS_z7/);
      assert.equal(settingsFile.includes('settings/delete'), false);
      assert.equal(settingsFile.includes('SETTINGS_BODY_z7'), false);

      const notesRefsRes = await strangerSession.fetch(`${root}/notes/info/refs?service=git-upload-pack`);
      const infoRefsRes = await strangerSession.fetch(`${root}/info/info/refs?service=git-upload-pack`);
      const commitsRefsRes = await strangerSession.fetch(`${root}/commits/info/refs?service=git-upload-pack`);
      assert.equal(notesRefsRes.status, 200);
      assert.equal(infoRefsRes.status, 200);
      assert.equal(commitsRefsRes.status, 200);
      const notesRefs = await notesRefsRes.text();
      const infoRefs = await infoRefsRes.text();
      const commitsRefs = await commitsRefsRes.text();
      assert.match(notesRefs, new RegExp(noteHashes[0]));
      assert.match(infoRefs, new RegExp(infoHashes[0]));
      assert.match(commitsRefs, new RegExp(commitHashes[0]));
      assert.equal(notesRefs.includes(infoHashes[0]), false);
      assert.equal(infoRefs.includes(noteHashes[0]), false);
      assert.equal(commitsRefs.includes(noteHashes[0]), false);
      assert.match(infoRefs, /^001e# service=git-upload-pack\n0000/);
      assert.equal(infoRefs.includes('INFO_BODY_z7'), false);
      assert.equal(notesRefs.includes('NOTES_BODY_z7'), false);

      const denied = await strangerSession.fetch(`${root}/commits/git-receive-pack`, {
        method: 'POST',
        headers: { authorization: basicAuth(stranger.username, stranger.password) },
        body: '',
      });
      assert.equal(denied.status, 403);
      assert.match(await denied.text(), /Permission denied/);
      const missingPack = await strangerSession.fetch(`${root}/no-such-pack/git-receive-pack`, {
        method: 'POST',
        headers: { authorization: basicAuth(stranger.username, stranger.password) },
        body: '',
      });
      assert.equal(missingPack.status, 404);
      assert.match(await missingPack.text(), /Not found/);
      assert.equal(
        ctx.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(`${owner.username}/no-such-pack`),
        undefined
      );
      assert.equal(
        ctx.db.prepare('SELECT id FROM repositories WHERE name = ?').get('no-such-pack'),
        undefined
      );
      await assertUpdatedAtStays(ctx.db, `${owner.username}/commits`, FROZEN);
      await assertUpdatedAtStays(ctx.db, `${owner.username}/notes`, FROZEN);

      const removed = await ownerSession.fetch(`${root}/settings/settings/delete`, { method: 'POST' });
      assert.equal(removed.status, 302);
      assert.equal(removed.headers.get('location'), `/@${owner.username}`);
      await removed.text();
      const gone = await strangerSession.fetch(`${root}/settings`);
      assert.equal(gone.status, 404);
      assert.equal((await gone.text()).includes('SETTINGS_BODY_z7'), false);
      assert.equal(ctx.db.prepare('SELECT id FROM repositories WHERE full_name = ?').get(`${owner.username}/settings`), undefined);
      const keptFile = await (await strangerSession.fetch(`${root}/notes/blob/main/settings`)).text();
      assert.match(keptFile, /FILE_NAMED_SETTINGS_z7/);
      const keptNotes = await (await strangerSession.fetch(`${root}/notes/blob/main/keep.txt`)).text();
      assert.match(keptNotes, /NOTES_BODY_z7/);
      const keptInfo = await (await strangerSession.fetch(`${root}/info/info/refs?service=git-upload-pack`)).text();
      assert.match(keptInfo, new RegExp(infoHashes[0]));
      assert.equal(keptInfo.includes(noteHashes[0]), false);
    });
  });

  test('HEAD and main~1 serve that revision of a private file only to the owner', async () => {
    await withApp(async (ctx) => {
      const ownerSession = ctx.session();
      const owner = await registerUser(ctx, ownerSession);
      const strangerSession = ctx.session();
      await registerUser(ctx, strangerSession);
      await createRepo(ownerSession, { name: 'vault', description: 'REV_PRIVATE_z7', isPrivate: true });
      const hashes = commitToBare(barePath(owner.username, 'vault'), {
        revisions: [
          { files: { 'keep.txt': 'PARENT_BODY_z7' }, message: 'parent-ship-z7' },
          { files: { 'keep.txt': 'TIP_BODY_z7' }, message: 'tip-ship-z7' },
        ],
      });
      const root = `/${owner.username}/vault/blob`;
      const paths = [
        `${root}/HEAD/keep.txt`,
        `${root}/main/keep.txt`,
        `${root}/main~1/keep.txt`,
      ];

      const head = await (await ownerSession.fetch(paths[0])).text();
      const tip = await (await ownerSession.fetch(paths[1])).text();
      const parent = await (await ownerSession.fetch(paths[2])).text();
      assert.match(head, /TIP_BODY_z7/);
      assert.match(tip, /TIP_BODY_z7/);
      assert.match(parent, /PARENT_BODY_z7/);
      assert.equal(head.includes('PARENT_BODY_z7'), false);
      assert.equal(tip.includes('PARENT_BODY_z7'), false);
      assert.equal(parent.includes('TIP_BODY_z7'), false);

      const byParent = await (await ownerSession.fetch(`${root}/${hashes[0]}/keep.txt`)).text();
      const byTip = await (await ownerSession.fetch(`${root}/${hashes[1]}/keep.txt`)).text();
      assert.match(byParent, /PARENT_BODY_z7/);
      assert.equal(byParent.includes('TIP_BODY_z7'), false);
      assert.match(byTip, /TIP_BODY_z7/);
      assert.equal(byTip.includes('PARENT_BODY_z7'), false);

      for (const session of [strangerSession, ctx.session()]) {
        for (const pathname of paths) {
          const res = await session.fetch(pathname);
          assert.equal(res.status, 404, pathname);
          const html = await res.text();
          assert.equal(html.includes('TIP_BODY_z7'), false, pathname);
          assert.equal(html.includes('PARENT_BODY_z7'), false, pathname);
        }
        const history = await session.fetch(`/${owner.username}/vault/commits`);
        assert.equal(history.status, 404);
        const historyHtml = await history.text();
        assert.equal(historyHtml.includes('tip-ship-z7'), false);
        assert.equal(historyHtml.includes('parent-ship-z7'), false);
      }

      const ownerHistory = await (await ownerSession.fetch(`/${owner.username}/vault/commits`)).text();
      assert.match(ownerHistory, /tip-ship-z7/);
      assert.match(ownerHistory, /parent-ship-z7/);
      assert.equal(ownerHistory.includes('TIP_BODY_z7'), false);
      assert.equal(ownerHistory.includes('PARENT_BODY_z7'), false);
    });
  });

  test('failed login and unknown pages do not reflect markup or accept a renamed field', async () => {
    await withApp(async (ctx) => {
      const ownerSession = ctx.session();
      const owner = await registerUser(ctx, ownerSession);
      const before = passwordHash(ctx.db, owner.username);
      const userCount = ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

      const attempts = [
        {
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ password: owner.password }).toString(),
        },
        {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: owner.password }),
        },
        {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: owner.email, password: owner.password }),
        },
        {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user: owner.username, password: owner.password }),
        },
        {
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ username: MARKUP, password: 'markup-horse-z7' }).toString(),
        },
      ];

      for (const attempt of attempts) {
        const session = ctx.session();
        const res = await session.fetch('/login', {
          method: 'POST',
          headers: attempt.headers,
          body: attempt.body,
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('location'), null);
        const html = await res.text();
        assert.match(html, /Invalid credentials/);
        assert.equal(html.includes(owner.password), false);
        assert.equal(html.includes(before), false);
        assert.equal(html.includes(MARKUP), false);
        assert.equal(html.includes('markup-horse-z7'), false);
        assert.match(html, /<script src="\/js\/app\.js">/);
        const home = await (await session.fetch('/')).text();
        assert.equal(home.includes('Log out'), false);
      }

      assert.equal(passwordHash(ctx.db, owner.username), before);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, userCount);
      assert.equal(ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(MARKUP), undefined);

      const anonymous = ctx.session();
      const profile = await anonymous.fetch(`/@${encodeURIComponent(MARKUP)}`);
      assert.equal(profile.status, 404);
      const profileHtml = await profile.text();
      assert.match(profileHtml, /Not Found/);
      assert.equal(profileHtml.includes(MARKUP), false);

      const missing = await anonymous.fetch(`/${owner.username}/${encodeURIComponent(MARKUP)}`);
      assert.equal(missing.status, 404);
      const missingHtml = await missing.text();
      assert.match(missingHtml, /Not Found/);
      assert.equal(missingHtml.includes(MARKUP), false);
      assert.equal(missingHtml.includes(owner.password), false);

      const signedIn = ctx.session();
      const ok = await signedIn.postForm('/login', { username: owner.username, password: owner.password });
      assert.equal(ok.status, 302);
      assert.equal(ok.headers.get('location'), '/');
      await ok.text();
      assert.match(await (await signedIn.fetch('/')).text(), /Log out/);
      assert.equal(passwordHash(ctx.db, owner.username), before);
    });
  });
});
