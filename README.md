# Scavvers

Scavvers is a small, self-hosted, open-source Git platform (MIT, © 2026 Scavvers Labs). It is at an early stage. It runs on Node.js, Express, and SQLite, stores bare repositories on disk, and serves a web UI plus ordinary `git clone` and `git push` over HTTP.

## Requirements

- Node.js 22+ (`better-sqlite3` 13 needs it)
- Git on the server `PATH`

## Run

```bash
npm install
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
npm start
```

The app listens on port 3000 unless `PORT` is set. Open `http://localhost:3000`, create an account, and create a repository. Clone and push with the URL shown on the repository page. New repositories are public unless marked private. A private repository is visible to its owner only, and clone and push then require that owner's username and password over HTTP Basic auth.

## Test

```bash
npm test
```

That runs `node --test`.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | Yes in production | Signs session cookies. If it is unset outside production, the server prints a warning and uses an insecure development fallback. Do not deploy that fallback. |
| `PORT` | No | HTTP port. Defaults to `3000`. |
| `PUBLIC_URL` | No | Base URL shown in clone instructions. Defaults to `http://localhost:$PORT`. |
| `GITGRAM_DB` | No | SQLite database path. Defaults to `db/gitgram.db`. |
| `GITGRAM_DATA` | No | Directory for bare repositories. Defaults to `data/`. |

## Security

Report vulnerabilities privately. The contact address and disclosure timings are in [SECURITY.md](SECURITY.md). The owner still has to fill in the placeholder address.

## License

Scavvers is released under the MIT License. Copyright (c) 2026 Scavvers Labs. See [LICENSE](LICENSE). Production dependency licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Regenerate that file with `npm run licenses`.
