# GITGRAM

A self-hosted Git platform. It serves a web UI for browsing repositories and
implements Git's smart HTTP protocol, so you can `git clone` and `git push`
against it with an ordinary Git client.

Built with Node.js, Express, EJS and SQLite. Repositories are stored as real
bare Git repositories on disk, so nothing about your data is locked into this
application.

## Requirements

- Node.js 20.6 or newer
- `git` available on `PATH` (the server shells out to it for pack operations)

## Getting started

```bash
npm install
cp .env.example .env      # then set SESSION_SECRET
npm start
```

The app is then available at http://localhost:3000. To load `.env`
automatically, start it with Node's built-in loader:

```bash
node --env-file=.env server.js
```

For development with automatic restarts on file changes:

```bash
npm run dev
```

## Using it

1. Register an account, then create a repository from **+ New Repo**.
2. Push to the clone URL shown on the repository page:

```bash
git remote add origin http://localhost:3000/<user>/<repo>.git
git push -u origin main
```

Git will prompt for the username and password of your GITGRAM account. Pushing
always requires authentication, and only the repository owner may push.

Public repositories can be cloned anonymously. Private repositories require
the owner's credentials and are otherwise indistinguishable from a repository
that does not exist.

## Configuration

All configuration is via environment variables; see `.env.example` for the
full list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port. `0` picks an ephemeral port. |
| `SESSION_SECRET` | random in development | Signs session cookies. Required in production. |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base URL used in the clone instructions. |
| `NODE_ENV` | `development` | `production` enables secure cookies and hides error detail. |
| `TRUST_PROXY` | unset | Passed to Express's `trust proxy` when behind a reverse proxy. |
| `GITGRAM_DATA_DIR` | `./data` | Where bare repositories are stored. |
| `GITGRAM_DB_PATH` | `./db/gitgram.db` | SQLite database location. |

`SESSION_SECRET` is mandatory when `NODE_ENV=production`: without a stable
secret every restart invalidates all sessions and signs everyone out.

## Running in production

- Set `SESSION_SECRET`, `NODE_ENV=production` and `PUBLIC_URL`.
- Terminate TLS at a reverse proxy and set `TRUST_PROXY=1`. Basic auth over
  plain HTTP sends credentials in a trivially reversible encoding, so Git
  traffic should not cross an untrusted network unencrypted.
- Point `GITGRAM_DATA_DIR` and `GITGRAM_DB_PATH` at a persistent volume
  outside the checkout, and back both up together: the database and the bare
  repositories on disk are two halves of the same state.

## Tests

```bash
npm test
```

The suite boots the server on an ephemeral port against a temporary data
directory and drives it with real `git` commands, covering push and clone
authorization, private repository visibility, and the input validation around
refs and paths.

## Project layout

```
server.js          Application bootstrap: middleware, sessions, error handling
lib/paths.js       Name/ref/path validation and repository path resolution
lib/git.js         All git invocations, via argv arrays rather than a shell
lib/schema.js      Database schema
lib/session-store.js  SQLite-backed express-session store
routes/auth.js     Register, login, logout, user profiles
routes/git.js      Git smart HTTP: info/refs, upload-pack, receive-pack
routes/repos.js    Repository creation, file and tree browsing, settings
routes/api.js      JSON endpoints used by the search box
views/             EJS templates
public/            Stylesheet and client-side search
```

## Security notes

Two rules matter when changing this code:

- **Never build a git command as a shell string.** Every invocation goes
  through `lib/git.js`, which uses `spawn` with an argument array. Refs and
  file paths come from the URL, and interpolating them into a shell string is
  how the blob route previously allowed arbitrary command execution.
- **Never join a user-supplied name into a filesystem path directly.** Use
  `repoPathFor` from `lib/paths.js`, which validates each component and
  returns `null` rather than a path outside the data directory.

Access control lives in `authorize` in `routes/git.js` for Git traffic and in
`getRepo` in `routes/repos.js` for the web UI. Both need updating together if
you add a sharing or collaborator feature.

## Current limitations

- A repository has a single owner; there is no collaborator or organisation
  model, so sharing a private repository is not yet possible.
- Browsing shows the default branch only; there is no branch or tag switcher.
- READMEs are rendered as plain text rather than Markdown.
- There are no issues, pull requests, forks or stars.

## License

ISC
