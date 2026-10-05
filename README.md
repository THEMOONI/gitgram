# GITGRAM

GITGRAM is a small self-hosted Git host. It stores users and repository metadata in SQLite, keeps bare repositories on disk, and serves a web UI plus the Git smart HTTP protocol for push and clone.

## Requirements

- Node.js 22 or newer (`better-sqlite3` 13 needs it)
- Git on the server `PATH`

## Run

```bash
npm install
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
npm start
```

The app listens on port 3000 unless `PORT` is set. Open `http://localhost:3000`, create an account, and create a repository. Clone and push with the URL shown on the repository page. Private repositories require the owner's username and password over HTTP Basic auth.

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

## Demo wallet

The demo wallet is simulated. Balances are **GGT (demo)** units stored in this app's SQLite database. They are not money. There is no deposit, withdrawal, payment integration, or exchange for anything of real-world value. The illustrative USD figure on the wallet page is a fixed display label from the design mockup. It is not a price and it is not convertible. Nothing in the wallet is a financial product.

Each signed-in user receives a one-time grant of 1,000.00 GGT (demo) from the `gitgram-faucet` system account the first time their wallet is opened. Transfers move those demo units to another Gitgram user. Every transfer is two ledger entries that sum to zero, runs in one database transaction, and is stored with an idempotency key so the same submission is not applied twice. Amounts are integer cents (minor units). A user balance cannot go below zero. The faucet account is the issuance source, so its own balance is negative by the amount of demo units it has issued.

| Route | Access | What it does |
| --- | --- | --- |
| `GET /wallet` | Signed in | Balance, 30-day incoming and outgoing totals, and history. `?flow=in` or `?flow=out` filters the list. |
| `POST /wallet/transfer` | Signed in, CSRF | Sends demo units. Fields: `recipient` (a Gitgram username, with or without `@`), `amount` (for example `25.00`), `memo` (optional, 140 characters), and `idempotency_key`. |
| `GET /api/wallet` | Signed in | The same wallet as JSON. Every response includes `"demo": true` and a demo disclaimer. |
| `GET /wallet/export.csv` | Signed in | Downloads that user's simulated history. |

Open `/wallet` while signed in, or use **Demo Wallet** in the navigation. The usernames `wallet` and `gitgram-faucet` are reserved so the page does not collide with a profile. Request and reset are visible and disabled; they are not implemented.

## Security

Report vulnerabilities privately through GitHub private vulnerability reporting: [Report a vulnerability](https://github.com/THEMOONI/gitgram/security/advisories/new). Do not open a public issue for a vulnerability. Acknowledgement and remediation commitments are in [SECURITY.md](SECURITY.md).

## License

GITGRAM is released under the MIT License. Copyright (c) 2026 Scavvers Labs. See [LICENSE](LICENSE). Production dependency licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Regenerate that file with `npm run licenses`.
