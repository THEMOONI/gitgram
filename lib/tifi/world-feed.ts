// Read-only adapter for a local World paper feed. Mapping lives here so the
// rest of TIFI never sees a raw payload. There is no default host. A URL is
// used only when it is loopback. This module does not contain a trading
// client, credentials, or a remote data source.

const WINDOW_MS = 15 * 60 * 1000;

interface WorldOutcome {
  label: string;
  mint: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
}

interface WorldResolution {
  resolved: boolean;
  winningOutcome: string | null;
  resolvedAt: string | null;
}

interface WorldMarket {
  id: string;
  title: string;
  underlying: string;
  seriesTicker: string;
  horizonMinutes: number;
  opensAt: string | null;
  closesAt: string | null;
  status: string;
  outcomes: WorldOutcome[];
  updatedAt: string | null;
  source: string;
  fetchedAt: string;
  resolution: WorldResolution;
}

interface WorldSnapshot {
  markets: WorldMarket[];
  source: string;
  live: boolean;
  fetchedAt: string;
  note: string | null;
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPrice(value: number | null): number | null {
  if (value == null) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function canonicalSide(label: string): string {
  const name = label.toUpperCase();
  if (name === 'UP' || name === 'YES' || name === 'Y') return 'YES';
  if (name === 'DOWN' || name === 'NO' || name === 'N') return 'NO';
  return name;
}

function outcomeFromPrices(label: string, bidRaw: unknown, askRaw: unknown, mint: unknown): WorldOutcome | null {
  const bid = clampPrice(finite(bidRaw));
  const ask = clampPrice(finite(askRaw));
  let mid: number | null = null;
  if (bid != null && ask != null) mid = clampPrice((bid + ask) / 2);
  else mid = bid != null ? bid : ask;
  if (bid == null && ask == null && mid == null) return null;
  return { label, mint: text(mint), bid, ask, mid };
}

function mapOutcome(raw: any): WorldOutcome | null {
  if (!raw || typeof raw !== 'object') return null;
  const label = canonicalSide(text(raw.label || raw.name || raw.outcome));
  if (!label) return null;
  const priced = outcomeFromPrices(
    label,
    raw.bid != null ? raw.bid : raw.bestBid != null ? raw.bestBid : raw.best_bid,
    raw.ask != null ? raw.ask : raw.bestAsk != null ? raw.bestAsk : raw.best_ask,
    raw.mint || raw.token || raw.tokenId,
  );
  if (!priced) return null;
  const mid = clampPrice(finite(raw.mid != null ? raw.mid : raw.price));
  if (mid != null) priced.mid = mid;
  return priced;
}

function mapResolution(raw: any, status: string, closesAt: string | null): WorldResolution {
  const result = text(raw && raw.result).toLowerCase();
  if (result === 'yes' || result === 'no') {
    const done = status === 'finalized';
    return {
      resolved: done,
      winningOutcome: done ? (result === 'yes' ? 'YES' : 'NO') : null,
      resolvedAt: done ? closesAt : null,
    };
  }
  const block = raw && typeof raw.resolution === 'object' ? raw.resolution : null;
  const winning = canonicalSide(text(block && (block.winningOutcome || block.winning_outcome || block.winner)));
  const named = winning === 'YES' || winning === 'NO' ? winning : '';
  const done = status === 'finalized' || !!(block && (block.resolved === true || named));
  return {
    resolved: !!(done && named),
    winningOutcome: named || null,
    resolvedAt: block ? text(block.resolvedAt || block.resolved_at) || null : null,
  };
}

function seriesList(env?: Record<string, string | undefined>): { ticker: string; underlying: string; slot: number }[] {
  return [
    { ticker: text(env && env.WORLD_SERIES_BTC) || 'WXBTC15M', underlying: 'BTC', slot: 1 },
    { ticker: text(env && env.WORLD_SERIES_ETH) || 'WXETH15M', underlying: 'ETH', slot: 2 },
    { ticker: text(env && env.WORLD_SERIES_SOL) || 'WXSOL15M', underlying: 'SOL', slot: 3 },
  ];
}

function underlyingForSeries(seriesTicker: string, env?: Record<string, string | undefined>): string | null {
  const name = text(seriesTicker).toUpperCase();
  if (!name) return null;
  const known = seriesList(env).find((row) => row.ticker.toUpperCase() === name);
  if (known) return known.underlying;
  if (name.includes('ETH')) return 'ETH';
  if (name.includes('SOL')) return 'SOL';
  if (name.includes('BTC')) return 'BTC';
  return null;
}

function tigerUnderlying(tiger: any): string {
  const slot = Number(tiger && tiger.slot);
  if (slot === 2) return 'ETH';
  if (slot === 3) return 'SOL';
  if (slot === 1) return 'BTC';
  let symbols: string[] = [];
  try {
    symbols = JSON.parse(tiger && tiger.symbols_json || '[]');
  } catch {
    symbols = [];
  }
  const first = text(symbols[0]).toUpperCase();
  if (first === 'ETH' || first === 'SOL' || first === 'BTC') return first;
  return 'BTC';
}

function mapMarket(raw: any, fetchedAt?: string, env?: Record<string, string | undefined>): WorldMarket | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = text(raw.ticker || raw.id || raw.marketId || raw.market_id || raw.slug);
  if (!id) return null;
  const seriesTicker = text(raw.seriesTicker || raw.series_ticker);
  let status = text(raw.status || 'active').toLowerCase() || 'active';
  if (status === 'resolved' || status === 'settled') status = 'finalized';
  const accounts = raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {};
  const hasBook = raw.yesBid != null || raw.yesAsk != null || raw.noBid != null || raw.noAsk != null
    || raw.yes_bid != null || raw.yes_ask != null || raw.no_bid != null || raw.no_ask != null;
  let outcomes: WorldOutcome[] = [];
  if (hasBook) {
    const yes = outcomeFromPrices('YES', raw.yesBid != null ? raw.yesBid : raw.yes_bid, raw.yesAsk != null ? raw.yesAsk : raw.yes_ask, accounts.yesMint || accounts.yes_mint);
    const no = outcomeFromPrices('NO', raw.noBid != null ? raw.noBid : raw.no_bid, raw.noAsk != null ? raw.noAsk : raw.no_ask, accounts.noMint || accounts.no_mint);
    if (yes) outcomes.push(yes);
    if (no) outcomes.push(no);
  } else if (Array.isArray(raw.outcomes)) {
    outcomes = raw.outcomes.map(mapOutcome).filter(Boolean) as WorldOutcome[];
  }
  const fromSeries = underlyingForSeries(seriesTicker, env);
  const underlying = fromSeries || text(raw.underlying || raw.asset || raw.symbol || 'BTC').toUpperCase() || 'BTC';
  const horizon = finite(raw.horizonMinutes != null ? raw.horizonMinutes : raw.horizon_minutes);
  const opensAt = text(raw.openTime || raw.open_time || raw.opensAt || raw.opens_at || raw.startTime || raw.start_time) || null;
  const closesAt = text(raw.closeTime || raw.close_time || raw.closesAt || raw.closes_at || raw.endTime || raw.end_time) || null;
  const resolution = mapResolution(raw, status, closesAt);
  const source = text(raw.source);
  return {
    id,
    title: text(raw.title || raw.question || raw.name) || (seriesTicker ? seriesTicker + ' ' + id : id),
    underlying,
    seriesTicker,
    horizonMinutes: horizon == null ? 15 : horizon,
    opensAt,
    closesAt,
    status,
    outcomes,
    updatedAt: text(raw.updatedAt || raw.updated_at) || null,
    source,
    fetchedAt: text(raw.fetchedAt || raw.fetched_at) || fetchedAt || '',
    resolution,
  } as WorldMarket;
}

function unwrapList(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.markets)) return body.markets;
  if (body && Array.isArray(body.data)) return body.data;
  return [];
}

