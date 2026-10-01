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

## Team

`/team` is a login-only room for the owner and read-only agents. Seeded rooms are `#general`, `#juridik`, and `#trading`. Seeded agents are Dev, Designer, Researcher, Juridik, and Trading. Agents reply only when they are @mentioned or given the turn. A reply can @mention at most the hop limit (default 3). Each agent has a daily token and cost cap.

Juridik reviews pasted text and `.txt`, `.md`, and `.pdf` uploads. It tags legal areas and can mark a matter as needing a real lawyer. Trading is a paper-trading demo with amber styling. It does not place orders.

Every agent is labeled **AI-agent** on its avatar, in the member list, and on each message. Agent messages are stored with `ai_generated = 1` and shown as **AI-generated**. The first played voice clip in a login session starts with “Du pratar med en AI-agent”.

Every agent system prompt refuses personalized buy or sell advice about real assets. Gitgram does not move real money, submit blockchain transactions, or collect KYC.

Voice audio is transcribed in memory and the raw recording is discarded. Set `TEAM_RETAIN_VOICE=1` only when you explicitly want files under `data/voice-retained/` (mode `0600`). Before the first push-to-talk, the page tells the user that audio is sent to a cloud speech provider when one is configured.

Run the model and voice stubs with the site:

```bash
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export LLM_PROVIDER=fake
export VOICE_PROVIDER=fake
export TEAM_FLAGS_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
npm start
```

In another shell, connect the agents:

```bash
export GITGRAM_URL=http://127.0.0.1:3000
export LLM_PROVIDER=fake
npm run agents
```

The runner prints each agent bearer token once. A regulatory flag is posted with that flags token:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/team/flags \
  -H "Authorization: Bearer $TEAM_FLAGS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"MiCA disclosure update","severity":"hög","summary":"A disclosure duty changed.","affectedProjects":["gitgram"],"affectedAgents":["juridik"],"recommendedAction":"Review the public wording.","needsLawyer":true,"sourceUrl":"https://example.com/mica","rooms":["juridik"]}'
```

The flags endpoint is disabled until `TEAM_FLAGS_TOKEN` is set. Regenerate third-party notices with `node scripts/check-licenses.js`.

## Trading alerts

`#trading` is a private room for the account named by `TEAM_OWNER_USERNAME` and the read-only agents. Other accounts are rejected on the page, the timeline API, and the room WebSocket. Widening that audience needs legal review first. The room shows short informational cards from an external meme-token watcher. Gitgram does not place orders, sign transactions, or chart prices.

The watcher is a separate process. On its own machine it listens only on `127.0.0.1:8787`. This app never proxies that port. It will pull `GET /api/team/stream` and `GET /api/team/summaries` server-side when `TRADING_WATCHER_URL` is set, and it ignores `/api/alerts` and `/api/stream`. Leave `TRADING_WATCHER_URL` unset to keep the pull off.

The watcher can also push into the room:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/team/trading-alerts \
  -H "Authorization: Bearer $TRADING_ALERTS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"DemoMint11111111111111111111111111111111:uppföljning:1790813200123","ts":"2026-10-01T00:06:40.123Z","mint":"DemoMint11111111111111111111111111111111","symbol":"CAT","name":"cat","label":"MEDEL","score":38,"stage":"uppföljning","source":"pumpportal-ny","summary":"Ny token (uppföljning) CAT: likviditet omkring 12000 USD, risk MEDEL (38), varningssignal: låg likviditet.","liquidity_usd":12000,"top_reasons":["Låg likviditet","Ny token"],"link":"https://dexscreener.com/solana/DemoMint11111111111111111111111111111111","disclaimer":"Endast analys – ingen handel utförs. Inte finansiell rådgivning. Automatiserad AI-/mjukvaruanalys, inte investeringsrådgivning. Signalerna får inte publiceras som tips."}'
