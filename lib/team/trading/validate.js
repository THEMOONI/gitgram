const { safeHttpUrl } = require('../urls');

const LABELS = new Set(['LÅG', 'MEDEL', 'HÖG', 'EXTREM']);
const STAGES = new Set(['snabb', 'uppföljning']);
const SOURCES = new Set([
  'pumpportal-ny',
  'pumpportal-migrering',
  'dexscreener-profil',
  'dexscreener-boost',
]);
const KEYS = [
  'id',
  'ts',
  'mint',
  'symbol',
  'name',
  'label',
  'score',
  'stage',
  'source',
  'summary',
  'liquidity_usd',
  'top_reasons',
  'link',
  'disclaimer',
];
const KEY_SET = new Set(KEYS);
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (!cleaned || cleaned.length > max) return '';
  return cleaned;
}

function optionalName(value, max) {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (cleaned.length > max) return { ok: false };
  return { ok: true, value: cleaned || null };
}

function safeDexScreenerUrl(value, mint) {
  const href = safeHttpUrl(value);
  if (!href || !mint) return '';
  let url;
  try {
    url = new URL(href);
  } catch {
    return '';
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'dexscreener.com' && host !== 'www.dexscreener.com') return '';
  if (url.username || url.password) return '';
  if (url.search || url.hash) return '';
  if (url.pathname !== `/solana/${mint}`) return '';
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function validateTradingAlert(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid' };
  const keys = Object.keys(body);
  if (keys.length !== KEYS.length || keys.some((key) => !KEY_SET.has(key))) {
    return { ok: false, error: 'invalid' };
  }
  if (typeof body.mint !== 'string' || !MINT.test(body.mint)) return { ok: false, error: 'invalid' };
  if (!STAGES.has(body.stage) || !SOURCES.has(body.source)) return { ok: false, error: 'invalid' };
  if (!LABELS.has(body.label)) return { ok: false, error: 'label' };
  if (!Number.isInteger(body.score) || body.score < 0 || body.score > 100) return { ok: false, error: 'invalid' };
  if (typeof body.ts !== 'string' || !TS.test(body.ts)) return { ok: false, error: 'invalid' };
  const tsMs = Date.parse(body.ts);
  if (!Number.isFinite(tsMs)) return { ok: false, error: 'invalid' };
  if (body.id !== `${body.mint}:${body.stage}:${tsMs}`) return { ok: false, error: 'invalid' };
  const symbol = optionalName(body.symbol, 32);
  const name = optionalName(body.name, 64);
  if (!symbol.ok || !name.ok) return { ok: false, error: 'invalid' };
  const summary = cleanText(body.summary, 600);
  if (!summary) return { ok: false, error: 'invalid' };
  if (!Array.isArray(body.top_reasons) || body.top_reasons.length > 3) return { ok: false, error: 'invalid' };
  const reasons = [];
  for (const reason of body.top_reasons) {
    const cleaned = cleanText(reason, 180);
    if (!cleaned) return { ok: false, error: 'invalid' };
    reasons.push(cleaned);
  }
  if (body.liquidity_usd != null) {
    if (typeof body.liquidity_usd !== 'number' || !Number.isFinite(body.liquidity_usd) || body.liquidity_usd < 0) {
      return { ok: false, error: 'invalid' };
    }
  }
  if (typeof body.disclaimer !== 'string' || !body.disclaimer.trim() || body.disclaimer.length > 800) {
    return { ok: false, error: 'invalid' };
  }
  const link = safeDexScreenerUrl(body.link, body.mint);
  if (!link) return { ok: false, error: 'link' };
  return {
    ok: true,
    value: {
      id: body.id,
      ts: body.ts,
      tsMs,
      mint: body.mint,
      symbol: symbol.value,
      name: name.value,
      label: body.label,
      score: body.score,
      stage: body.stage,
      source: body.source,
      summary,
      liquidityUsd: body.liquidity_usd == null ? null : body.liquidity_usd,
      reasons,
      link,
    },
  };
}

module.exports = {
  validateTradingAlert,
  safeDexScreenerUrl,
  LABELS,
  STAGES,
  SOURCES,
};