function mapMarketList(body: any, fetchedAt?: string, env?: Record<string, string | undefined>): WorldMarket[] {
  return unwrapList(body).map((row) => mapMarket(row, fetchedAt, env)).filter(Boolean) as WorldMarket[];
}

function loopbackBase(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') return null;
  return raw.replace(/\/$/, '');
}

function simulatedReference(ms: number, salt = 0): number {
  const minute = Math.floor(ms / 60000) + salt;
  return 65000 + Math.sin(minute / 5) * 120 + (minute % 30) * 3;
}

function windowStart(ms: number): number {
  return Math.floor(ms / WINDOW_MS) * WINDOW_MS;
}

function pricePair(mid: number): { bid: number; ask: number; mid: number } {
  const spread = 0.02;
  const clamped = Math.min(0.92, Math.max(0.08, mid));
  return {
    bid: Math.round((clamped - spread / 2) * 10000) / 10000,
    ask: Math.round((clamped + spread / 2) * 10000) / 10000,
    mid: Math.round(clamped * 10000) / 10000,
  };
}

function simulatedRaw(series: { ticker: string; underlying: string }, startMs: number, nowMs: number, resolved: boolean): any {
  const salt = series.underlying === 'ETH' ? 11 : series.underlying === 'SOL' ? 23 : 0;
  const openPx = simulatedReference(startMs, salt);
  const markMs = resolved ? startMs + WINDOW_MS : nowMs;
  const markPx = simulatedReference(markMs, salt);
  const yesWins = markPx >= openPx;
  const drift = (markPx - openPx) / 80;
  const liveYes = pricePair(0.5 + drift * 0.15);
  const liveNo = pricePair(1 - liveYes.mid);
  const yes = resolved
    ? { bid: yesWins ? 1 : 0, ask: yesWins ? 1 : 0 }
    : liveYes;
  const no = resolved
    ? { bid: yesWins ? 0 : 1, ask: yesWins ? 0 : 1 }
    : liveNo;
  const fetchedAt = new Date(nowMs).toISOString();
  return {
    ticker: series.ticker + '-' + startMs,
    seriesTicker: series.ticker,
    openTime: new Date(startMs).toISOString(),
    closeTime: new Date(startMs + WINDOW_MS).toISOString(),
    status: resolved ? 'finalized' : 'active',
    result: resolved ? (yesWins ? 'yes' : 'no') : '',
    yesBid: yes.bid,
    yesAsk: yes.ask,
    noBid: no.bid,
    noAsk: no.ask,
    source: 'simulated',
    fetchedAt,
  };
}