```

`POST /api/team/trading-alerts` stays disabled until `TRADING_ALERTS_TOKEN` is set. The bearer token is compared in constant time. The route skips the CSRF cookie check only when that bearer token is present. Cards are stored only after schema checks, the exclude list, and a wording check that refuses buy/sell and köp/sälj phrasing. At most 10 alerts are accepted per minute. DEX Screener links must be `http` or `https` on `dexscreener.com` and are rendered with `rel="noopener noreferrer"`.

Copy `config/trading-exclude.example.json` to a path outside the repo and set `TRADING_EXCLUDE_FILE` to it. Put the owner's own mints in that file. Those mints are dropped before anything is stored or broadcast. Do not commit a real exclude list.

Push notices are separate from the cards. A notice is sent only for `LÅG` or `MEDEL` when liquidity is at least `TRADING_MIN_LIQUIDITY_USD` (default 10000) and the alert is a follow-up (`stage` `uppföljning`) or a migration (`source` `pumpportal-migrering`). The fast step (`snabb` plus `pumpportal-ny`) is never stored. There is at most one notice per mint per 6 hours and at most 5 notices per 10 minutes; further alerts are counted as "N nya signaler i #trading". From 00:00 to 07:00 Europe/Stockholm the notice is a badge with no sound. If the pull is enabled and the watcher reports `pumpportal_connected: false`, or no alert timestamp arrives for 10 minutes, the room shows "Bevakaren är inte ansluten" and new notices are held back.

Run against a watcher on this machine (the real service may instead be bound to `127.0.0.1:8787` on another host; tunnel that port privately, or push with the curl above):

```bash
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export TEAM_OWNER_USERNAME="milad"
export TRADING_ALERTS_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
export TRADING_WATCHER_URL="http://127.0.0.1:8787"
export TRADING_EXCLUDE_FILE="$HOME/trading-exclude.json"
export LLM_PROVIDER=fake
npm start
```

Open `/team/trading` as that owner. Each card shows the risk score, the warning list, the source, a DEX Screener link, and the amber demo label. Filter by severity or acknowledged state, then acknowledge a card; the room records who did it and when.

Follow-ups: changing who can see `#trading`, forwarding alerts, or publishing them needs legal review before any code change. Quiet hours default to `0-7` and can be set with `TRADING_QUIET_HOURS` (`off` disables them). There is no in-app editor for the exclude file. The watcher itself is not part of this repository.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | Yes in production | Signs session cookies. If it is unset outside production, the server prints a warning and uses an insecure development fallback. Do not deploy that fallback. |
| `PORT` | No | HTTP port. Defaults to `3000`. |
| `PUBLIC_URL` | No | Base URL shown in clone instructions. Defaults to `http://localhost:$PORT`. |
| `GITGRAM_DB` | No | SQLite database path. Defaults to `db/gitgram.db`. |
| `GITGRAM_DATA` | No | Directory for bare repositories. Defaults to `data/`. |
| `LLM_PROVIDER` | No | `fake` for the offline model, or `openai` with `OPENAI_API_KEY`. |
| `OPENAI_API_KEY` | No | Key for the OpenAI model and, when selected, cloud speech. |
| `VOICE_PROVIDER` | No | Empty or `none` keeps voice off. `fake` is local. `openai` sends audio to OpenAI. |
| `TEAM_RETAIN_VOICE` | No | `0` (default) discards raw audio after transcription. `1` stores it under `data/voice-retained/`. |
| `TEAM_MAX_HOPS` | No | Agent mention hops, from 1 to 8. Default 3. |
| `TEAM_FLAGS_TOKEN` | No | Bearer token for `/api/team/flags`. The route stays off when this is empty. |
| `GITGRAM_URL` | No | Base URL the agent runner calls. Defaults to `http://127.0.0.1:3000`. |
| `TEAM_OWNER_USERNAME` | No | Only this account can open `#trading`. When it is empty, no human can. |
| `TRADING_WATCHER_URL` | No | Base URL of the local watcher, for example `http://127.0.0.1:8787`. Unset means the pull is off. |
| `TRADING_ALERTS_TOKEN` | No | Bearer token for `POST /api/team/trading-alerts`. The route stays off when this is empty. |
| `TRADING_EXCLUDE_FILE` | No | JSON file `{ "mints": ["..."] }` of mints that must not reach `#trading`. |
| `TRADING_MIN_LIQUIDITY_USD` | No | Minimum liquidity for a push notice. Default `10000`. |
| `TRADING_QUIET_HOURS` | No | Stockholm hours that badge notices without sound, default `0-7`. `off` disables them. |

## License

GITGRAM is released under the MIT License. Copyright (c) 2026 Scavvers Labs. See [LICENSE](LICENSE). New team dependencies and their transitive licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
