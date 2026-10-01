const { parseDecimalToScaled, asMicro } = require('./money');

const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
};

const ALLOWED_HOSTS = new Set(['api.coingecko.com', 'pro-api.coingecko.com']);

const BASES = {
  BTC: 100,
  ETH: 50,
  SOL: 10,
  BNB: 20,
  XRP: 1,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(text) {
  let hash = 2166136261;
  const src = String(text);
  for (let i = 0; i < src.length; i += 1) {
    hash ^= src.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function microFromNumber(value) {
  const scaled = parseDecimalToScaled(value.toFixed(6), 6);
  return scaled == null ? 0n : scaled;
}

function buildSyntheticBars(symbol, seed, days) {
  const rng = mulberry32(hashSeed(symbol + ':' + seed));
  const base = BASES[symbol] || 10;
  let close = microFromNumber(base);
  const end = Date.UTC(2026, 0, 1);
  const bars = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const ts = new Date(end - i * 86400000).toISOString();
    const open = close;
    const shock = (rng() - 0.48) * 0.04;
    const nextFloat = Number(open) * (1 + shock);
    let next = microFromNumber((nextFloat / 1e6));
    if (next < 1000n) next = 1000n;
    const top = open > next ? open : next;
    const bottom = open < next ? open : next;
    const high = top + top * BigInt(Math.floor(rng() * 80)) / 10000n;
    const lowRaw = bottom - bottom * BigInt(Math.floor(rng() * 80)) / 10000n;
    const low = lowRaw > 1n ? lowRaw : 1n;
    close = next;
    bars.push({
      ts,
      openMicro: open,
      highMicro: high < close ? close : high,
      lowMicro: low > close ? close : low,
      closeMicro: close,
      volume: 0,
    });
  }
  return bars;
}

function sliceBars(bars, from, to) {
  const start = from ? Date.parse(from) : -Infinity;
  const end = to ? Date.parse(to) : Infinity;
  return bars.filter((bar) => {
    const ts = Date.parse(bar.ts);
    return ts >= start && ts <= end;
  });
}

function createSyntheticFeed(options = {}) {
  const seed = options.seed == null ? 20261001 : options.seed;
  const days = options.days || 800;
  const cache = new Map();
  function barsFor(symbol) {
    if (!cache.has(symbol)) cache.set(symbol, buildSyntheticBars(symbol, seed, days));
    return cache.get(symbol);
  }
  return {
    id: 'synthetic',
    attribution: 'Fictional synthetic prices. Not market data.',
    attributionSecondary: 'No exchange is connected. These prices are made up for the demo engine.',
    attributionUrl: null,
    fictional: true,
    async getLatest(symbols) {
      return symbols.map((symbol) => {
        const bars = barsFor(symbol);
        const last = bars[bars.length - 1];
        return {
          symbol,
          priceMicro: last.closeMicro,
          ts: new Date().toISOString(),
          source: 'synthetic',
        };
      });
    },
    async getBars(symbol, interval, from, to) {
      if (interval && interval !== '1d' && interval !== '1h') return [];
      return sliceBars(barsFor(symbol), from, to);
    },
  };
}

function usdToMicro(usd) {
  if (typeof usd === 'number') return parseDecimalToScaled(usd.toFixed(6), 6);
  return parseDecimalToScaled(String(usd), 6);
}

function createCoinGeckoFeed(options) {
  const apiKey = options && options.apiKey;
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('COINGECKO_API_KEY is required for the CoinGecko feed. There is no built-in key.');
  }
  const plan = options.plan === 'pro' ? 'pro' : 'demo';
  const base = plan === 'pro' ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
  const header = plan === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const cache = options.cache;
  const latestTtl = Math.min(options.latestTtlMs || 60 * 1000, 24 * 60 * 60 * 1000);
  const historyTtl = 24 * 60 * 60 * 1000;

  async function call(url) {
    const parsed = new URL(url);
    if (!ALLOWED_HOSTS.has(parsed.host)) {
      throw new Error('The price feed refused a host outside the configured market-data provider.');
    }
    if (parsed.href.includes(apiKey)) {
      throw new Error('The API key must not be placed in the URL.');
    }
    const response = await fetchImpl(url, { headers: { accept: 'application/json', [header]: apiKey } });
    if (!response.ok) {
      throw new Error('Market data request failed (' + response.status + ').');
    }
    return response.json();
  }

  return {
    id: 'coingecko',
    attribution: 'Powered by CoinGecko',
    attributionSecondary: 'Data provided by CoinGecko',
    attributionUrl: 'https://www.coingecko.com/en/api',
    fictional: false,
    async getLatest(symbols) {
      const ids = symbols.map((symbol) => {
        const id = COINGECKO_IDS[symbol];
        if (!id) throw new Error('Unsupported symbol ' + symbol);
        return id;
      });
      const cacheId = 'latest:' + ids.slice().sort().join(',');
      if (cache) {
        const hit = cache.get(cacheId);
        if (hit) return hit;
      }
      const body = await call(base + '/simple/price?vs_currencies=usd&ids=' + ids.join(','));
      const now = new Date().toISOString();
      const quotes = symbols.map((symbol) => {
        const row = body[COINGECKO_IDS[symbol]];
        const priceMicro = row && row.usd != null ? usdToMicro(row.usd) : null;
        if (priceMicro == null) throw new Error('Missing CoinGecko price for ' + symbol);
        return { symbol, priceMicro, ts: now, source: 'coingecko' };
      });
      if (cache) cache.set(cacheId, quotes, latestTtl);
      return quotes;
    },
    async getBars(symbol, interval, from, to) {
      const id = COINGECKO_IDS[symbol];
      if (!id) throw new Error('Unsupported symbol ' + symbol);
      const start = from ? Date.parse(from) : Date.now() - 365 * 86400000;
      const end = to ? Date.parse(to) : Date.now();
      const days = Math.max(2, Math.ceil((end - start) / 86400000) + 1);
      const cacheId = 'bars:' + id + ':' + interval + ':' + days;
      let payload = cache ? cache.get(cacheId) : null;
      if (!payload) {
        const path = interval === '1h'
          ? '/coins/' + id + '/market_chart?vs_currency=usd&days=' + Math.min(days, 90)
          : '/coins/' + id + '/market_chart?vs_currency=usd&days=' + days + '&interval=daily';
        payload = await call(base + path);
        if (cache) cache.set(cacheId, payload, historyTtl);
      }
      const prices = Array.isArray(payload.prices) ? payload.prices : [];
      const bars = [];
      let prev = null;
      for (const point of prices) {
        const close = usdToMicro(point[1]);
        if (close == null) continue;
        const open = prev == null ? close : prev;
        const ts = new Date(point[0]).toISOString();
        if (Date.parse(ts) < start || Date.parse(ts) > end) {
          prev = close;
          continue;
        }
        bars.push({
          ts,
          openMicro: open,
          highMicro: open > close ? open : close,
          lowMicro: open < close ? open : close,
          closeMicro: close,
          volume: 0,
        });
        prev = close;
      }
      return bars;
    },
  };
}

function createDefaultFeed(env, cache) {
  const source = env || process.env;
  if (source.COINGECKO_API_KEY) {
    return createCoinGeckoFeed({
      apiKey: source.COINGECKO_API_KEY,
      plan: source.COINGECKO_API_PLAN,
      cache,
    });
  }
  return createSyntheticFeed({ seed: 20261001 });
}

function quoteFromBar(symbol, bar, source) {
  return {
    symbol,
    priceMicro: asMicro(bar.closeMicro),
    ts: bar.ts,
    source: source || 'synthetic',
  };
}

module.exports = {
  COINGECKO_IDS,
  ALLOWED_HOSTS,
  createSyntheticFeed,
  createCoinGeckoFeed,
  createDefaultFeed,
  quoteFromBar,
  usdToMicro,
};
