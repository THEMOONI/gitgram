// Pure bar functions. They do not place orders and do not read the network.
// Prices may be in any consistent unit. Missing volume skips the volume filter.

interface Bar {
  ts?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface Signal {
  action: 'enter' | 'exit' | 'hold';
  symbol: string | null;
  strength: number;
  stopPct: number;
  note: string;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function mean(values: number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return values.length ? sum / values.length : 0;
}

function sma(closes: number[], n: number): number | null {
  if (closes.length < n || n < 1) return null;
  return mean(closes.slice(-n));
}

function trueRanges(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (i === 0) {
      out.push(bar.high - bar.low);
      continue;
    }
    const prev = bars[i - 1].close;
    out.push(Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev)));
  }
  return out;
}

function atr(bars: Bar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  return mean(trueRanges(bars).slice(-period));
}

function volumeOk(bars: Bar[], period: number): boolean {
  const last = bars[bars.length - 1];
  const volumes = bars.slice(-period).map((bar) => bar.volume || 0);
  if (volumes.every((value) => value === 0)) return true;
  const avg = mean(volumes.slice(0, -1));
  return (last.volume || 0) > avg;
}

function hold(symbol: string | null, note: string): Signal {
  return { action: 'hold', symbol, strength: 0, stopPct: 8, note };
}

function breakoutSignal(bars: Bar[], params: Record<string, number> = {}, symbol: string | null = null): Signal {
  const channel = params.channel || 20;
  const atrPeriod = params.atrPeriod || 14;
  const atrMultiple = params.atrMultiple == null ? 0.8 : params.atrMultiple;
  const volumePeriod = params.volumePeriod || 20;
  const stopPct = params.stopPct || 8;
  if (!bars || bars.length < channel + 1) return hold(symbol, 'För få staplar för utbrott.');
  const last = bars[bars.length - 1];
  const prior = bars.slice(-(channel + 1), -1);
  let priorHigh = -Infinity;
  let priorLow = Infinity;
  for (const bar of prior) {
    const high = bar.high == null ? bar.close : bar.high;
    const low = bar.low == null ? bar.close : bar.low;
    if (high > priorHigh) priorHigh = high;
    if (low < priorLow) priorLow = low;
  }
  const close = last.close;
  const high = last.high == null ? close : last.high;
  const low = last.low == null ? close : last.low;
  const range = high - low;
  const atrValue = atr(bars, atrPeriod);
  const volatile = atrValue == null || atrValue <= 0 || range >= atrValue * atrMultiple;
  const volOk = volumeOk(bars, Math.min(volumePeriod, bars.length));
  if (close > priorHigh && volatile && volOk) {
    const span = priorHigh === 0 ? 0 : (close - priorHigh) / Math.abs(priorHigh);
    return {
      action: 'enter',
      symbol,
      strength: clamp01(0.45 + span * 8),
      stopPct,
      note: 'Stängningen lämnade kanalens övre kant.',
    };
  }
  if (close < priorLow) {
    return { action: 'exit', symbol, strength: 0.7, stopPct, note: 'Stängningen lämnade kanalens nedre kant.' };
  }
  return hold(symbol, 'Ingen kanalkorsning.');
}

function trendSignal(bars: Bar[], params: Record<string, number> = {}, symbol: string | null = null): Signal {
  const shortN = params.short || 8;
  const longN = params.long || 21;
  const stopPct = params.stopPct || 10;
  if (!bars || bars.length < longN + 1) return hold(symbol, 'För få staplar för trend.');
  const closes = bars.map((bar) => bar.close);
  const prev = closes.slice(0, -1);
  const shortPrev = sma(prev, shortN);
  const longPrev = sma(prev, longN);
  const shortNow = sma(closes, shortN);
  const longNow = sma(closes, longN);
  if (shortPrev == null || longPrev == null || shortNow == null || longNow == null) {
    return hold(symbol, 'Medelvärden saknas.');
  }
  const close = closes[closes.length - 1];
  if (shortPrev <= longPrev && shortNow > longNow && close > longNow) {
    const gap = longNow === 0 ? 0 : (shortNow - longNow) / Math.abs(longNow);
    return {
      action: 'enter',
      symbol,
      strength: clamp01(0.5 + gap * 10),
      stopPct,
      note: 'Kort medelvärde korsade över långt medelvärde.',
    };
  }
  if (shortPrev >= longPrev && shortNow < longNow) {
    return { action: 'exit', symbol, strength: 0.66, stopPct, note: 'Kort medelvärde korsade under långt medelvärde.' };
  }
  return hold(symbol, 'Ingen medelvärdeskorsning.');
}

function rateOfChange(bars: Bar[], period: number): number | null {
  if (!bars || bars.length < period + 1) return null;
  const prev = bars[bars.length - 1 - period].close;
  if (!prev) return null;
  return bars[bars.length - 1].close / prev - 1;
}

function momentumRank(series: Record<string, Bar[]>, params: Record<string, number> = {}): Array<{ symbol: string; roc: number }> {
  const period = params.rocPeriod || 12;
  const rows: Array<{ symbol: string; roc: number }> = [];
  for (const symbol of Object.keys(series)) {
    const roc = rateOfChange(series[symbol] || [], period);
    if (roc == null) continue;
    rows.push({ symbol, roc });
  }
  rows.sort((a, b) => b.roc - a.roc || a.symbol.localeCompare(b.symbol));
  return rows;
}

function momentumSignal(series: Record<string, Bar[]>, params: Record<string, number> = {}, held: string | null = null): Signal {
  const stopPct = params.stopPct || 5;
  const minRoc = params.minRoc == null ? 0 : params.minRoc;
  const ranked = momentumRank(series, params);
  if (!ranked.length) return hold(held, 'För få staplar för styrkerankning.');
  const best = ranked[0];
  if (held && held !== best.symbol) {
    return {
      action: 'exit',
      symbol: held,
      strength: 0.6,
      stopPct,
      note: 'En annan symbol leder styrkerankningen.',
    };
  }
  if (!held && best.roc > minRoc) {
    return {
      action: 'enter',
      symbol: best.symbol,
      strength: clamp01(0.4 + best.roc * 4),
      stopPct,
      note: 'Symbolen leder styrkerankningen.',
    };
  }
  return hold(best.symbol, 'Ingen ny ledare att öppna.');
}

function selectSignal(
  strategy: string,
  series: Record<string, Bar[]>,
  params: Record<string, number>,
  held: string[],
): Signal {
  if (strategy === 'momentum') {
    return momentumSignal(series, params, held[0] || null);
  }
  const fn = strategy === 'trend' ? trendSignal : breakoutSignal;
  let bestEnter: Signal | null = null;
  for (const symbol of Object.keys(series)) {
    const signal = fn(series[symbol] || [], params, symbol);
    if (signal.action === 'exit' && held.includes(symbol)) return signal;
    if (signal.action === 'enter' && !held.includes(symbol)) {
      if (!bestEnter || signal.strength > bestEnter.strength) bestEnter = signal;
    }
  }
  if (bestEnter) return bestEnter;
  return hold(held[0] || null, 'Ingen ny signal.');
}

module.exports = {
  breakoutSignal,
  trendSignal,
  momentumSignal,
  momentumRank,
  rateOfChange,
  selectSignal,
  sma,
  atr,
};
