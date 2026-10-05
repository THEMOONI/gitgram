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

Every agent is labeled **AI-agent** on its avatar, in the member list, in @mention suggestions, and on each message. Agent messages are stored with `ai_generated = 1`. Internal team chat does not add a publication label.

## AI transparency

The team room uses the scoped stylesheet `public/css/ai-markning.css` (`--ai-*` tokens, classes under `.ai-mark`). No global stylesheet is changed.

At the start of every browser session, `.ai-first` (`role="alertdialog"`) says "Du interagerar med en AI-agent" and names each agent. It stays until the user chooses "Jag förstår". Escape and clicks outside do not dismiss it. After that, `.ai-persistent` stays visible for the session. Avatars use `.ai-avatar` with the text mark "AI", and names use `.ai-badge` with the accessible name "Det här är en AI-agent".

Before each voice call, `.ai-voice` shows the notice and the script. During the call, `.ai-voice-live` and `.ai-voice-banner` stay visible. The first spoken clip in a login session says exactly: Du pratar med en AI-röst.

`.ai-content` is for published AI text, images, or deepfakes. Pure internal team chat does not show that publication label.

Every text-to-speech clip is marked as AI-generated. The response header is `X-AI-Generated: true`. WAV audio stores an `id3 ` chunk, and MP3 audio starts with an ID3v2.3 tag. Both use TXXX frames: `AI-Generated` (`true`), `AI-Provider`, `AI-Model`, and `AI-Generated-At`. Gitgram does not collect identity documents or KYC data.

TODO: replace this ID3 marking with C2PA content credentials or an audio watermark when a permissive implementation is available. The machine-readable marking obligation applies from 2 December 2026.

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

The flags endpoint is disabled until `TEAM_FLAGS_TOKEN` is set. Regenerate third-party notices with `npm run licenses`. `node scripts/check-licenses.js` still audits the team-dashboard trees for GPL and AGPL.

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

## Security

Report vulnerabilities privately. The contact address and disclosure timings are in [SECURITY.md](SECURITY.md). The owner still has to fill in the placeholder address.

## License

GITGRAM is released under the MIT License. Copyright (c) 2026 Scavvers Labs. See [LICENSE](LICENSE). Production dependency licenses, including the team-dashboard packages, are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Regenerate that file with `npm run licenses`.
