// Local sentence parser for Swedish and English. No network.

const { clampLimits } = require('./guard.ts') as {
  clampLimits: (input: any) => { limits: any; notes: string[] };
};

const ALIAS: Record<string, string> = {
  bitcoin: 'BTC',
  btc: 'BTC',
  ethereum: 'ETH',
  eth: 'ETH',
  solana: 'SOL',
  sol: 'SOL',
  bnb: 'BNB',
  ripple: 'XRP',
  xrp: 'XRP',
};

const ALLOWED = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'];

interface TigerConfig {
  name: string;
  tagline: string;
  strategy: 'breakout' | 'trend' | 'momentum';
  symbols: string[];
  maxPositionPct: number;
  stopPct: number;
  dailyLossPct: number;
  maxTradesPerDay: number;
  cooldownSec: number;
  maxLeverage: number;
  feeBudgetPct: number;
  params: Record<string, number>;
  rulesText: string;
}

function tagline(strategy: string): string {
  if (strategy === 'breakout') return 'Utbrott när stängningen lämnar kanalen';
  if (strategy === 'trend') return 'Följer trenden med glidande medelvärden';
  return 'Rangordnar styrkan i rörelsen';
}

function displayTagline(text: string, strategy: string): string {
  const t = text.toLowerCase();
  if (/otålig|impatient/.test(t)) return 'den otåliga';
  if (/tålmodig|lugn|patient/.test(t)) return 'den tålmodiga';
  if (/\bsnabb\b|quick\b/.test(t)) return 'den snabba';
  return tagline(strategy);
}

function rulesFor(strategy: string, symbols: string[], stopPct: number, trades: number): string {
  const coins = symbols.join(', ');
  const how = strategy === 'breakout'
    ? 'Gå lång när priset stänger över kanalen.'
    : strategy === 'trend'
      ? 'Gå in först när trenden är tydlig. Stå utanför när den vänder.'
      : 'Följ momentum och kliv av när farten dör.';
  return 'Handla bara ' + coins + '. ' + how + ' Stopp ' + stopPct + ' %. Max ' + trades + ' trades per dag.';
}

function defaultsFor(strategy: string): Record<string, number> {
  if (strategy === 'breakout') return { maxTradesPerDay: 2, cooldownSec: 3600, stopPct: 8, maxPositionPct: 10 };
  if (strategy === 'trend') return { maxTradesPerDay: 2, cooldownSec: 7200, stopPct: 10, maxPositionPct: 12 };
  return { maxTradesPerDay: 3, cooldownSec: 1800, stopPct: 5, maxPositionPct: 10 };
}

function detectStrategy(text: string): 'breakout' | 'trend' | 'momentum' | null {
  const t = text.toLowerCase();
  if (/breakout|utbrott|bryter ut|break out|donchian|kanalbrott/.test(t)) return 'breakout';
  if (/momentum|styrkerank|rate of change|relativ styrka|\broc\b/.test(t)) return 'momentum';
  if (/trend|glidande|moving average|trendfölj|trendfolj/.test(t)) return 'trend';
  return null;
}

function detectSymbols(text: string): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (const [alias, symbol] of Object.entries(ALIAS)) {
    const re = new RegExp('(^|[^a-z])' + alias + '([^a-z]|$)', 'i');
    if (re.test(lower) && !found.includes(symbol)) found.push(symbol);
  }
  return found.filter((symbol) => ALLOWED.includes(symbol));
}

function detectPct(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = Number(String(match[1]).replace(',', '.'));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function parseTigerSentence(text: string, options?: { slot?: number | null; name?: string | null }): {
  ok: boolean;
  errors: string[];
  notes: string[];
  config: TigerConfig | null;
} {
  const sentence = String(text || '').trim();
  const errors: string[] = [];
  if (sentence.length < 8) errors.push('Skriv en hel mening om hur tigern ska handla.');
  const strategy = detectStrategy(sentence);
  if (!strategy) errors.push('Meningen behöver säga breakout, trend eller momentum.');
  const symbols = detectSymbols(sentence);
  if (!symbols.length) errors.push('Nämn minst en av BTC, ETH, SOL, BNB eller XRP.');
  if (!strategy || errors.length) {
    return { ok: false, errors, notes: [], config: null };
  }
  const preset = defaultsFor(strategy);
  const position = detectPct(sentence, [
    /max(?:imum)?\s+(\d+(?:[.,]\d+)?)\s*%?\s*(?:per position|perposition|position)/i,
    /(\d+(?:[.,]\d+)?)\s*(?:%|procent)\s*per position/i,
  ]);
  const stop = detectPct(sentence, [
    /stopp(?:loss)?(?:\s+på)?\s+(\d+(?:[.,]\d+)?)\s*%?/i,
    /stop(?:\s+loss)?(?:\s+of|\s+at|\s+på)?\s+(\d+(?:[.,]\d+)?)\s*%?/i,
  ]);
  const leverage = detectPct(sentence, [
    /(\d+(?:[.,]\d+)?)\s*x\b/i,
    /h[aä]vst[aå]ng\s+(\d+(?:[.,]\d+)?)/i,
    /leverage\s+(\d+(?:[.,]\d+)?)/i,
  ]);
  const daily = detectPct(sentence, [
    /dagsf[oö]rlust\s+(\d+(?:[.,]\d+)?)/i,
    /daily loss\s+(\d+(?:[.,]\d+)?)/i,
  ]);
  const trades = detectPct(sentence, [
    /max(?:imum)?\s+(\d+(?:[.,]\d+)?)\s+trades/i,
    /(\d+(?:[.,]\d+)?)\s+trades per dag/i,
  ]);
  const clamped = clampLimits({
    maxLeverage: leverage == null ? 1 : leverage,
    maxStopPct: stop == null ? preset.stopPct : stop,
    maxPositionPct: position == null ? preset.maxPositionPct : position,
    maxTradesPerDay: trades == null ? preset.maxTradesPerDay : trades,
    cooldownSec: preset.cooldownSec,
    dailyLossPct: daily == null ? 5 : daily,
    feeBudgetPct: 5,
    symbols,
  });
  const slot = options && options.slot;
  const name = (options && options.name) || (slot ? 'TIFI ' + slot : 'Tiger');
  const config: TigerConfig = {
    name,
    tagline: displayTagline(sentence, strategy),
    strategy,
    symbols: clamped.limits.symbols,
    maxPositionPct: clamped.limits.maxPositionPct,
    stopPct: clamped.limits.maxStopPct,
    dailyLossPct: clamped.limits.dailyLossPct,
    maxTradesPerDay: clamped.limits.maxTradesPerDay,
    cooldownSec: clamped.limits.cooldownSec,
    maxLeverage: clamped.limits.maxLeverage,
    feeBudgetPct: clamped.limits.feeBudgetPct,
    params: { stopPct: clamped.limits.maxStopPct },
    rulesText: rulesFor(strategy, clamped.limits.symbols, clamped.limits.maxStopPct, clamped.limits.maxTradesPerDay),
  };
  return { ok: true, errors: [], notes: clamped.notes, config };
}

module.exports = {
  ALLOWED,
  parseTigerSentence,
  tagline,
  displayTagline,
};