function simulatedSnapshot(now: Date, env?: Record<string, string | undefined>): WorldSnapshot {
  const nowMs = now.getTime();
  const start = windowStart(nowMs);
  const markets = seriesList(env)
    .map((series) => mapMarket(simulatedRaw(series, start, nowMs, false), now.toISOString(), env))
    .filter(Boolean) as WorldMarket[];
  return {
    markets,
    source: 'simulated',
    live: false,
    fetchedAt: now.toISOString(),
    note: null,
  };
}

function simulatedById(id: string, now: Date, env?: Record<string, string | undefined>): WorldMarket | null {
  const match = /^(.*)-(\d+)$/.exec(id);
  if (!match) return null;
  const start = Number(match[2]);
  if (!Number.isFinite(start)) return null;
  const series = seriesList(env).find((row) => row.ticker === match[1]);
  if (!series) return null;
  const resolved = now.getTime() >= start + WINDOW_MS;
  return mapMarket(simulatedRaw(series, start, now.getTime(), resolved), now.toISOString(), env);
}

function worldStreamUrl(base: string | null | undefined): string | null {
  const root = loopbackBase(base);
  if (!root) return null;
  return root + '/api/world/stream';
}

function parseWorldStreamChunk(text: string, fetchedAt?: string): WorldMarket[] {
  const events: WorldMarket[] = [];
  const blocks = String(text || '').split(/\n\n/);
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      const json = JSON.parse(data);
      const rows = Array.isArray(json) ? json : [json.market || json];
      for (const row of rows) {
        const market = mapMarket(row, fetchedAt);
        if (market) events.push(market);
      }
    } catch {
      // Ignore a partial or malformed event. The next poll still works.
    }
  }
  return events;
}

function pickMarket(markets: WorldMarket[], underlying: string): WorldMarket | null {
  const want = text(underlying).toUpperCase() || 'BTC';
  const active = (markets || []).filter((market) => market.status === 'active' && !market.resolution.resolved);
  return active.find((market) => market.underlying === want && market.horizonMinutes === 15)
    || active.find((market) => market.underlying === want)
    || null;
}

function pickBtcMarket(markets: WorldMarket[]): WorldMarket | null {
  return pickMarket(markets, 'BTC');
}

function createWorldFeed(env?: Record<string, string | undefined>, opts: {
  fetchImpl?: typeof fetch;
  now?: () => Date;
} = {}): {
  source: string;
  live: boolean;
  listActive: () => Promise<WorldSnapshot>;
  getMarket: (id: string) => Promise<WorldMarket | null>;
} {
  const nowFn = opts.now || (() => new Date());
  const base = loopbackBase(env && env.WORLD_FEED_URL);
  const fetchImpl = opts.fetchImpl;

  async function readJson(url: string): Promise<any> {
    if (!fetchImpl) throw new Error('WORLD_FEED_NO_FETCH');
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(2500)
      : undefined;
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal });
    if (!response || !response.ok) throw new Error('WORLD_FEED_HTTP');
    return response.json();
  }

  return {
    source: base ? 'world' : 'simulated',
    live: !!base,
    async listActive(): Promise<WorldSnapshot> {
      const now = nowFn();
      if (!base) return simulatedSnapshot(now, env);
      try {
        const body = await readJson(base + '/api/world/markets?status=active');
        const fetchedAt = now.toISOString();
        return {
          markets: mapMarketList(body, fetchedAt, env),
          source: 'world',
          live: true,
          fetchedAt,
          note: null,
        };
      } catch {
        const fallback = simulatedSnapshot(now, env);
        fallback.note = 'Flödet svarade inte. Visar det simulerade flödet.';
        return fallback;
      }
    },
    async getMarket(id: string): Promise<WorldMarket | null> {
      const now = nowFn();
      if (!base) return simulatedById(id, now, env);
      try {
        const body = await readJson(base + '/api/world/markets/' + encodeURIComponent(id));
        const market = mapMarket(body && body.market ? body.market : body, now.toISOString(), env);
        return market;
      } catch {
        return simulatedById(id, now, env);
      }
    },
  };
}

module.exports = {
  WINDOW_MS,
  mapOutcome,
  mapMarket,
  mapMarketList,
  loopbackBase,
  simulatedReference,
  simulatedSnapshot,
  worldStreamUrl,
  parseWorldStreamChunk,
  seriesList,
  tigerUnderlying,
  pickMarket,
  pickBtcMarket,
  createWorldFeed,
};
