const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
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

const FROZEN = '2000-01-01 00:00:00';

async function withApp(fn) {
  const ctx = await start();
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function headOf(username, repo) {
  return gitSync(['--git-dir', barePath(username, repo), 'rev-parse', 'HEAD']).trim();
}

describe('credential matching and object identity', { concurrency: 1 }, () => {
  test('emails that differ by surrounding space are separate accounts', async () => {
    await withApp(async (ctx) => {
      const stamp = ctx.nextId('m');
      const plainName = `Mail${stamp}`;
      const paddedName = `Padded${stamp}`;
      const plainEmail = `ada.${stamp}@example.test`;
      const paddedEmail = `${plainEmail} `;
      assert.notEqual(plainEmail, paddedEmail);

      const plainSession = ctx.session();
      const plain = await registerUser(ctx, plainSession, {
        username: plainName,
        email: plainEmail,
        password: 'plain-mail-pass',
      });
      const plainHash = passwordHash(ctx.db, plainName);
      const paddedSession = ctx.session();
      const padded = await registerUser(ctx, paddedSession, {
        username: paddedName,
        email: paddedEmail,
        password: 'padded-mail-pass',
      });
      assert.notEqual(plain.id, padded.id);
      assert.equal(passwordHash(ctx.db, plainName), plainHash);
      assert.notEqual(passwordHash(ctx.db, paddedName), plainHash);
      assert.equal(ctx.db.prepare('SELECT email FROM users WHERE id = ?').get(plain.id).email, plainEmail);
      assert.equal(ctx.db.prepare('SELECT email FROM users WHERE id = ?').get(padded.id).email, paddedEmail);

      await createRepo(plainSession, { name: 'vault', description: 'PLAIN_EMAIL_SECRET', isPrivate: true });
      await createRepo(paddedSession, { name: 'vault', description: 'PADDED_EMAIL_SECRET', isPrivate: true });

      const mismatches = [
        { username: ` ${plainEmail}`, password: plain.password },
        { username: `${plainEmail} `, password: plain.password },
        { username: plainEmail, password: padded.password },
      ];
      for (const fields of mismatches) {
        const session = ctx.session();
        const res = await session.postForm('/login', fields);
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.match(text, /Invalid credentials/);
        assert.equal(text.includes(plain.password), false);
        assert.equal(text.includes(padded.password), false);
        assert.equal(text.includes(plainHash), false);
        assert.doesNotMatch(await (await session.fetch('/')).text(), /Log out/);
      }
      assert.equal(passwordHash(ctx.db, plainName), plainHash);

      const asPadded = ctx.session();
      const paddedLogin = await asPadded.postForm('/login', {
        username: paddedEmail,
        password: padded.password,
      });
      assert.equal(paddedLogin.status, 302);
      assert.equal(paddedLogin.headers.get('location'), '/');
      await paddedLogin.text();
      const paddedHome = await (await asPadded.fetch('/')).text();
      assert.match(paddedHome, new RegExp(`/@${paddedName}`));
      assert.equal(paddedHome.includes(`/@${plainName}`), false);
      assert.equal(paddedHome.includes('PLAIN_EMAIL_SECRET'), false);
      assert.equal(paddedHome.includes('PADDED_EMAIL_SECRET'), false);
      const paddedVault = await (await asPadded.fetch(`/${paddedName}/vault`)).text();
      assert.match(paddedVault, /PADDED_EMAIL_SECRET/);
      assert.equal(paddedVault.includes('PLAIN_EMAIL_SECRET'), false);
      const hidden = await asPadded.fetch(`/${plainName}/vault`);
      assert.equal(hidden.status, 404);
      assert.equal((await hidden.text()).includes('PLAIN_EMAIL_SECRET'), false);
      const plainProfile = await (await asPadded.fetch(`/@${plainName}`)).text();
      assert.match(plainProfile, /No repositories yet/);
      assert.equal(plainProfile.includes('PLAIN_EMAIL_SECRET'), false);

      const asPlain = ctx.session();
      const plainLogin = await asPlain.postForm('/login', {
        username: plainEmail,
        password: plain.password,
      });
      assert.equal(plainLogin.status, 302);
      await plainLogin.text();
      const plainVault = await (await asPlain.fetch(`/${plainName}/vault`)).text();
      assert.match(plainVault, /PLAIN_EMAIL_SECRET/);
      assert.equal(plainVault.includes('PADDED_EMAIL_SECRET'), false);
      const otherHidden = await asPlain.fetch(`/${paddedName}/vault`);
      assert.equal(otherHidden.status, 404);
      assert.equal((await otherHidden.text()).includes('PADDED_EMAIL_SECRET'), false);
    });
  });

  test('a password keeps an internal space on the web and over git', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const password = 'horse battery';
      const user = await registerUser(ctx, owner, { password });
      const hash = passwordHash(ctx.db, user.username);
      const mismatches = ['horsebattery', 'horse  battery', ` ${password}`, `${password} `];

      for (const attempt of mismatches) {
        const session = ctx.session();
        const res = await session.postForm('/login', { username: user.username, password: attempt });
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.match(text, /Invalid credentials/);
        assert.equal(text.includes(password), false);
        assert.equal(text.includes(hash), false);
        assert.doesNotMatch(await (await session.fetch('/')).text(), /Log out/);
      }

      const signedIn = ctx.session();
      const ok = await signedIn.postForm('/login', { username: user.email, password });
      assert.equal(ok.status, 302);
      assert.equal(ok.headers.get('location'), '/');
      await ok.text();
      assert.match(await (await signedIn.fetch('/')).text(), new RegExp(`/@${user.username}`));
      assert.equal(passwordHash(ctx.db, user.username), hash);

      await createRepo(owner, { name: 'writes', description: '' });
      const fullName = `${user.username}/writes`;
      commitToBare(barePath(user.username, 'writes'), {
        files: { 'keep.txt': 'SPACE_PASS_BODY\n' },
        message: 'space-pass-ship',
      });
      const head = headOf(user.username, 'writes');
      setUpdatedAt(ctx.db, fullName, FROZEN);
      const pack = `/${user.username}/writes/git-receive-pack`;

      for (const attempt of mismatches) {
        const res = await ctx.session().fetch(pack, {
          method: 'POST',
          headers: { authorization: basicAuth(user.username, attempt) },
          body: '',
        });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Basic realm="GITGRAM"');
        const text = await res.text();
        assert.equal(text.includes(password), false);
        assert.equal(text.includes(hash), false);
      }
      await assertUpdatedAtStays(ctx.db, fullName, FROZEN);
      assert.equal(headOf(user.username, 'writes'), head);

      const allowed = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(user.username, password) },
        body: '',
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('content-type'), 'application/x-git-receive-pack-result');
      await allowed.text();
      const refreshed = await waitForUpdatedAt(ctx.db, fullName, FROZEN);
      assert.notEqual(refreshed, FROZEN);
      assert.equal(headOf(user.username, 'writes'), head);
      const blob = await (await owner.fetch(`/${user.username}/writes/blob/main/keep.txt`)).text();
      assert.match(blob, /SPACE_PASS_BODY/);
      assert.equal(passwordHash(ctx.db, user.username), hash);
    });
  });

  test('an omitted description is stored blank and is not the word undefined', async () => {
    await withApp(async (ctx) => {
      const session = ctx.session();
      const user = await registerUser(ctx, session);
      const created = await session.postForm('/new', { name: 'blank-desc' });
      assert.equal(created.status, 302);
      await created.text();
      const row = repoRow(ctx.db, `${user.username}/blank-desc`);
      assert.equal(row.description, '');
      assert.equal(row.private, 0);

      const page = await (await session.fetch(`/${user.username}/blank-desc`)).text();
      assert.match(page, /blank-desc/);
      assert.equal(page.includes('undefined'), false);
      assert.equal(page.includes('repo-description'), false);

      const home = await (await ctx.session().fetch('/')).text();
      assert.match(home, /blank-desc/);
      assert.equal(home.includes('undefined'), false);
      const found = await (await ctx.session().fetch('/api/search/repos?q=blank-desc')).json();
      assert.equal(found.length, 1);
      assert.equal(found[0].description, '');
      assert.equal(Object.hasOwn(found[0], 'password'), false);
    });
  });

  test('each commit keeps its own author and subject', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'paired', description: '' });
      const hashes = commitToBare(barePath(user.username, 'paired'), {
        revisions: [
          {
            files: { 'notes.txt': 'ALPHA_FILE_z2\n' },
            message: 'alpha-ship-z2',
            author: 'NiaOne',
            email: 'hidden-alpha-z2@example.test',
          },
          {
            files: { 'notes.txt': 'BETA_FILE_z2\n' },
            message: 'beta-ship-z2',
            author: 'OmarTwo',
            email: 'hidden-beta-z2@example.test',
          },
        ],
      });
      const history = await (await owner.fetch(`/${user.username}/paired/commits`)).text();
      assert.match(history, /<p class="commit-message-full">beta-ship-z2<\/p><div class="commit-meta"><span>OmarTwo<\/span>/);
      assert.match(history, /<p class="commit-message-full">alpha-ship-z2<\/p><div class="commit-meta"><span>NiaOne<\/span>/);
      assert.match(history, new RegExp(`<span class="commit-hash-full">${hashes[1].slice(0, 7)}</span>`));
      assert.match(history, new RegExp(`<span class="commit-hash-full">${hashes[0].slice(0, 7)}</span>`));
      assert.equal(history.includes('<p class="commit-message-full">beta-ship-z2</p><div class="commit-meta"><span>NiaOne</span>'), false);
      assert.equal(history.includes('<p class="commit-message-full">alpha-ship-z2</p><div class="commit-meta"><span>OmarTwo</span>'), false);
      assert.equal(history.includes('hidden-alpha-z2@example.test'), false);
      assert.equal(history.includes('hidden-beta-z2@example.test'), false);
      assert.equal(history.includes(hashes[0]), false);
      assert.equal(history.includes(hashes[1]), false);

      const beta = await (await owner.fetch(`/${user.username}/paired/blob/${hashes[1]}/notes.txt`)).text();
      assert.match(beta, /BETA_FILE_z2/);
      assert.equal(beta.includes('ALPHA_FILE_z2'), false);
      const alpha = await (await owner.fetch(`/${user.username}/paired/blob/${hashes[0]}/notes.txt`)).text();
      assert.match(alpha, /ALPHA_FILE_z2/);
      assert.equal(alpha.includes('BETA_FILE_z2'), false);
    });
  });

  test('a path that changes between a file and a directory serves that commit', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      await createRepo(owner, { name: 'shapes', description: '' });
      const hashes = commitToBare(barePath(user.username, 'shapes'), {
        revisions: [
          {
            files: {
              'docs/guide.txt': 'NESTED_SECRET_z9\n',
              'notes': 'NOTE_FILE_z9\n',
            },
            message: 'first-shape-z9',
          },
          {
            remove: ['docs', 'notes'],
            message: 'clear-shape-z9',
          },
          {
            files: {
              'docs': 'FILE_NOW_z9\n',
              'notes/guide.txt': 'NOTE_NESTED_z9\n',
            },
            message: 'second-shape-z9',
          },
        ],
      });

      const page = await (await owner.fetch(`/${user.username}/shapes`)).text();
      assert.match(page, /<span>📄<\/span><a href="\/[^"]+\/docs"/);
      assert.doesNotMatch(page, /<span><\/span><a href="\/[^"]+\/docs"/);
      assert.match(page, /<span><\/span><a href="\/[^"]+\/notes"/);
      assert.doesNotMatch(page, /<span>📄<\/span><a href="\/[^"]+\/notes"/);
      for (const secret of ['NESTED_SECRET_z9', 'NOTE_FILE_z9', 'FILE_NOW_z9', 'NOTE_NESTED_z9']) {
        assert.equal(page.includes(secret), false, secret);
      }

      const docsNow = await owner.fetch(`/${user.username}/shapes/blob/main/docs`);
      const docsNowHtml = await docsNow.text();
      assert.equal(docsNow.status, 200);
      assert.match(docsNowHtml, /FILE_NOW_z9/);
      assert.equal(docsNowHtml.includes('NESTED_SECRET_z9'), false);
      assert.equal(docsNowHtml.includes('guide.txt'), false);

      const notesNow = await owner.fetch(`/${user.username}/shapes/blob/main/notes`);
      const notesNowHtml = await notesNow.text();
      assert.equal(notesNow.status, 200);
      assert.match(notesNowHtml, /guide\.txt/);
      assert.equal(notesNowHtml.includes('NOTE_FILE_z9'), false);
      assert.equal(notesNowHtml.includes('NOTE_NESTED_z9'), false);

      const docsThen = await owner.fetch(`/${user.username}/shapes/blob/${hashes[0]}/docs`);
      const docsThenHtml = await docsThen.text();
      assert.equal(docsThen.status, 200);
      assert.match(docsThenHtml, /guide\.txt/);
      assert.equal(docsThenHtml.includes('NESTED_SECRET_z9'), false);
      assert.equal(docsThenHtml.includes('FILE_NOW_z9'), false);

      const notesThen = await owner.fetch(`/${user.username}/shapes/blob/${hashes[0]}/notes`);
      const notesThenHtml = await notesThen.text();
      assert.equal(notesThen.status, 200);
      assert.match(notesThenHtml, /NOTE_FILE_z9/);
      assert.equal(notesThenHtml.includes('NOTE_NESTED_z9'), false);
      assert.equal(notesThenHtml.includes('guide.txt'), false);

      const history = await (await owner.fetch(`/${user.username}/shapes/commits`)).text();
      assert.match(history, /first-shape-z9/);
      assert.match(history, /second-shape-z9/);
    });
  });

  test('a repository name containing a space is a separate git repository', async () => {
    await withApp(async (ctx) => {
      const owner = ctx.session();
      const user = await registerUser(ctx, owner);
      const stranger = ctx.session();
      const other = await registerUser(ctx, stranger);
      const spaced = 'spaced name';
      await createRepo(owner, { name: spaced, description: 'space-git' });
      await createRepo(owner, { name: 'spaced', description: 'short-git' });
      commitToBare(barePath(user.username, spaced), {
        files: { 'keep.txt': 'SPACED_GIT_BODY\n' },
        message: 'spaced-ship',
      });
      commitToBare(barePath(user.username, 'spaced'), {
        files: { 'keep.txt': 'SHORT_GIT_BODY\n' },
        message: 'short-ship',
      });
      const spacedHead = headOf(user.username, spaced);
      const shortHead = headOf(user.username, 'spaced');
      assert.notEqual(spacedHead, shortHead);
      const spacedFull = `${user.username}/${spaced}`;
      const shortFull = `${user.username}/spaced`;
      setUpdatedAt(ctx.db, spacedFull, FROZEN);
      setUpdatedAt(ctx.db, shortFull, FROZEN);

      const spacedRefs = await ctx.session().fetch(
        `/${user.username}/${encodeURIComponent(spaced)}.git/info/refs?service=git-upload-pack`
      );
      const spacedAdvertised = await spacedRefs.text();
      assert.equal(spacedRefs.status, 200);
      assert.equal(spacedRefs.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
      assert.match(spacedAdvertised, new RegExp(spacedHead));
      assert.equal(spacedAdvertised.includes(shortHead), false);

      const shortRefs = await ctx.session().fetch(
        `/${user.username}/spaced.git/info/refs?service=git-upload-pack`
      );
      const shortAdvertised = await shortRefs.text();
      assert.equal(shortRefs.status, 200);
      assert.match(shortAdvertised, new RegExp(shortHead));
      assert.equal(shortAdvertised.includes(spacedHead), false);
      assert.equal(repoRow(ctx.db, spacedFull).updated_at, FROZEN);
      assert.equal(repoRow(ctx.db, shortFull).updated_at, FROZEN);

      const pack = `/${user.username}/${encodeURIComponent(spaced)}/git-receive-pack`;
      const denied = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(other.username, other.password) },
        body: '',
      });
      assert.equal(denied.status, 403);
      assert.match(await denied.text(), /Permission denied/);
      await assertUpdatedAtStays(ctx.db, spacedFull, FROZEN);
      assert.equal(repoRow(ctx.db, shortFull).updated_at, FROZEN);

      const allowed = await ctx.session().fetch(pack, {
        method: 'POST',
        headers: { authorization: basicAuth(user.username, user.password) },
        body: '',
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('content-type'), 'application/x-git-receive-pack-result');
      await allowed.text();
      const refreshed = await waitForUpdatedAt(ctx.db, spacedFull, FROZEN);
      assert.notEqual(refreshed, FROZEN);
      assert.equal(repoRow(ctx.db, shortFull).updated_at, FROZEN);
      assert.equal(headOf(user.username, spaced), spacedHead);
      assert.equal(headOf(user.username, 'spaced'), shortHead);

      const spacedBlob = await (await ctx.session().fetch(
        `/${user.username}/${encodeURIComponent(spaced)}/blob/main/keep.txt`
      )).text();
      assert.match(spacedBlob, /SPACED_GIT_BODY/);
      assert.equal(spacedBlob.includes('SHORT_GIT_BODY'), false);
      const shortBlob = await (await ctx.session().fetch(`/${user.username}/spaced/blob/main/keep.txt`)).text();
      assert.match(shortBlob, /SHORT_GIT_BODY/);
      assert.equal(shortBlob.includes('SPACED_GIT_BODY'), false);
    });
  });
});
