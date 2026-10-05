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

## Paper trading (demo)

Paper trading sits on the demo wallet. It is a simulated order engine. Agents and the browser place orders through an API. They never write balances directly. There is no broker, no exchange, no blockchain, no KYC, and no real money. Every page and every JSON response carries `DEMO – inga riktiga pengar`. Results are labelled simulated. Historical results are not a promise of future returns, and the product does not give personalized buy or sell advice about real assets.

### How the money stays inside the demo

The wallet ledger keeps integer cents of **GGT (demo)**. The paper ledger keeps integer **micro-DEMO** (1 GGT (demo) = 1 DEMO = 1,000,000 micro; 1 wallet cent = 10,000 micro). Conversion happens only when demo units move between the user wallet and the `system:paper-custody` account.

Allocating parks cents in custody and credits the paper cash account. Withdrawing returns at most the parked principal, floored to cents. Simulated profit above that principal stays in the paper book and is not minted into the wallet. A simulated loss can leave cents sitting in custody, because the engine does not burn wallet units to match a paper mark. Both of those edges are intentional.

### Run it

```bash
npm install
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
npm start
```

No market-data API key is required. Without `COINGECKO_API_KEY` the server uses a built-in fictional price series, and `npm test` uses a fake feed. Sign in, open **Paper trade**, allocate demo units from the wallet, and place a market, limit, or stop order. Stop orders are sell-only. A buy fill creates a protective stop. Backtests reuse the same fill, risk, and ledger code on separate `bt_*` tables and never touch the live paper ledger.

| Route | Access | What it does |
| --- | --- | --- |
| `GET /trade` | Signed in | Portfolio, positions, orders, and the order form. |
| `POST /trade/open` | Signed in, CSRF | Allocates wallet cents into a paper portfolio. |
| `POST /trade/orders` | Signed in, CSRF | Places a simulated order. |
| `GET /trade/backtest` | Signed in | Runs strategy A, B, or C on the configured feed. |
| `/api/demo/...` | Session + CSRF, or `Authorization: Bearer ggtdemo_…` | Portfolios, orders, fills, equity, pause, and backtests. |

There is no price endpoint and no price-series export. Portfolio values, the equity curve, and percent metrics are simulated results, not a market-data feed. Fill prices are the user's own simulated trades.

### Risk limits

Orders are rejected before a fill when they break a hard ceiling: 20% of equity per position, 20% per order, 5 open positions, 5 trades per UTC day, a 5% cash buffer, and a mandatory stop-loss no wider than 12%. Profiles may be stricter. They cannot be looser. There is no leverage and no shorting. A kill switch pauses trading at 20% drawdown from peak equity, cancels open buys, and leaves protective stops in place. Only the portfolio owner can resume. An agent key can pause, not resume.

Strategy B in the strategy notes asks for 10 trades a day and a 25% stop. The engine caps that at 5 trades a day and a 12% stop. Strategy C (8% stop, 15% size, 3 positions) is stricter than the ceiling and runs as written.

### Market data

`PriceFeed` is a swappable adapter. The default is the fictional series. Set `COINGECKO_API_KEY` to use CoinGecko (crypto only: BTC, ETH, SOL, BNB, XRP). The key is sent as a header, never in the URL, and it is never stored in the repo. Each install brings its own key. When that feed is active the UI shows both “Powered by CoinGecko” and “Data provided by CoinGecko”.

History is fetched for a backtest and cached at most 24 hours. A disk cache is written only when `GITGRAM_PRICE_CACHE_KEY` is 64 hex characters (AES-256-GCM via `node:crypto`). Otherwise the cache stays in memory. Callers can purge it. There is no permanent price database.

### Region check

`GITGRAM_GEO_BLOCK_COUNTRIES` is an operator list of ISO country codes. The app reads the country from `GITGRAM_GEO_COUNTRY_HEADER` (default `x-country-code`). It does not call a geolocation vendor and it does not hardcode anyone else's country list. An empty list allows everyone. `GITGRAM_GEO_FAIL_CLOSED=1` rejects a request that has no country. A blocked request gets HTTP 451.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `COINGECKO_API_KEY` | No | Market-data key for this install. Unset means the fictional feed. |
| `COINGECKO_API_PLAN` | No | `demo` (default, `api.coingecko.com`, header `x-cg-demo-api-key`) or `pro` (`pro-api.coingecko.com`, header `x-cg-pro-api-key`). |
| `GITGRAM_PRICE_CACHE_KEY` | No | 64 hex chars. Enables the encrypted 24-hour price cache on disk. |
| `GITGRAM_GEO_BLOCK_COUNTRIES` | No | Comma-separated ISO codes to refuse. Empty allows all. |
| `GITGRAM_GEO_COUNTRY_HEADER` | No | Header the operator (or their proxy) uses to supply a country. Default `x-country-code`. |
| `GITGRAM_GEO_FAIL_CLOSED` | No | Set to `1` to refuse requests with no country when a block list is configured. |

### Dependencies and licenses

This feature adds no runtime or test dependency. Crypto uses `node:crypto`. Existing packages stay as they are: `bcryptjs` (BSD-3-Clause), `better-sqlite3`, `compression`, `express`, `express-session`, `moment`, and `supertest` (MIT), and `ejs` (Apache-2.0). None of those is GPL or AGPL. A test fails if a broker or exchange SDK is added to `package.json`.

## Security

Report vulnerabilities privately. The contact address and disclosure timings are in [SECURITY.md](SECURITY.md). The owner still has to fill in the placeholder address.

## License

GITGRAM is released under the MIT License. Copyright (c) 2026 Scavvers Labs. See [LICENSE](LICENSE). Production dependency licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Regenerate that file with `npm run licenses`.
